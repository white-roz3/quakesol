// QuakeSol payout worker — builds a payout plan for a finished round.
//
//   node payout.js --round 92 --pool 1.5
//
// Reads the round's final standings from the API, takes the top finishers
// that supplied a wallet, splits the prize pool between them, and writes:
//
//   payouts/round-92.json   — the plan (audit record)
//   payouts/round-92.sh     — `solana transfer` commands for review
//
// This script NEVER touches private keys and NEVER sends funds. You review
// the .sh file and run it yourself with your own funded Solana CLI wallet.
//
// Options:
//   --round N        required — a FINISHED round number
//   --pool X         SOL to distribute (omit for a dry run showing shares)
//   --api URL        default http://localhost:4000
//   --top N          default 3 — how many wallet-holding finishers get paid
//   --split a,b,c    default 50,30,20 — percentage split, must have N entries
//   --min-score S    default 1 — ignore runs below this score

import { mkdirSync, writeFileSync } from "node:fs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};

const round = Number(arg("round"));
const pool = arg("pool") == null ? null : Number(arg("pool"));
const api = (arg("api", "http://localhost:4000")).replace(/\/$/, "");
const top = Number(arg("top", 3));
const split = String(arg("split", "50,30,20")).split(",").map(Number);
const minScore = Number(arg("min-score", 1));

if (!Number.isInteger(round) || round < 1) { console.error("--round N (finished round) is required"); process.exit(1); }
if (split.length !== top) { console.error(`--split has ${split.length} entries but --top is ${top}`); process.exit(1); }
if (Math.abs(split.reduce((a, b) => a + b, 0) - 100) > 0.001) { console.error("--split must sum to 100"); process.exit(1); }
if (pool !== null && (!Number.isFinite(pool) || pool <= 0)) { console.error("--pool must be a positive number of SOL"); process.exit(1); }

const res = await fetch(`${api}/api/round/${round}/results`);
if (!res.ok) {
  console.error(`API ${res.status}: ${(await res.json().catch(() => ({}))).error || "error"} — is round ${round} finished?`);
  process.exit(1);
}
const { standings, endedAt } = await res.json();

const eligible = standings.filter((s) => s.wallet && s.score >= minScore);
const skippedNoWallet = standings.filter((s) => !s.wallet && s.score >= minScore).length;
const winners = eligible.slice(0, top).map((s, i) => ({
  rank: i + 1,
  name: s.name,
  wallet: s.wallet,
  score: s.score,
  sharePct: split[i],
  amountSol: pool !== null ? Math.floor(pool * split[i] / 100 * 1e9) / 1e9 : null,
}));

const plan = {
  round,
  roundEndedAt: new Date(endedAt).toISOString(),
  generatedAt: new Date().toISOString(),
  poolSol: pool,
  minScore,
  eligibleWithWallet: eligible.length,
  skippedNoWallet,
  winners,
};

console.log(`Round ${round} — ${standings.length} finishers, ${eligible.length} eligible with wallet` +
  (skippedNoWallet ? ` (${skippedNoWallet} scored but gave no wallet)` : ""));
if (!winners.length) { console.log("No eligible winners — nothing to pay."); process.exit(0); }
for (const w of winners) {
  console.log(`  #${w.rank}  ${w.name.padEnd(24)} ${w.score} frags  ${w.sharePct}%` +
    (w.amountSol !== null ? `  → ${w.amountSol} SOL  ${w.wallet}` : `  ${w.wallet}`));
}

mkdirSync(new URL("./payouts/", import.meta.url), { recursive: true });
const jsonPath = new URL(`./payouts/round-${round}.json`, import.meta.url).pathname;
writeFileSync(jsonPath, JSON.stringify(plan, null, 2));
console.log(`\nPlan written to ${jsonPath}`);

if (pool !== null) {
  const sh = [
    "#!/bin/sh",
    `# QuakeSol payouts for round ${round} — REVIEW BEFORE RUNNING.`,
    `# Runs against whatever wallet your solana CLI is configured with (solana config get).`,
    "set -e",
    ...winners.map((w) => `solana transfer ${w.wallet} ${w.amountSol} --allow-unfunded-recipient  # #${w.rank} ${w.name}, ${w.score} frags`),
    "",
  ].join("\n");
  const shPath = new URL(`./payouts/round-${round}.sh`, import.meta.url).pathname;
  writeFileSync(shPath, sh, { mode: 0o755 });
  console.log(`Transfer script written to ${shPath} — review it, then run it with your own funded solana CLI.`);
} else {
  console.log("Dry run (no --pool) — no transfer script written.");
}
