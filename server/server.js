// QuakeSol backend — rounds, run ingestion, leaderboard, live player count.
// Zero dependencies: node:http + node:sqlite (Node >= 22.5).
//
//   node server.js
//
// Env:
//   PORT           default 4000
//   ROUND_MINUTES  default 60 — length of a scoring round
//   GENESIS        default 2026-08-01T00:00:00Z — round 1 starts here
//   DB_PATH        default ./data.db
//   CORS_ORIGIN    default * — set to your site origin in production

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT || 4000);
const ROUND_MS = Number(process.env.ROUND_MINUTES || 60) * 60_000;
const GENESIS = Date.parse(process.env.GENESIS || "2026-08-01T00:00:00Z");
const DB_PATH = process.env.DB_PATH || new URL("./data.db", import.meta.url).pathname;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
// When set, also serve the site (lobby + game + assets) from this directory —
// lets a single service host everything. Point it at the repo root so paths
// match local dev: /web/... and /ioq3/build/Release/...
const STATIC_DIR = process.env.STATIC_DIR || "";
// When set, requests for game pk3s that are not on disk are 302-redirected to
// `${PK3_REDIRECT}/<filename>` — lets the deploy bundle stay small while the
// pk3s are served from a public CDN (e.g. raw.githubusercontent.com, which
// sends CORS headers). Leave empty when the pk3s ship with the bundle.
const PK3_REDIRECT = (process.env.PK3_REDIRECT || "").replace(/\/$/, "");

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round INTEGER NOT NULL,
    identity TEXT NOT NULL,
    name TEXT NOT NULL,
    wallet TEXT,
    score INTEGER NOT NULL,
    deaths INTEGER NOT NULL,
    map TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    ip TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_runs_round ON runs(round);

  -- campaign: one row per arena an identity has beaten. Progression is derived
  -- from these rather than stored, so it can't drift out of sync.
  CREATE TABLE IF NOT EXISTS clears (
    identity TEXT NOT NULL,
    map TEXT NOT NULL,
    tier INTEGER NOT NULL,
    name TEXT NOT NULL,
    wallet TEXT,
    round INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (identity, map)
  );
  CREATE INDEX IF NOT EXISTS idx_clears_identity ON clears(identity);
