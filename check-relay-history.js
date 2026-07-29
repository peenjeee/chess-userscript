const assert = require("node:assert/strict");
const fs = require("node:fs");

const sourcePath = fs.existsSync("scripts/main.js") ? "scripts/main.js" : "userscript.js";
const source = fs.readFileSync(sourcePath, "utf8");
const start = source.indexOf("    function keepFullRelayHistory");
const end = source.indexOf("\n    function publishRelayPosition", start);
const location = { pathname: "/game/one" };
const keepHistory = new Function("location", "isGameOver", `
    let relayMoveHistory = [];
    let relayGamePath = location.pathname;
    let relayEndSent = false;
    ${source.slice(start, end)}
    return keepFullRelayHistory;
`)(location, () => false);

assert.deepEqual(keepHistory(["e4", "e5"]), ["e4", "e5"]);
assert.deepEqual(keepHistory(["e4"]), ["e4", "e5"]);
assert.deepEqual(keepHistory([]), ["e4", "e5"]);
location.pathname = "/game/two";
assert.deepEqual(keepHistory([]), []);
