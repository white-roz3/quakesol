// ============================================================
//  QuakeSol lobby configuration
//  Edit and redeploy without rebuilding the game.
// ============================================================

// Backend API base URL, NO trailing slash (e.g. "https://quake-api.onrender.com").
// Leave empty (""): on localhost this falls back to http://localhost:4000 (dev
// backend, run with `node server/server.js`); on any other host it means
// offline mode — runs are not submitted.
window.QUAKE_API = "";

// Token contract address. Leave "" to hide the CA chip.
window.QUAKE_CA = "";

// X / community link. Leave "" to hide.
window.QUAKE_X = "";

// Path to the built ioquake3 Emscripten shell, relative to this page.
window.QUAKE_ENGINE = "/ioq3/build/Release/ioquake3.html";

// When to start pulling the ~400MB of game data into the browser cache:
//   "load"     — as soon as the site opens (fastest to play, most bandwidth)
//   "identify" — once a nametag is entered, i.e. the player intends to play
//   "off"      — only when a match starts
// Skipped automatically on data-saver and 2G connections either way.
window.QUAKE_PRELOAD = "load";

// Match settings for a scored run.
window.QUAKE_MATCH = {
  basegame: "baseoa",
  // The Longest Yard — 24 spawn points, comfortably the most of any OA map,
  // so a 10-player free-for-all never runs out of places to respawn.
  map: "wrackdm17",
  timelimit: 5,        // minutes
  fraglimit: 50,
  // Total players in the arena including you. The engine keeps the count
  // topped up (bot_minplayers), so the match refills as bots are fragged.
  players: 10,
  botSkill: 3,         // 1 (easy) .. 5 (nightmare)
};