`);

// The campaign ladder is defined once in web/assets/campaign.json (generated
// from OpenArena's scripts/arenas.txt) and read here so the client and server
// can never disagree about tier sizes.
const LADDER = JSON.parse(readFileSync(new URL("../web/assets/campaign.json", import.meta.url), "utf8"));
const TIER_SIZES = LADDER.reduce((acc, t) => (acc[t.tier] = t.arenas.length, acc), {});
const TIER_OF_MAP = new Map(LADDER.flatMap(t => t.arenas.map(a => [a.map, t.tier])));
const MAX_TIER = Math.max(...LADDER.map(t => t.tier));

const insertRun = db.prepare(`
  INSERT INTO runs (round, identity, name, wallet, score, deaths, map, duration_ms, ip, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertClear = db.prepare(`
  INSERT OR IGNORE INTO clears (identity, map, tier, name, wallet, round, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const clearsFor = db.prepare(`SELECT map, tier FROM clears WHERE identity = ?`);

// unlocked tier = 1 + every consecutive tier the player has fully cleared
function unlockedTier(rows) {
  const per = {};
  for (const r of rows) per[r.tier] = (per[r.tier] || 0) + 1;
  let tier = 1;
  while (tier <= MAX_TIER && TIER_SIZES[tier] && per[tier] >= TIER_SIZES[tier]) tier++;
  return Math.min(tier, MAX_TIER);
}

// Round board: deepest tier cleared this round wins, frags break the tie.
const bestPerIdentity = db.prepare(`
  SELECT r.name, r.wallet,
         MAX(r.score) AS score,
         MIN(r.deaths) AS deaths,
         COUNT(*) AS runs,
         COALESCE((SELECT MAX(c.tier) FROM clears c
                   WHERE c.identity = r.identity AND c.round = ?), 0) AS tier
  FROM runs r WHERE r.round = ?
  GROUP BY r.identity
  ORDER BY tier DESC, score DESC, deaths ASC, MIN(r.created_at) ASC
  LIMIT 50
`);

const currentRound = (now = Date.now()) => Math.max(1, Math.floor((now - GENESIS) / ROUND_MS) + 1);
const roundEndsAt = (n) => GENESIS + n * ROUND_MS;

// live player presence: name -> last ping ts (in-memory)
const pings = new Map();
const playingCount = () => {
  const cutoff = Date.now() - 90_000;
  let n = 0;
  for (const [name, ts] of pings) { if (ts >= cutoff) n++; else pings.delete(name); }
  return n;
};

// naive per-IP rate limit: 60 requests / minute
const hits = new Map();
const limited = (ip) => {
  const now = Date.now();
  const w = hits.get(ip) || [];
  const fresh = w.filter((t) => now - t < 60_000);
  fresh.push(now);
  hits.set(ip, fresh);
  return fresh.length > 60;
};

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const json = (res, code, body) => {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".webm": "audio/webm",
};
// Only these path prefixes are ever served — the STATIC_DIR may be the repo
// root, which also holds the database and server code.
const STATIC_ALLOW = ["/web/", "/ioq3/build/Release/"];
const serveStatic = (res, urlPath, headOnly) => {
  let p = normalize(decodeURIComponent(urlPath)).replace(/\\/g, "/");
  if (p.includes("..")) return false;
  if (p === "/" || p === "") p = "/web/index.html";
  if (p.endsWith("/")) p += "index.html";
  if (!STATIC_ALLOW.some((prefix) => p.startsWith(prefix))) return false;
  const file = join(STATIC_DIR, p);
  if (!file.startsWith(normalize(STATIC_DIR))) return false;
  if (!existsSync(file) || !statSync(file).isFile()) {
    // pk3s may live on an external CDN instead of the deploy bundle
    if (PK3_REDIRECT && /^\/ioq3\/build\/Release\/baseoa\/[a-zA-Z0-9._-]+\.pk3$/.test(p)) {
      res.writeHead(302, {
        Location: `${PK3_REDIRECT}/${p.split("/").pop()}`,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end();
      return true;
    }
    return false;
  }
  const ext = extname(file).toLowerCase();
  // big immutable game data gets long cache; html/js/config stays fresh
  const cache = [".pk3", ".wasm", ".data"].includes(ext) ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": statSync(file).size,
    "Cache-Control": cache,
  });
  if (headOnly) { res.end(); return true; }
  createReadStream(file).pipe(res);
  return true;
};

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on("data", (c) => { size += c.length; if (size > 10_240) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
  req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch { reject(new Error("bad json")); } });
  req.on("error", reject);
});

const server = createServer(async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";
  const url = new URL(req.url, "http://x");

  if (req.method === "OPTIONS") return json(res, 204, {});
  if (url.pathname.startsWith("/api/") && limited(ip)) return json(res, 429, { error: "rate limited" });

  try {
    // status / health
    if (req.method === "GET" && (url.pathname === "/api/health" || (url.pathname === "/" && !STATIC_DIR))) {
      return json(res, 200, { ok: true, service: "quakesol-api", round: currentRound(), playing: playingCount() });
    }

    if (req.method === "GET" && url.pathname === "/api/round") {
      const n = currentRound();
      return json(res, 200, { round: n, playing: playingCount(), endsAt: roundEndsAt(n), timeLeftMs: roundEndsAt(n) - Date.now() });
    }

    // permanent campaign progression for one identity
    if (req.method === "GET" && url.pathname === "/api/progress") {
      const wallet = url.searchParams.get("wallet") || "";
      const name = (url.searchParams.get("name") || "").trim();
      if (!wallet && !name) return json(res, 400, { error: "name or wallet required" });
      const identity = wallet && BASE58.test(wallet) ? wallet : `name:${name.toLowerCase()}`;
      const rows = clearsFor.all(identity);
      return json(res, 200, {
        identity, tier: unlockedTier(rows), maxTier: MAX_TIER,
        cleared: rows.map(r => r.map), clearedCount: rows.length,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/leaderboard") {
      const n = Number(url.searchParams.get("round")) || currentRound();
      return json(res, 200, bestPerIdentity.all(n, n));
    }

    // final standings for a finished round (payout input)
    if (req.method === "GET" && /^\/api\/round\/\d+\/results$/.test(url.pathname)) {
      const n = Number(url.pathname.split("/")[3]);
      if (n >= currentRound()) return json(res, 409, { error: "round not finished" });
      return json(res, 200, { round: n, endedAt: roundEndsAt(n), standings: bestPerIdentity.all(n, n) });
    }

    if (req.method === "POST" && url.pathname === "/api/ping") {
      const b = await readBody(req);
      const name = String(b.name || "").slice(0, 24).trim();
      if (name) pings.set(name, Date.now());
      return json(res, 200, { ok: true, playing: playingCount() });
    }

    if (req.method === "POST" && url.pathname === "/api/runs") {
      const b = await readBody(req);
      const name = String(b.name || "").trim().slice(0, 24);
      const wallet = b.wallet == null || b.wallet === "" ? null : String(b.wallet);
      const score = Number(b.score), deaths = Number(b.deaths);
      const map = String(b.map || "").slice(0, 32);
      const duration = Number(b.endedAt) - Number(b.startedAt);

      if (!name) return json(res, 400, { error: "name required" });
      if (wallet !== null && !BASE58.test(wallet)) return json(res, 400, { error: "bad wallet" });
      if (!Number.isInteger(score) || score < -50 || score > 500) return json(res, 400, { error: "bad score" });
      if (!Number.isInteger(deaths) || deaths < 0 || deaths > 500) return json(res, 400, { error: "bad deaths" });
      if (!map) return json(res, 400, { error: "map required" });
      if (!Number.isFinite(duration) || duration < 20_000 || duration > 3_600_000) return json(res, 400, { error: "bad duration" });

      const identity = wallet ?? `name:${name.toLowerCase()}`;
      const round = currentRound();
      insertRun.run(round, identity, name, wallet, score, deaths, map, Math.round(duration), ip, Date.now());

      // a won campaign arena unlocks progress permanently. The tier comes from
      // the ladder, never from the client, so a forged tier can't skip ahead.
      const tier = TIER_OF_MAP.get(map);
      let progress = null;
      if (b.won === true && tier) {
        insertClear.run(identity, map, tier, name, wallet, round, Date.now());
        const rows = clearsFor.all(identity);
        progress = { tier: unlockedTier(rows), cleared: rows.map(r => r.map), clearedCount: rows.length };
      }
      pings.set(name, Date.now());
      return json(res, 201, { ok: true, round, progress });
    }

    if ((req.method === "GET" || req.method === "HEAD") && STATIC_DIR && serveStatic(res, url.pathname, req.method === "HEAD")) return;

    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 400, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`quakesol-api on :${PORT} — round ${currentRound()} (${ROUND_MS / 60000}m rounds), db ${DB_PATH}`);
});
