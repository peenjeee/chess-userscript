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

- **A** — Start or stop the analyzer.
- **Insert** — Hide or show the analyzer button and the relay badge. Useful for
  keeping the interface clean; the **'A'** hotkey still works while hidden.

## Engine

- On **chess.com** the script fetches the full Stockfish 18 NNUE build from
  chess.0xpnj.dev and runs it in a worker. First start shows
  *"Loading engine… (one-time ~113MB)"*; after that it starts instantly from
  the browser cache. If the download fails it falls back to chess.com's
  built-in engine.
- On **lichess** suggestions come from the lichess **cloud evaluation** API
  (instant, very deep, White/Black handled automatically). Positions missing
  from the cloud fall back to the local worker engine.

## Live relay (watch from another device)

1. Open any game — a badge appears bottom-right showing **Relay ID: xxxxxxxx**
   (press **Copy**). The ID stays the same on this browser.
2. In the [Chess Analyzer web app](https://chess.0xpnj.dev): **Live** tab →
   **Session ID** → enter the ID → **Connect Session**.
3. Every move appears on the web app's board within ~2 seconds with engine
   suggestions; when the game ends, a full Game Review starts automatically.

### How it works / privacy

Positions are sent as small JSON messages through the public
[ntfy.sh](https://ntfy.sh) pub/sub relay under the topic `chessweb-<id>`.
Messages contain only the position (FEN) and the player usernames shown on the
page. Anyone who knows the random ID could read them, so treat the ID like a
private link.

**Relay on lichess:** lichess's page security policy blocks the relay when the
script runs as a userscript — the badge then shows *"Relay unavailable on this
page"*. Use the **extension version** (its isolated world is not affected —
verified working), or simply use the web app's **Live → lichess username**
watch, which needs no relay at all.

## Troubleshooting

- **Analyzer is stuck or arrows don't appear:** press **'A'** twice (off and
  on again). This resets the engine and resyncs it with the current board.
- **"Engine unavailable" on lichess:** as a userscript, lichess's page
  security policy blocks loading the remote engine, so only cloud evaluations
  are available there — rare late-game positions may show no arrows for a
  moment. The extension version can also load the local engine.

## Extension version

The same script ships as a Chrome extension in the sibling
`chess-analyzer` folder (`scripts/main.js` is generated from `userscript.js`).
