// ==UserScript==
// @name         Chess Analyzer
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  Chess analyzer with full Stockfish 18 NNUE, lichess support, and web-app relay
// @author       Peenjeee
// @match        https://www.chess.com/*
// @match        https://lichess.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      localhost
// @connect      chess.0xpnj.dev
// ==/UserScript==

(function() {
    'use strict';

    const SITE = location.hostname.includes('lichess') ? 'lichess' : 'chesscom';

    // Full-strength Stockfish 18 NNUE hosted on our own site (CORS-open).
    // The loader reads its wasm location from the worker URL hash.
    const REMOTE_JS = "https://chess.0xpnj.dev/stockfish-18-single.js";
    const REMOTE_WASM = "https://chess.0xpnj.dev/stockfish-18-single.wasm";
    // chess.com's internal engine as a fallback (chess.com pages only)
    const CC_FALLBACK = "/bundles/app/js/vendor/jschessengine/stockfish.asm.1abfa10c.js";
    const CLOUD_EVAL = "https://lichess.org/api/cloud-eval";

    // Relay (mirrors the game to the Chess Analyzer web app via its SSE API)
    const RELAY_URLS = location.hostname === 'localhost'
        ? ['http://localhost:5173/api/relay/']
        : ['https://chess.0xpnj.dev/api/relay/'];
    const RELAY_KEY = 'chessweb-relay-id';

    const hasGM = typeof GM_xmlhttpRequest === 'function'
        || (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function');

    function gmRequest(opts) {
        return new Promise((resolve, reject) => {
            let api = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : GM.xmlHttpRequest;
            api({
                method: opts.method || 'GET',
                url: opts.url,
                data: opts.data,
                headers: opts.headers,
                responseType: opts.responseType,
                onload: r => (r.status >= 200 && r.status < 300) ? resolve(r.response) : reject(new Error('HTTP ' + r.status)),
                onerror: () => reject(new Error('network error')),
                ontimeout: () => reject(new Error('timeout'))
            });
        });
    }

    let iv = null;                 // analyzer loop interval
    let moves = [], ponder = "";
    let currentTurn = "w";
    let lastBoard = null;          // board element arrows were attached to

    async function fetchText(url) {
        try {
            let r = await fetch(url);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.text();
        } catch (e) {
            if (hasGM) return gmRequest({ url });
            throw e;
        }
    }

    async function fetchBytes(url) {
        try {
            let r = await fetch(url);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.arrayBuffer();
        } catch (e) {
            if (hasGM) return gmRequest({ url, responseType: 'arraybuffer' });
            throw e;
        }
    }

    function idbStore(mode, fn) {
        return new Promise(resolve => {
            try {
                let open = indexedDB.open('sa-engine', 1);
                open.onupgradeneeded = () => open.result.createObjectStore('files');
                open.onsuccess = () => {
                    let tx = open.result.transaction('files', mode);
                    tx.onerror = () => resolve(null);
                    fn(tx.objectStore('files'), resolve);
                };
                open.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
        });
    }
    let idbGetWasm = () => idbStore('readonly', (st, done) => {
        let g = st.get('sf18-wasm');
        g.onsuccess = () => done(g.result || null);
        g.onerror = () => done(null);
    });
    let idbPutWasm = (buf) => idbStore('readwrite', (st, done) => {
        st.put(buf, 'sf18-wasm');
        st.transaction.oncomplete = () => done(true);
    });

    // ------------------------------------------------------------------ board

    let getVP = (b, sq) => {
        let nodes = b.querySelectorAll(`.piece.${sq}`);
        for (let p of nodes) {
            if (p.style.display === 'none' || p.style.opacity === '0' || p.style.visibility === 'hidden') continue;
            if (p.classList.contains('ghost') || p.classList.contains('hint')) continue;
            return p;
        }
        return null;
    };

    function readBoardCC() {
        let b = document.querySelector(".board-layout-main wc-chess-board") || document.querySelector("wc-chess-board");
        if (!b) return null;

        let f = "";
        let lastMovedColor = null;
        let highlightCount = b.querySelectorAll('.highlight').length;
        let pieceMap = {};
        for (let p of b.querySelectorAll('.piece')) {
            if (p.style.display === 'none' || p.style.opacity === '0' || p.style.visibility === 'hidden') continue;
            if (p.classList.contains('ghost') || p.classList.contains('hint')) continue;
            let mSq = p.className.match(/\bsquare-(\d\d)\b/);
            if (mSq) pieceMap[mSq[1]] = p;
        }

        for (let i = 8; i >= 1; i--) {
            for (let j = 1; j <= 8; j++) {
                if (j === 1 && i !== 8) f += "/";
                let sqClass = `${j}${i}`;
                let pNode = pieceMap[sqClass];
                let m = pNode ? pNode.className.match(/\b([bw])([pbnrqk])\b/) : null;
                f += m ? (m[1] === 'w' ? m[2].toUpperCase() : m[2]) : "1";
                if (highlightCount === 2 && m && b.querySelector(`.highlight.square-${sqClass}`)) {
                    lastMovedColor = m[1];
                }
            }
        }
        if (!Object.keys(pieceMap).length) return null;

        if (lastMovedColor === 'w') currentTurn = 'b';
        else if (lastMovedColor === 'b') currentTurn = 'w';

        let castling = "";
        let hp = (c, sq) => { let p = getVP(b, sq); return p && p.className.includes(c); };
        if (hp('wk', 'square-51')) {
            if (hp('wr', 'square-81')) castling += "K";
            if (hp('wr', 'square-11')) castling += "Q";
        }
        if (hp('bk', 'square-58')) {
            if (hp('br', 'square-88')) castling += "k";
            if (hp('br', 'square-18')) castling += "q";
        }

        return {
            board: b,
            flipped: b.classList.contains("flipped"),
            fen: f.replace(/1+/g, m => m.length) + " " + currentTurn + " " + (castling || "-") + " - 0 1"
        };
    }

    function readBoardLI() {
        let b = document.querySelector('cg-board');
        if (!b) return null;
        let wrap = b.closest('.cg-wrap') || document.querySelector('.cg-wrap');
        let flipped = !!wrap && wrap.classList.contains('orientation-black');
        let size = b.getBoundingClientRect().width / 8;
        if (!size) return null;

        // Drag state is temporary; while a piece is in flight, lichess board
        // transforms do not reflect the settled position yet.
        if (b.querySelector('piece.ghost') ||
            b.querySelector('piece.dragging') ||
            b.querySelector('piece.anim')) return null;

        const TYPES = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
        let sqOf = (el) => {
            let m = (el.style.transform || '').match(/translate\((-?[\d.]+)px(?:,\s*(-?[\d.]+)px)?\)/);
            if (!m) return null;
            let col = Math.round(parseFloat(m[1]) / size), row = Math.round(parseFloat(m[2] || '0') / size);
            if (col < 0 || col > 7 || row < 0 || row > 7) return null;
            return flipped ? { f: 8 - col, r: row + 1 } : { f: col + 1, r: 8 - row };
        };

        let lastSquares = [];
        b.querySelectorAll('square.last-move').forEach(sq => {
            let s = sqOf(sq);
            if (s) lastSquares.push(s);
        });

        let grid = {};
        let lastColor = null;
        b.querySelectorAll('piece').forEach(p => {
            if (p.classList.contains('ghost')) return;
            let s = sqOf(p);
            if (!s) return;
            let color = p.classList.contains('white') ? 'w' : p.classList.contains('black') ? 'b' : null;
            let type = null;
            for (let k in TYPES) if (p.classList.contains(k)) { type = TYPES[k]; break; }
            if (!color || !type) return;
            grid[s.f + ',' + s.r] = color + type;
            if (lastSquares.some(q => q.f === s.f && q.r === s.r)) lastColor = color;
        });
        if (Object.keys(grid).length < 2) return null;

        if (lastColor === 'w') currentTurn = 'b';
        else if (lastColor === 'b') currentTurn = 'w';

        let f = "";
        for (let r = 8; r >= 1; r--) {
            if (r < 8) f += "/";
            for (let c = 1; c <= 8; c++) {
                let pc = grid[c + ',' + r];
                f += pc ? (pc[0] === 'w' ? pc[1].toUpperCase() : pc[1]) : "1";
            }
        }
        let castling = "";
        if (grid['5,1'] === 'wk') {
            if (grid['8,1'] === 'wr') castling += "K";
            if (grid['1,1'] === 'wr') castling += "Q";
        }
        if (grid['5,8'] === 'bk') {
            if (grid['8,8'] === 'br') castling += "k";
            if (grid['1,8'] === 'br') castling += "q";
        }

        return {
            board: b,
            flipped,
            fen: f.replace(/1+/g, m => m.length) + " " + currentTurn + " " + (castling || "-") + " - 0 1"
        };
    }

    let readBoard = SITE === 'lichess' ? readBoardLI : readBoardCC;

    // ----------------------------------------------------------------- arrows

    function ensureOverlay(b) {
        if (!b) return;
        if (lastBoard !== b) {
            document.getElementById("sa-arrows")?.remove();
            lastBoard = b;
        }
        if (!document.getElementById("sa-arrows")) {
            b.insertAdjacentHTML('beforeend', `<svg id="sa-arrows" viewBox="0 0 100 100" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:100;"></svg>`);
        }
    }

    function draw(m, i, flip) {
        if (!m || m.length < 4) return "";
        let F = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };
        let c = (f, r) => {
            let x = F[f], y = +r;
            if (!x || isNaN(y)) return null;
            if (flip) { x = 9 - x; y = 9 - y; }
            return { x: (x - 1) * 12.5 + 6.25, y: (8 - y) * 12.5 + 6.25 };
        };
        let p1 = c(m[0], m[1]), p2 = c(m[2], m[3]);
        if (!p1 || !p2) return "";
        let col = ["#3b82f6", "#ef4444", "#22c55e", "#a855f7"][i];
        let dx = Math.abs(F[m[2]] - F[m[0]]), dy = Math.abs(+m[3] - +m[1]);
        let isN = (dx === 1 && dy === 2) || (dx === 2 && dy === 1);
        let d = isN ? `M ${p1.x} ${p1.y} L ${p1.x} ${p2.y} L ${p2.x} ${p2.y}` : `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
        return `<path d="${d}" fill="none" stroke="${col}" stroke-width="${i < 3 ? 1.5 : 1}" stroke-opacity="0.9" stroke-linejoin="round" ${i === 3 ? 'stroke-dasharray="2,1"' : ''} marker-end="url(#arr-${i < 3 ? i : 'p'})" />`;
    }

    function render(flip) {
        let svg = document.getElementById("sa-arrows");
        if (!svg) return;
        svg.innerHTML = `<defs>${["#3b82f6", "#ef4444", "#22c55e", "#a855f7"].map((c, i) => `<marker id="arr-${i < 3 ? i : 'p'}" orient="auto" markerWidth="4" markerHeight="4" refX="3" refY="2"><polygon points="0,0 4,2 0,4" fill="${c}"/></marker>`).join('')}</defs>`
            + (ponder ? draw(ponder, 3, flip) : "") + [2, 1, 0].map(i => draw(moves[i], i, flip)).join("");
    }

    // ------------------------------------------------------------ score badge

    function setScore(whiteCp, whiteMate, flip) {
        let btn = document.getElementById("sa-btn");
        if (!btn) return;
        let uScore = whiteMate !== null ? (flip ? -whiteMate : whiteMate) : (flip ? -whiteCp : whiteCp);
        let bg = "#6b7280", scStr = "";
        if (whiteMate !== null) {
            bg = uScore > 0 ? "#22c55e" : "#ef4444";
            scStr = (uScore > 0 ? "+M" : "-M") + Math.abs(uScore);
        } else if (whiteCp !== null) {
            bg = uScore > 30 ? "#22c55e" : (uScore < -30 ? "#ef4444" : "#6b7280");
            scStr = uScore === 0 ? "0.0" : (uScore > 0 ? "+" : "") + (uScore / 100).toFixed(1);
        }
        if (!scStr) return;
        let span = btn.querySelector('span');
        if (span) {
            span.style.background = bg;
            span.innerHTML = scStr;
        } else {
            btn.innerHTML = `Stop Analyzer <span style="background:${bg};color:white;padding:2px 6px;border-radius:4px;margin-left:5px">${scStr}</span>`;
        }
    }

    // ----------------------------------------------------------------- engine
    // One persistent worker, serialized: never send position/go mid-search
    // (this Stockfish build crashes otherwise) — stop, await bestmove, go.

    let engine = null, engineReady = false, engineFailed = false;
    let searching = false, ignoreInfo = false, pendingFen = null;
    let engineFlip = false;
    let bootTimer = null;
    let usingFallback = false;

    async function createRemoteWorker() {
        let src = await fetchText(REMOTE_JS);
        let blobUrl = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
        let bytes = await idbGetWasm();
        if (!bytes) {
            bytes = await fetchBytes(REMOTE_WASM);
            await idbPutWasm(bytes);
        }
        let wasmRef = URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
        return new Worker(blobUrl + "#" + wasmRef);
    }

    function wireEngine(w) {
        w.onmessage = e => {
            let str = String(e.data || "");
            if (str === "uciok") {
                w.postMessage("setoption name MultiPV value 3");
                w.postMessage("setoption name Threads value 1");
                w.postMessage("setoption name Hash value 64");
                w.postMessage("setoption name Use NNUE value true");
                w.postMessage("isready");
                return;
            }
            if (str === "readyok") {
                clearTimeout(bootTimer);
                engineReady = true;
                let btn = document.getElementById("sa-btn");
                if (btn && iv && !btn.querySelector('span')) btn.innerHTML = "Stop Analyzer";
                pump();
                return;
            }
            if (str.startsWith("bestmove")) {
                searching = false;
                ignoreInfo = false;
                pump();
                return;
            }
            if (str.startsWith("info ") && !ignoreInfo) {
                let mPV = str.match(/multipv (\d+).* pv (.*)/);
                if (!mPV) return;
                let idx = +mPV[1] - 1;
                let pvList = mPV[2].trim().split(" ");
                moves[idx] = pvList[0];
                if (idx === 0) {
                    ponder = pvList.length > 1 ? pvList[1] : "";
                    let mate = str.match(/score mate (-?\d+)/);
                    let cp = str.match(/score cp (-?\d+)/);
                    // UCI scores are side-to-move POV -> convert to white POV
                    let sign = currentTurn === 'w' ? 1 : -1;
                    setScore(cp ? +cp[1] * sign : null, mate ? +mate[1] * sign : null, engineFlip);
                }
                render(engineFlip);
            }
        };
        w.onerror = () => {
            w.terminate();
            engine = null;
            engineReady = false;
            searching = false;
            if (SITE === 'chesscom' && !usingFallback) {
                usingFallback = true;
                startWorker(new Worker(CC_FALLBACK), 20000);
            } else {
                engineFailed = true;
                let btn = document.getElementById("sa-btn");
                if (btn && iv) btn.innerHTML = "Engine unavailable";
            }
        };
    }

    function startWorker(w, bootMs) {
        engine = w;
        engineReady = false;
        wireEngine(w);
        clearTimeout(bootTimer);
        bootTimer = setTimeout(() => {
            if (!engineReady && engine === w) w.onerror(new Event('error'));
        }, bootMs);
        w.postMessage("uci");
    }

    async function ensureEngine() {
        if (engine || engineFailed) return;
        let btn = document.getElementById("sa-btn");
        if (btn) btn.innerHTML = "Loading engine… (one-time ~113MB)";
        try {
            startWorker(await createRemoteWorker(), 300000);
        } catch (e) {
            if (SITE === 'chesscom' && !usingFallback) {
                usingFallback = true;
                startWorker(new Worker(CC_FALLBACK), 20000);
            } else {
                engineFailed = true;
                if (btn && iv) btn.innerHTML = "Engine unavailable";
            }
        }
    }

    function pump() {
        if (!engine || !engineReady) return;
        if (searching) {
            if (pendingFen) {
                ignoreInfo = true;
                engine.postMessage("stop");
            }
            return;
        }
        if (!pendingFen) return;
        let f = pendingFen;
        pendingFen = null;
        moves = []; ponder = "";
        searching = true;
        engine.postMessage("position fen " + f);
        engine.postMessage("go infinite");
    }

    function analyzeWorker(fen, flip) {
        engineFlip = flip;
        pendingFen = fen;
        ensureEngine();
        pump();
    }

    function stopEngine() {
        clearTimeout(bootTimer);
        engine?.terminate();
        engine = null;
        engineReady = false;
        searching = false;
        ignoreInfo = false;
        pendingFen = null;
    }

    // --------------------------------------------------------------- analyzer

    function toggle(btn) {
        if (iv) {
            clearInterval(iv);
            iv = null;
            stopEngine();
            document.getElementById("sa-arrows")?.remove();
            btn.innerHTML = "Start Analyzer (Hotkey: A)";
            return;
        }

        btn.innerHTML = "Stop Analyzer";
        moves = []; ponder = "";
        let fen = "";

        iv = setInterval(() => {
            let pos = readBoard();
            if (!pos) return;
            ensureOverlay(pos.board);

            if (pos.fen === fen) return;

            fen = pos.fen;
            moves = []; ponder = "";
            render(pos.flipped);
            analyzeWorker(fen, pos.flipped);
        }, 30);
    }

    // ------------------------------------------------------------------ relay
    // Mirrors the game to the Chess Analyzer web app (Live tab -> Session ID)

    let sessionId = localStorage.getItem(RELAY_KEY);
    if (!sessionId) {
        sessionId = Math.random().toString(36).slice(2, 10);
        localStorage.setItem(RELAY_KEY, sessionId);
    }
    let relayLastFen = "";
    let relayLastMoves = "";
    let relayMoveHistory = [];
    let relayGamePath = location.pathname;
    let relayEndSent = false;
    let relayBoard = null;
    let relayQueued = false;
    const relayBoardObserver = new MutationObserver(queueRelayTick);

    function readPlayers(flipped) {
        let t = sel => document.querySelector(sel)?.textContent?.trim() || "";
        let bottom = "", top = "";
        if (SITE === 'chesscom') {
            bottom = t('.player-bottom [data-test-element="user-tagline-username"]') || t('.player-bottom .cc-user-username-component');
            top = t('.player-top [data-test-element="user-tagline-username"]') || t('.player-top .cc-user-username-component');
        } else {
            bottom = (t('.ruser-bottom a.user-link') || t('.ruser-bottom')).split(/\s+/)[0] || "";
            top = (t('.ruser-top a.user-link') || t('.ruser-top')).split(/\s+/)[0] || "";
        }
        let bottomColor = flipped ? 'black' : 'white';
        return {
            white: bottomColor === 'white' ? bottom : top,
            black: bottomColor === 'white' ? top : bottom,
            bottom: bottomColor
        };
    }

    function isGameOver() {
        if (SITE === 'chesscom') {
            return !!document.querySelector('.game-over-modal-content, .game-over-header-component, [class*="game-over-modal"]');
        }
        return !!document.querySelector('.result-wrap, .round__app .status');
    }

    function readMovesCC() {
        const FIG = {
            '\u2659':'', '\u265f':'',
            '\u2658':'N','\u265e':'N',
            '\u2657':'B','\u265d':'B',
            '\u2656':'R','\u265c':'R',
            '\u2655':'Q','\u265b':'Q',
            '\u2654':'K','\u265a':'K'
        };
        const SAN_RE = /^(?:O-O(?:-O)?|[NBRQK][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8]|[a-h][1-8])(?:=[NBRQ])?[+#]?$/;

        function cleanSAN(tok) {
            return (tok || '')
                .replace(/[\u2654-\u265f]/g, c => FIG[c] ?? '')
                .replace(/0-0-0/gi, 'O-O-O')
                .replace(/0-0/gi,   'O-O')
                .replace(/^\d+\.(?:\.\.)?/, '')
                .replace(/[!?]+$/, '')
                .trim();
        }
        function isSAN(s) { return s && SAN_RE.test(s); }
        function textToMoves(text) {
            return String(text || '')
                .replace(/[\r\n\u00a0]+/g, ' ')
                .split(/\s+/)
                .map(cleanSAN)
                .filter(isSAN);
        }
        function nodesToMoves(nodes) {
            let arr = [];
            for (let n of nodes) {
                let raw = n.getAttribute?.('data-san') ||
                    n.getAttribute?.('data-move') ||
                    n.getAttribute?.('data-notation') ||
                    n.textContent || '';
                arr.push(...textToMoves(raw));
            }
            return arr;
        }

        // ── Strategy 1: JS property on wc-chess-board element ───────────────────
        // chess.com attaches its game object directly to the DOM element.
        // This is the most reliable approach and doesn't depend on DOM structure.
        try {
            let b = document.querySelector('.board-layout-main wc-chess-board') ||
                    document.querySelector('wc-chess-board');
            if (b) {
                let game = b.game || b._game;
                if (game) {
                    // chess.js-style history(), returns SAN array
                    if (typeof game.history === 'function') {
                        let h = game.history();
                        if (Array.isArray(h) && h.length > 0) {
                            console.log('[relay] moves via game.history():', h.length);
                            return h.slice(-256);
                        }
                    }
                    // Some versions expose moves as a list of objects
                    let rawMoves = game.moves || game.moveList || game.getMoves?.();
                    if (Array.isArray(rawMoves) && rawMoves.length > 0) {
                        let moves = rawMoves
                            .map(m => typeof m === 'string' ? cleanSAN(m) : cleanSAN(m.san || m.notation || ''))
                            .filter(isSAN);
                        if (moves.length > 0) {
                            console.log('[relay] moves via game.moves:', moves.length);
                            return moves.slice(-256);
                        }
                    }
                }
            }
        } catch(e) {}

        // ── Strategy 2: document-level querySelectorAll ──────────────────────────
        // Works for light DOM — tries specific chess.com class names.
        const docSelectors = [
            '.node-highlight-content',          // chess.com 2023+ move text
            '.move-text-component',             // older chess.com
            '[data-node-id] .move-text',
            '[data-node-id] span',
            'move .node-highlight-content',
            '.main-line-moves .node span',
            '.moves-list .node span',
            '.move-node .move-text',
            '[data-test-element*="move-list"] [data-ply]',
            '[data-ply][data-san]',
            '[data-ply] .move-san',
            'wc-simple-move-list [class*="move"]',
            'wc-chess-move-list [class*="move"]'
        ];
        for (let sel of docSelectors) {
            let nodes = document.querySelectorAll(sel);
            if (!nodes.length) continue;
            let moves = nodesToMoves(nodes);
            if (moves.length > 0) {
                console.log('[relay] moves via doc sel "' + sel + '":', moves.length);
                return moves.slice(-256);
            }
        }

        // ── Strategy 3: Move list container (light DOM + shadow DOM) ─────────────
        let root = document.querySelector(
            '.vertical-move-list-component,' +
            '.horizontal-move-list-component,' +
            '.move-list-component,' +
            '[class*="move-list"],' +
            '[data-test-element*="move-list"],' +
            'wc-simple-move-list,' +
            'wc-chess-move-list'
        );
        if (!root) {
            console.log('[relay] no move list root found');
            return [];
        }

        // Try shadow root first, then light DOM
        let roots = [root.shadowRoot, root].filter(Boolean);
        for (let sr of roots) {
            // Try individual nodes inside this root
            for (let sel of docSelectors) {
                let nodes = sr.querySelectorAll(sel);
                if (!nodes.length) continue;
                let moves = nodesToMoves(nodes);
                if (moves.length > 0) {
                    console.log('[relay] moves via sr sel "' + sel + '":', moves.length);
                    return moves.slice(-256);
                }
            }

            // ── Strategy 4: full text scraping of container ───────────────────────
            let text = (sr.innerText || sr.textContent || '')
                .replace(/[\u2654-\u265f]/g, c => FIG[c] ?? '')
                .replace(/0-0-0/gi, 'O-O-O')
                .replace(/0-0/gi,   'O-O')
                .replace(/\u00a0/g, ' ')
                .replace(/[\r\n]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (!text) continue;

            let moves = textToMoves(text);
            if (moves.length > 0) {
                console.log('[relay] moves via text scrape, len:', (sr === root.shadowRoot ? 'shadow' : 'light'), moves.length);
                return moves.slice(-256);
            }
        }

        console.log('[relay] readMovesCC: no moves found. root tag:', root.tagName,
            'shadowRoot:', !!root.shadowRoot,
            'innerText len:', root.innerText?.length,
            'textContent len:', root.textContent?.length);
        return [];
    }

    function publish(payload) {
        let body = JSON.stringify(payload);
        for (let base of RELAY_URLS) {
            if (hasGM) {
                gmRequest({
                    method: 'POST',
                    url: base + sessionId,
                    data: body,
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
                }).catch(err => console.warn('relay publish failed', base, err));
            } else {
                fetch(base + sessionId, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body
                }).catch(err => console.warn('relay publish failed', base, err));
            }
        }
    }

    function keepFullRelayHistory(playedMoves) {
        let gamePath = location.pathname;
        if (gamePath !== relayGamePath || (relayEndSent && !isGameOver() && playedMoves.length <= 2)) {
            relayGamePath = gamePath;
            relayMoveHistory = [];
        }

        let isPrefix = playedMoves.every((move, index) => move === relayMoveHistory[index]);
        if (!isPrefix || playedMoves.length > relayMoveHistory.length) {
            relayMoveHistory = playedMoves;
        }
        return relayMoveHistory;
    }

    function publishRelayPosition(pos, force = false) {
        let playedMoves = SITE === 'chesscom' ? readMovesCC() : [];
        if (SITE === 'chesscom') playedMoves = keepFullRelayHistory(playedMoves);
        let movesKey = playedMoves.join(' ');
        if (!force && pos.fen === relayLastFen && movesKey === relayLastMoves) return false;

        relayLastFen = pos.fen;
        relayLastMoves = movesKey;
        relayEndSent = false;
        let players = readPlayers(pos.flipped);
        publish({ v: 1, type: 'pos', fen: pos.fen, moves: playedMoves, white: players.white, black: players.black, bottom: players.bottom, ts: Date.now() });
        return true;
    }

    function refreshRelayMoves(fen) {
        let pos = readBoard();
        if (!pos || pos.fen !== fen) return;
        if (publishRelayPosition(pos) && isGameOver()) sendRelayEnd();
    }

    function sendRelayEnd() {
        if (relayEndSent) return;
        relayEndSent = true;
        publish({ v: 1, type: 'end', ts: Date.now() });
    }

    function relayTick() {
        try {
            let pos = readBoard();
            if (!pos) return;

            if (pos.board !== relayBoard) {
                relayBoardObserver.disconnect();
                relayBoard = pos.board;
                relayBoardObserver.observe(relayBoard, {
                    attributes: true,
                    childList: true,
                    subtree: true,
                    attributeFilter: ['class', 'style']
                });
            }

            let fenChanged = pos.fen !== relayLastFen;
            if (fenChanged) {
                publishRelayPosition(pos);
                if (SITE === 'chesscom') {
                    queueMicrotask(() => refreshRelayMoves(pos.fen));
                    setTimeout(() => refreshRelayMoves(pos.fen), 100);
                }
            }
            if (isGameOver()) sendRelayEnd();
        } catch (err) {
            console.warn('relay tick failed', err);
        }
    }

    function queueRelayTick() {
        if (relayQueued) return;
        relayQueued = true;
        queueMicrotask(() => {
            relayQueued = false;
            relayTick();
        });
    }

    new MutationObserver(queueRelayTick).observe(document.documentElement, {
        childList: true,
        subtree: true
    });
    queueRelayTick();
    setInterval(() => {
        const pos = readBoard();
        if (pos && !isGameOver()) publishRelayPosition(pos, true);
    }, 2000);

    // --------------------------------------------------------------------- ui

    function mountUI() {
        // Analyzer button
        if (!document.getElementById("sa-wrap")) {
            if (SITE === 'chesscom') {
                let host = document.querySelector(".board-layout-main");
                if (host) {
                    host.insertAdjacentHTML('afterbegin', `<div id="sa-wrap" style="display:flex;padding:10px;background:var(--globalBackgroundDark);border-radius:5px;margin-bottom:10px;"><button id="sa-btn" class="ui_v5-button-component ui_v5-button-primary" style="flex:1">Start Analyzer (Hotkey: A)</button></div>`);
                    document.getElementById("sa-btn").onclick = e => toggle(e.currentTarget);
                }
            } else if (document.querySelector('cg-board')) {
                document.body.insertAdjacentHTML('beforeend', `<div id="sa-wrap" style="position:fixed;bottom:12px;left:12px;z-index:99999;"><button id="sa-btn" style="background:#262421;color:#e0e0e0;border:1px solid #3d3b38;border-radius:8px;padding:8px 14px;font:13px sans-serif;cursor:pointer">Start Analyzer (Hotkey: A)</button></div>`);
                document.getElementById("sa-btn").onclick = e => toggle(e.currentTarget);
            }
        }
    }

    setInterval(() => {
        mountUI();
        queueRelayTick();
    }, 1500);

    window.addEventListener('keydown', e => {
        if (e.ctrlKey && e.shiftKey && ['c', 'x'].includes(e.key.toLowerCase())) {
            e.preventDefault();
            if (navigator.clipboard) navigator.clipboard.writeText(sessionId).catch(() => {});
            document.getElementById('sa-toast')?.remove();
            document.body.insertAdjacentHTML('beforeend', `<div id="sa-toast" style="position:fixed;bottom:12px;right:12px;z-index:99999;background:#262421;color:#e0e0e0;border:1px solid #3d3b38;border-radius:8px;padding:8px 12px;font:12px sans-serif;">Relay ID copied: <b style="font-family:monospace">${sessionId}</b></div>`);
            setTimeout(() => document.getElementById('sa-toast')?.remove(), 1600);
            return;
        }
        if (e.repeat || e.target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
        if (e.key.toLowerCase() === 'a') {
            let btn = document.getElementById("sa-btn");
            if (btn) {
                e.preventDefault();
                e.stopImmediatePropagation();
                btn.click();
            }
        }
        if (e.key === 'Insert') {
            e.preventDefault();
            e.stopImmediatePropagation();
            for (let id of ["sa-wrap", "chessweb-relay-badge"]) {
                let el = document.getElementById(id);
                if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
            }
        }
    }, true);

})();
