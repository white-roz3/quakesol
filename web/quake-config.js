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

// Match settings for a scored run.
window.QUAKE_MATCH = {
  basegame: "baseoa",
  map: "oa_dm1",
  timelimit: 5,        // minutes
  fraglimit: 30,
  // Valid names: see scripts/bots.txt inside the OA pk3s (Angelyss, Sarge,
  // Gargoyle, Kyonshi, Merman, Major, Grunt, Ayumi, Penguin, Skelebot, ...).
  // "random" is NOT supported by OpenArena's gamecode.
  bots: [
    { name: "Sarge", skill: 3 },
    { name: "Gargoyle", skill: 3 },
    { name: "Angelyss", skill: 4 },
  ],
};
