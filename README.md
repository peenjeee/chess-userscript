# Chess Analyzer (userscript)

One script, three features, two sites (**chess.com** and **lichess.org**):

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
- **No arrows on some lichess positions (score shows "—"):** that position is
  not in the lichess cloud and the local engine could not be loaded — usually
  because the userscript manager denied the `chess.0xpnj.dev` permission.
  Grant it (or use the extension version) and the engine takes over for those
  positions.

## Extension version

The same script ships as a Chrome extension in the sibling
`chess-analyzer` folder (`scripts/main.js` is generated from `userscript.js`).
