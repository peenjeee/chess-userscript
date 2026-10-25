# Chess Analyzer (userscript)

One script, three features, three sites (**chess.com**, **lichess.org**, and **endgame.ai**):

1. **Analyzer** — draws the top 3 engine move suggestions (plus a dashed ponder
   arrow) directly on the board, with a live score badge.
2. **Full-strength engine** — Stockfish 18 with the full NNUE network (~113MB,
   downloaded once and cached by the browser), the same engine the
   [Chess Analyzer web app](https://chess.0xpnj.dev) uses. On lichess the
   script prefers the instant lichess cloud evaluation (depth 60+) and only
   falls back to the local engine for positions the cloud doesn't know.
3. **Relay** — mirrors the game you are playing to the web app's **Live** tab
   on any other device via a session ID.

## Installation

1. Install a userscript manager extension in your browser (e.g., Violentmonkey, Tampermonkey, or similar).
2. Open your userscript manager and select **Create a new script**.
3. Copy all the code from the `userscript.js` file in this repository.
4. Paste the code into the script editor and click **Save**.
5. Refresh your chess game page, and the analyzer is ready to use!

## Hotkeys

- **A** — Show or hide the move suggestions (starts/stops the analyzer).
- **Insert** — Hide or show the Analyze button. Useful for keeping the
  interface clean; the **'A'** hotkey still works while the button is hidden.
- **Ctrl+Shift+C** or **Ctrl+Shift+X** — Copy your Relay ID to the clipboard (a small toast
  confirms and shows the ID). There is no persistent relay UI.

## Engine

- On **chess.com** the script fetches the full Stockfish 18 NNUE build from
  chess.0xpnj.dev and runs it in a worker. First start shows
  *"Loading engine… (one-time ~113MB)"*; after that it starts instantly from
  the browser cache. If the download fails it falls back to chess.com's
  built-in engine.
- On **lichess** suggestions come from the lichess **cloud evaluation** API
  (instant, very deep, White/Black handled automatically). Positions the cloud
  doesn't know (most middlegames of live games) fall back to the **local
  engine**: the script downloads it through Tampermonkey's `GM_xmlhttpRequest`
  (declared in the header — approve the `chess.0xpnj.dev` permission if your
  userscript manager asks) and caches the 113MB in IndexedDB, so it downloads
  once ever, not once per page.
- **lichess variants** (King of the Hill, Three-Check, Antichess, Atomic,
  Horde, Racing Kings, Crazyhouse) run on Fairy-Stockfish 14 with the
  variant's NNUE network, the engine lichess's own analysis uses
  ([lichess-org/stockfish-web](https://github.com/lichess-org/stockfish-web),
  fetched from jsDelivr at a pinned version and checked against its
  SHA-256). Each network comes once from lichess's asset host (about 1MB for
  antichess and horde, 48-59MB for the others), is checked against the hash
  in its name and cached. Approve the `cdn.jsdelivr.net` and `lichess1.org`
  permissions if asked. Where threads are not available, or it fails, the
  script falls back to multi-variant Stockfish 10
  ([lichess-org/stockfish.js](https://github.com/lichess-org/stockfish.js),
  GPLv3, ~0.6MB).
  Crazyhouse pockets and three-check counters are read from the page; a
  suggested drop shows as a ringed square with the piece letter. Variant
  games are not relayed, since the web app analyzes standard chess only.
- **chess.com variants** (the 4 Player & Variants server): Crazyhouse,
  3 Check, King of the Hill, Atomic, Giveaway, Horde and Racing Kings run on
  multi-variant Stockfish 10, since chess.com pages cannot run the threaded
  Fairy-Stockfish. The extension version runs Fairy-Stockfish with the
  variant's NNUE network there too, from its own offscreen page, which a
  userscript cannot have. No Castling, and Setup Chess once both sides have
  set up, are standard chess for Stockfish 18. Torpedo, Sideways Pawns,
  Petrified, Paradigm Chess30, Seirawan Chess and Chaturanga need
  Fairy-Stockfish, so in the userscript they show "Variant needs the
  extension". Banked pieces, the side to move and the checks given are
  read from the board and its move list. Any other variant there (Fog of
  War, Duck Chess, Spell Chess, Blindfold, 4 Player, custom rules) shows
  "Variant not supported" instead of arrows.
- **Chess960** (all three sites): the engine runs in Chess960 mode, with
  castling rights taken from the game's start position (looked up once per
  game from the site's own game API). A suggested castle is drawn to the
  king's landing square, or as the rook's move when the king already stands
  there.
- **endgame.ai**: the script runs the same Stockfish 18 NNUE build as on
  chess.com (cached in IndexedDB) without site-engine fallback. In **Secret
  Queen** games, hidden queens (own square + revealed pieces from API/DOM badges)
  are analyzed as queens. Includes Secret Queen Threat Overlay (red dashed danger
  lines and target beacons from all living opponent pawns) and auto-detection toast
  alerts when opponent pawns or their Secret Queen are captured. Both appear only
  once endgame.ai's API confirms the game is Secret Queen.

## Live relay (watch from another device)

1. On the game page press **Ctrl+Shift+C** or **Ctrl+Shift+X** — your **Relay ID** is copied to
   the clipboard (a small toast shows it). The ID stays the same on this
   browser.
2. In the [Chess Analyzer web app](https://chess.0xpnj.dev): **Live** tab →
   **Session ID** → paste the ID → **Connect Session**.
3. Every move appears on the web app's board within ~2 seconds with engine
   suggestions; when the game ends, a full Game Review starts automatically.

### How it works / privacy

Positions are sent as small JSON messages through the public
[ntfy.sh](https://ntfy.sh) pub/sub relay under the topic `chessweb-<id>`.
Messages contain only the position (FEN) and the player usernames shown on the
page. Anyone who knows the random ID could read them, so treat the ID like a
private link.

**Relay on lichess:** lichess's page security policy blocks plain fetches, so
the script sends through Tampermonkey's `GM_xmlhttpRequest` (approve the
`ntfy.sh` permission if asked). The **extension version** works out of the box
(its isolated world is exempt). If neither channel is available the relay goes
quiet — you can always use the web app's **Live → lichess username** watch,
which needs no relay at all.

## Troubleshooting

- **Analyzer is stuck or arrows don't appear:** press **'A'** twice (off and
  on again). This resets the engine and resyncs it with the current board.
- **"Engine unavailable":** the engine failed to load or crashed more than
  three times in a row (it restarts by itself before that — usually an
  interrupted 113MB download). Press **'A'** twice to retry from scratch.
- **No arrows on some lichess positions (score shows "—"):** that position is
  not in the lichess cloud and the local engine could not be loaded — usually
  because the userscript manager denied the `chess.0xpnj.dev` permission.
  Grant it (or use the extension version) and the engine takes over for those
  positions.

## Extension version

The same script ships as a Chrome extension in the sibling
`chess-analyzer` folder (`scripts/main.js` is generated from `userscript.js`).
