// ==UserScript==
// @name         Chess Analyzer
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  Chess analyzer with full Stockfish 18 NNUE, lichess (with variants) and endgame.ai support, and web-app relay
// @author       Peenjeee
// @match        https://www.chess.com/*
// @match        https://lichess.org/*
// @match        https://endgame.ai/*
// @match        https://www.endgame.ai/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      localhost
// @connect      chess.0xpnj.dev
// @connect      cdn.jsdelivr.net
// @connect      lichess1.org
// ==/UserScript==

(function() {
    'use strict';

    const SITE = location.hostname.includes('lichess') ? 'lichess'
        : location.hostname.includes('endgame') ? 'endgame'
        : 'chesscom';
    const EG_BOARD = '.board-container .board';

    // Full-strength Stockfish 18 NNUE hosted on our own site (CORS-open).
    // The loader reads its wasm location from the worker URL hash.
    const REMOTE_JS = "https://chess.0xpnj.dev/stockfish-18-single.js";
    const REMOTE_WASM = "https://chess.0xpnj.dev/stockfish-18-single.wasm";
    // chess.com's internal engine as a fallback (chess.com pages only)
    const CC_FALLBACK = "/bundles/app/js/vendor/jschessengine/stockfish.asm.1abfa10c.js";
    // lichess variants run on multi-variant Stockfish 10 (GPLv3,
    // github.com/lichess-org/stockfish.js): one thread and no SharedArrayBuffer,
    // so it runs wherever SF18 does. Pinned on jsDelivr and checked byte for
    // byte, since it runs with the page's origin.
    const MV_JS = "https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.wasm.js";
    const MV_WASM = "https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.wasm";
    const MV_SHA256 = {
        js: "064175042d8b72eb9fba8311b730f6f5cebcfec736494698d675dc433f3bd275",
        wasm: "45816b436eb8c180acb2c5b9fda0148101f411edbfa6bf919918e0a362eafca8"
    };
    // Where threads are allowed (lichess game pages are cross-origin isolated)
    // the variants run on the stronger Fairy-Stockfish 14 with a network per
    // variant: the build lichess's own analysis uses (github.com/lichess-org/
    // stockfish-web, AGPLv3; Fairy-Stockfish is GPLv3), pinned and checked the
    // same way. Each network comes from lichess's asset host and is named
    // after the start of its own SHA-256.
    const FSF_JS = "https://cdn.jsdelivr.net/npm/@lichess-org/stockfish-web@0.5.0/fsf_14.js";
    const FSF_WASM = "https://cdn.jsdelivr.net/npm/@lichess-org/stockfish-web@0.5.0/fsf_14.wasm";
    const FSF_SHA256 = {
        js: "d22d4e7df089b86fdcb678a795a2116d52a06e041fc91819448fc93eb3f3021f",
        wasm: "e9c04dff71870770a515f1d1257aca4d7cebe2915339e9f847aebdc0c8ca74e0"
    };
    const NNUE_URL = "https://lichess1.org/assets/lifat/nnue/";
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
    let idbGet = (key) => idbStore('readonly', (st, done) => {
        let g = st.get(key);
        g.onsuccess = () => done(g.result || null);
        g.onerror = () => done(null);
    });
    let idbPut = (key, buf) => idbStore('readwrite', (st, done) => {
        st.put(buf, key);
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

    // lichess variants by the key in the game's `variant-*` class. `uci` is the
    // engine's name for it and `nnue` Fairy-Stockfish's network for it; the
    // rest is what playableFen accepts: kings per
    // side (null: any number), what a king in check means (royal: it is that
    // side's turn; atomic: the same unless the kings touch; never: the board
    // was misread; none: kings are ordinary pieces), and whether castling and
    // white pawns on rank 1 occur. Other keys (chess960, fromPosition) stay standard.
    const STANDARD = { uci: 'chess', kings: [1, 1], check: 'royal', castling: true, firstRankPawns: false };
    const LI_VARIANTS = {
        kingOfTheHill: { ...STANDARD, uci: 'kingofthehill', nnue: 'kingofthehill-978b86d0e6a4' },
        threeCheck: { ...STANDARD, uci: '3check', nnue: '3check-cb5f517c228b' },
        crazyhouse: { ...STANDARD, uci: 'crazyhouse', nnue: 'crazyhouse-8ebf84784ad2' },
        atomic: { ...STANDARD, uci: 'atomic', nnue: 'atomic-2cf13ff256cc', check: 'atomic' },
        horde: { ...STANDARD, uci: 'horde', nnue: 'horde-28173ddccabe', kings: [0, 1], firstRankPawns: true },
        racingKings: { ...STANDARD, uci: 'racingkings', nnue: 'racingkings-636b95f085e3', check: 'never', castling: false },
        antichess: { ...STANDARD, uci: 'antichess', nnue: 'antichess-dd3cbe53cd4e', kings: null, check: 'none', castling: false }
    };

    function readBoardLI() {
        let b = document.querySelector('cg-board');
        if (!b) return null;
        let host = b.closest('.round__app, main.analyse');
        let rules = LI_VARIANTS[host?.className.match(/\bvariant-(\w+)/)?.[1]] || STANDARD;
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
            // chessground hides squares it no longer needs instead of removing them,
            // and a hidden one keeps the classes of an older move or selection
            if (sq.style.display === 'none') return;
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
        else {
            // Nothing stands on the last-move squares: an atomic capture blew
            // them up, a Chess960 castle left king and rook elsewhere, or there
            // is no last move. The analysis board's current move still gives
            // the ply (two path characters per ply), a live game's running clock
            // the side to move, and before the first move it is White's turn.
            let active = host?.querySelector('move.active');
            let clock = document.querySelector('.rclock.running');
            if (active) currentTurn = (active.getAttribute('p') || '').length / 2 % 2 ? 'b' : 'w';
            else if (clock?.classList.contains('rclock-white')) currentTurn = 'w';
            else if (clock?.classList.contains('rclock-black')) currentTurn = 'b';
            else if (!lastSquares.length) currentTurn = 'w';
        }

        let f = "";
        for (let r = 8; r >= 1; r--) {
            if (r < 8) f += "/";
            for (let c = 1; c <= 8; c++) {
                let pc = grid[c + ',' + r];
                f += pc ? (pc[0] === 'w' ? pc[1].toUpperCase() : pc[1]) : "1";
            }
        }
        let castling = "";
        if (rules.castling && grid['5,1'] === 'wk') {
            if (grid['8,1'] === 'wr') castling += "K";
            if (grid['1,1'] === 'wr') castling += "Q";
        }
        if (rules.castling && grid['5,8'] === 'bk') {
            if (grid['8,8'] === 'br') castling += "k";
            if (grid['1,8'] === 'br') castling += "q";
        }

        // Crazyhouse pockets sit beside the board: one piece per role, its count in data-nb
        let pocket = "";
        if (rules.uci === 'crazyhouse') {
            host.querySelectorAll('.pocket piece').forEach(p => {
                let type = Object.keys(TYPES).find(k => p.classList.contains(k));
                if (!type) return;
                let letter = p.classList.contains('white') ? TYPES[type].toUpperCase() : TYPES[type];
                pocket += letter.repeat(+p.dataset.nb || 0);
            });
            pocket = "[" + pocket + "]";
        }
        // Three-check: each check given shows as a king icon in the giver's
        // material bar; the engine wants the checks each side has left
        let checks = "";
        if (rules.uci === '3check') {
            let given = side => host.querySelectorAll(`.material-${side} mpiece.king`).length;
            let [byWhite, byBlack] = flipped ? [given('top'), given('bottom')] : [given('bottom'), given('top')];
            checks = Math.max(0, 3 - byWhite) + "+" + Math.max(0, 3 - byBlack) + " ";
        }

        return {
            board: b,
            flipped,
            rules,
            fen: f.replace(/1+/g, m => m.length) + pocket + " " + currentTurn + " " + (castling || "-") + " - " + checks + "0 1"
        };
    }

    // chess.com's variants server, by the slug in /variants/<slug>/game/<id>;
    // its rules for these match lichess's. Any other slug, custom rules and
    // four-player boards included, is reported as not supported.
    const CC_VARIANTS = {
        'crazyhouse': LI_VARIANTS.crazyhouse,
        '3-check': LI_VARIANTS.threeCheck,
        'king-of-the-hill': LI_VARIANTS.kingOfTheHill,
        'atomic': LI_VARIANTS.atomic,
        'giveaway': LI_VARIANTS.antichess,
        'horde': LI_VARIANTS.horde
    };

    // The moves played so far, as SAN, from the variants server's move list
    function movesCV() {
        let list = document.querySelector('[class*=moves-list]')?.parentElement;
        if (!list) return [];
        return [...list.querySelectorAll('span')]
            .filter(s => !s.children.length)
            .map(s => s.textContent.trim())
            .filter(t => /^(@?[NBRQKP]?[a-h]?[1-8]?x?[a-h][1-8](=[NBRQ])?|O-O(-O)?)[+#]?$/.test(t));
    }

    // The variants server draws its own board: pieces are divs with data-piece
    // and data-color (5 White, 6 Black) placed by transform in square units,
    // and each banked crazyhouse piece is one more div off the board's edge.
    function readBoardCV() {
        let b = document.querySelector('.TheBoard-layers');
        let slug = location.pathname.match(/^\/variants\/([^/]+)/)?.[1] || '';
        let rules = CC_VARIANTS[slug];
        if (!rules) return { board: b, flipped: false, fen: '', unsupported: slug || 'this board' };
        let size = b.getBoundingClientRect().width / 8;
        if (!size) return null;
        // the bottom player box is player 0 (White) or 2 (Black)
        let flipped = document.querySelector('.playerbox-bottom [data-player]')?.dataset.player === '2';

        let grid = {}, pocket = { w: '', b: '' };
        for (let p of b.querySelectorAll('.TheBoard-pieces .piece')) {
            let m = (p.style.transform || '').match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
            let color = { 5: 'w', 6: 'b' }[p.dataset.color];
            let type = (p.dataset.piece || '').toLowerCase();
            if (!m || !color || type.length !== 1 || !'pnbrqk'.includes(type)) continue;
            let col = Math.round(+m[1] / size), row = Math.round(+m[2] / size);
            if (col < 0 || col > 7) { pocket[color] += type; continue; }
            if (row < 0 || row > 7) continue;
            grid[(flipped ? 8 - col : col + 1) + ',' + (flipped ? row + 1 : 8 - row)] = color + type;
        }
        if (Object.keys(grid).length < 2) return null;

        // The side to move has the bright clock; when neither runs, the number
        // of moves played says whose turn it is
        let sans = movesCV();
        let running = [...document.querySelectorAll('.playerbox-component')]
            .find(x => /brightness\(100%\)/.test(x.querySelector('.clock-component')?.getAttribute('style') || ''));
        let player = running?.querySelector('[data-player]')?.dataset.player;
        let turn = player === '0' ? 'w' : player === '2' ? 'b' : sans.length % 2 ? 'b' : 'w';

        let f = "";
        for (let r = 8; r >= 1; r--) {
            if (r < 8) f += "/";
            for (let c = 1; c <= 8; c++) {
                let pc = grid[c + ',' + r];
                f += pc ? (pc[0] === 'w' ? pc[1].toUpperCase() : pc[1]) : "1";
            }
        }
        let castling = "";
        if (rules.castling && grid['5,1'] === 'wk') {
            if (grid['8,1'] === 'wr') castling += "K";
            if (grid['1,1'] === 'wr') castling += "Q";
        }
        if (rules.castling && grid['5,8'] === 'bk') {
            if (grid['8,8'] === 'br') castling += "k";
            if (grid['1,8'] === 'br') castling += "q";
        }
        let banks = rules.uci === 'crazyhouse' ? "[" + pocket.w.toUpperCase() + pocket.b + "]" : "";
        // three-check: the checks each side has left, from the "+" moves in the list
        let checks = "";
        if (rules.uci === '3check') {
            let given = side => sans.filter((s, i) => i % 2 === side && /[+#]$/.test(s)).length;
            checks = Math.max(0, 3 - given(0)) + "+" + Math.max(0, 3 - given(1)) + " ";
        }
        return {
            board: b,
            flipped,
            rules,
            fen: f.replace(/1+/g, m => m.length) + banks + " " + turn + " " + (castling || "-") + " - " + checks + "0 1"
        };
    }

    // Toast notification for in-game tactical alerts
    function showToast(msg, bg = '#1e1b4b', border = '#6366f1', duration = 4000) {
        let el = document.getElementById('sa-toast');
        if (!el) {
            document.body.insertAdjacentHTML('beforeend', `<div id="sa-toast" style="position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:999999;padding:10px 18px;border-radius:8px;font:600 13px system-ui,-apple-system,sans-serif;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,0.5);display:none;align-items:center;gap:8px;pointer-events:none;transition:opacity 0.2s ease;"></div>`);
            el = document.getElementById('sa-toast');
        }
        el.innerHTML = msg;
        el.style.background = bg;
        el.style.border = `1px solid ${border}`;
        el.style.display = 'flex';
        el.style.opacity = '1';
        clearTimeout(el._t);
        el._t = setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => { el.style.display = 'none'; }, 200);
        }, duration);
    }

    // Secret Queen: square of hidden queen from endgame.ai's game API.
    // Opponent stays hidden until revealed (server-side zero knowledge).
    // `revealed` array and DOM badges track both sides once revealed.
    let lastEGGrid = null, lastEGFlipped = false;
    // `secret` stays null until the API says whether this game is Secret Queen;
    // the overlay and alerts only show once it has said yes
    const SECRET_RETRY_MS = 5000;
    function newSecretState(gameId) {
        return { gameId, boardKey: '', ownSquare: null, revealed: [], inFlight: false, secret: null, start960: null, retryAt: 0, spectating: false, lastOppPawns: null, queenCapturedNotified: false };
    }
    let egSecret = newSecretState('');

    function checkRevealedCaptures(revealed) {
        if (!Array.isArray(revealed) || egSecret.queenCapturedNotified) return;
        let oppColor = lastEGFlipped ? 'w' : 'b';
        let opp = revealed.find(r => r.color === oppColor);
        if (!opp || !opp.square) return;

        if (lastEGGrid) {
            let key = ('abcdefgh'.indexOf(opp.square[0]) + 1) + ',' + opp.square[1];
            let hasQueen = Object.values(lastEGGrid).includes(oppColor + 'q');
            let hasPawnAtStart = lastEGGrid[key] === oppColor + 'p';
            if (!hasQueen && !hasPawnAtStart) {
                egSecret.queenCapturedNotified = true;
                showToast(`👑 <b>SECRET QUEEN LAWAN TERMAKAN!</b><br>Pion dari petak <b>${opp.square.toUpperCase()}</b> yang kamu makan adalah Secret Queen lawan!`, '#450a0a', '#ef4444', 9000);
            } else if (opp.revealedAtMoveNumber !== null) {
                showToast(`⚡ <b>SECRET QUEEN LAWAN TERUNGKAP!</b><br>Lawan menggerakkan Secret Queen dari <b>${opp.square.toUpperCase()}</b>!`, '#312e81', '#6366f1', 6000);
            }
        }
    }

    function checkSecretQueenCaptures(grid, oppColor) {
        if (!grid || egSecret.secret !== true) return;
        let currentOppPawns = Object.keys(grid).filter(k => grid[k] === oppColor + 'p');
        if (egSecret.lastOppPawns === null) {
            egSecret.lastOppPawns = currentOppPawns.length;
            return;
        }
        if (currentOppPawns.length < egSecret.lastOppPawns) {
            egSecret.lastOppPawns = currentOppPawns.length;
            showToast(`⚠️ Pion lawan termakan! (Sisa ${currentOppPawns.length} calon Secret Queen)`, '#1e1b4b', '#6366f1', 3500);
            if (Array.isArray(egSecret.revealed)) {
                checkRevealedCaptures(egSecret.revealed);
            }
        }
    }

    // endgame.ai authenticates its API with a Bearer token kept in web storage,
    // not a cookie. It is only ever sent back to endgame.ai's own API here —
    // never logged and never part of the relay.
    function egAccessToken() {
        try {
            let raw = sessionStorage.getItem('session_key') || localStorage.getItem('session_key');
            let session = raw ? JSON.parse(raw) : null;
            return typeof session?.access_token === 'string' ? session.access_token : null;
        } catch (e) {
            return null;
        }
    }

    // The public game endpoint names the variant, and a Chess960 game's start
    // position, for anyone: players, spectators and logged-out visitors.
    // null: no answer yet, ask again later
    function fetchEGGame(gameId) {
        return fetch('/api/games/' + encodeURIComponent(gameId), { headers: { 'Accept': 'application/json' } })
            .then(r => {
                if (r.status === 404) return {};
                return r.ok ? r.json().then(g => g || {}) : null;
            });
    }

    // Once per game. A failed lookup is retried after a few seconds rather
    // than on the next move: a finished game's board never moves.
    function lookUpVariant(state) {
        if (Date.now() < state.retryAt) return;
        state.inFlight = true;
        state.retryAt = Date.now() + SECRET_RETRY_MS;
        fetchEGGame(state.gameId)
            .then(g => {
                if (!g || egSecret !== state) return;
                state.secret = g.variant === 'SecretQueen';
                state.start960 = g.variant === 'Chess960' && typeof g.startingFen === 'string' ? g.startingFen : null;
                // the overlay was held back until now, and the board may not move again soon
                if (state.secret) render(lastEGFlipped);
            })
            .catch(() => {})
            .finally(() => { state.inFlight = false; });
    }

    // Your own hidden queen's square needs your login. One lookup per board
    // change, whatever the answer: the square only moves when your pawn does,
    // and the site refreshes an expired token (401) before the next move.
    function lookUpOwnSquare(state, boardKey) {
        let token = egAccessToken();
        if (!token) return;
        state.inFlight = true;
        state.boardKey = boardKey;
        fetch('/api/games/' + encodeURIComponent(state.gameId) + '/secret-queen', {
            headers: { 'Authorization': 'Bearer ' + token, 'x-eg-platform': 'web' }
        })
            .then(r => {
                if (r.status === 404) return { spectating: true };
                return r.ok ? r.json() : null;
            })
            .then(data => {
                if (!data || egSecret !== state) return;
                if (data.spectating) {
                    // not your game: no hidden square of yours to ask about
                    state.spectating = true;
                    return;
                }
                state.ownSquare = !data.ownRevealed && /^[a-h][1-8]$/.test(data.ownSquare || '')
                    ? data.ownSquare
                    : null;
                state.revealed = Array.isArray(data.revealed) ? data.revealed : [];
                checkRevealedCaptures(state.revealed);
            })
            .catch(() => {})
            .finally(() => { state.inFlight = false; });
    }

    function refreshOwnSecretQueen(boardKey) {
        let gameId = location.pathname.match(/^\/game\/([\w-]+)/)?.[1] || '';
        // a new game, or a board that is not a game page: forget the old game
        if (egSecret.gameId !== gameId) egSecret = newSecretState(gameId);
        if (!gameId || egSecret.inFlight) return;
        if (egSecret.secret === null) lookUpVariant(egSecret);
        else if (egSecret.secret && !egSecret.spectating && egSecret.boardKey !== boardKey) lookUpOwnSquare(egSecret, boardKey);
    }

    // Other boards (home preview, a previous game) can stay mounted, so pick
    // the largest one that has rendered its cells.
    function findBoardEG() {
        let best = null, bestArea = 0;
        for (let b of document.querySelectorAll(EG_BOARD)) {
            if (!b.querySelector('.cell#a1')) continue;
            let r = b.getBoundingClientRect();
            if (r.width * r.height > bestArea) { best = b; bestArea = r.width * r.height; }
        }
        return best;
    }

    function readBoardEG() {
        let b = findBoardEG();
        if (!b) return null;
        let a1 = b.querySelector('.cell#a1'), h8 = b.querySelector('.cell#h8');
        if (!a1 || !h8) return null;
        // Flipping reverses the cell order, so a1 ends up above h8.
        let flipped = a1.getBoundingClientRect().top < h8.getBoundingClientRect().top;

        let grid = {};
        let lastColor = null;
        b.querySelectorAll('.cell').forEach(cell => {
            let sq = cell.id.match(/^([a-h])([1-8])$/);
            let p = cell.querySelector('.piece');
            if (!sq || !p) return;
            let m = p.className.match(/\bpiece\s+([pnbrqk])([wb])\b/);
            if (!m) return;
            let type = cell.querySelector('.secret-queen-badge') ? 'q' : m[1];
            grid[('abcdefgh'.indexOf(sq[1]) + 1) + ',' + sq[2]] = m[2] + type;
            if (cell.classList.contains('lastMove')) lastColor = m[2];
        });
        // A half-rendered board without both kings will crash the engine.
        let pieces = Object.values(grid);
        if (pieces.filter(p => p === 'wk').length !== 1 || pieces.filter(p => p === 'bk').length !== 1) return null;

        // Secret Queen: hidden queen looks like a pawn on board;
        // engine must know it moves as a queen (own square + revealed from API)
        refreshOwnSecretQueen(Object.entries(grid).sort().join(';'));
        let own = egSecret.ownSquare;
        if (own) {
            let key = ('abcdefgh'.indexOf(own[0]) + 1) + ',' + own[1];
            if (grid[key] && grid[key][1] === 'p') grid[key] = grid[key][0] + 'q';
        }
        if (Array.isArray(egSecret.revealed)) {
            egSecret.revealed.forEach(r => {
                if (r?.square && /^[a-h][1-8]$/.test(r.square)) {
                    let key = ('abcdefgh'.indexOf(r.square[0]) + 1) + ',' + r.square[1];
                    if (grid[key] && grid[key][1] === 'p' && (!r.color || grid[key][0] === r.color)) {
                        grid[key] = grid[key][0] + 'q';
                    }
                }
            });
        }
        lastEGGrid = grid;
        lastEGFlipped = flipped;
        checkSecretQueenCaptures(grid, flipped ? 'w' : 'b');

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

    // chess.com's variants server has its own board; everywhere else on chess.com it is wc-chess-board
    let readBoardChesscom = () => document.querySelector('.TheBoard-layers') ? readBoardCV() : readBoardCC();
    let readBoard = { lichess: readBoardLI, endgame: readBoardEG, chesscom: readBoardChesscom }[SITE];

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
        let col = ["#3b82f6", "#ef4444", "#22c55e", "#a855f7"][i];
        // a crazyhouse drop (N@f3) rings the square and names the piece
        if (m[1] === '@') {
            let p = c(m[2], m[3]);
            if (!p) return "";
            return `<circle cx="${p.x}" cy="${p.y}" r="5" fill="none" stroke="${col}" stroke-width="${i < 3 ? 1.2 : 0.8}" stroke-opacity="0.9" ${i === 3 ? 'stroke-dasharray="2,1"' : ''} />`
                + `<text x="${p.x}" y="${p.y}" text-anchor="middle" dominant-baseline="central" font-size="5" font-weight="700" font-family="sans-serif" fill="${col}" fill-opacity="0.9">${m[0]}</text>`;
        }
        let p1 = c(m[0], m[1]), p2 = c(m[2], m[3]);
        if (!p1 || !p2) return "";
        let dx = Math.abs(F[m[2]] - F[m[0]]), dy = Math.abs(+m[3] - +m[1]);
        let isN = (dx === 1 && dy === 2) || (dx === 2 && dy === 1);
        let d = isN ? `M ${p1.x} ${p1.y} L ${p1.x} ${p2.y} L ${p2.x} ${p2.y}` : `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
        return `<path d="${d}" fill="none" stroke="${col}" stroke-width="${i < 3 ? 1.5 : 1}" stroke-opacity="0.9" stroke-linejoin="round" ${i === 3 ? 'stroke-dasharray="2,1"' : ''} marker-end="url(#arr-${i < 3 ? i : 'p'})" />`;
    }

    function renderEGThreats(flip) {
        if (SITE !== 'endgame' || egSecret.secret !== true || !lastEGGrid) return "";
        let oppColor = flip ? 'w' : 'b';
        let myColor = flip ? 'b' : 'w';

        let oppPawns = [];
        for (let k in lastEGGrid) {
            if (lastEGGrid[k] === oppColor + 'p') {
                let [c, r] = k.split(',').map(Number);
                oppPawns.push({ c, r });
            }
        }
        if (oppPawns.length === 0) return "";

        let pt = (c, r) => {
            let x = flip ? 9 - c : c;
            let y = flip ? 9 - r : r;
            return { x: (x - 1) * 12.5 + 6.25, y: (8 - y) * 12.5 + 6.25 };
        };

        let dirs = [[1,0], [-1,0], [0,1], [0,-1], [1,1], [-1,1], [1,-1], [-1,-1]];
        let threats = [];
        let openLines = [];

        for (let p of oppPawns) {
            for (let [dc, dr] of dirs) {
                let nc = p.c + dc, nr = p.r + dr;
                let endC = null, endR = null;
                let hitMyPiece = false;
                while (nc >= 1 && nc <= 8 && nr >= 1 && nr <= 8) {
                    let target = lastEGGrid[nc + ',' + nr];
                    if (target) {
                        if (target[0] === myColor) {
                            hitMyPiece = true;
                            endC = nc; endR = nr;
                        }
                        break;
                    }
                    endC = nc; endR = nr;
                    nc += dc; nr += dr;
                }
                if (endC !== null && endR !== null) {
                    let p1 = pt(p.c, p.r);
                    let p2 = pt(endC, endR);
                    if (hitMyPiece) {
                        threats.push({ p1, p2, target: { c: endC, r: endR } });
                    } else {
                        openLines.push({ p1, p2 });
                    }
                }
            }
        }

        let out = `<g id="sa-sq-threats">`;
        for (let l of openLines) {
            out += `<line x1="${l.p1.x}" y1="${l.p1.y}" x2="${l.p2.x}" y2="${l.p2.y}" stroke="#ef4444" stroke-width="0.35" stroke-dasharray="1,2.5" stroke-opacity="0.22" />`;
        }
        for (let t of threats) {
            out += `<line x1="${t.p1.x}" y1="${t.p1.y}" x2="${t.p2.x}" y2="${t.p2.y}" stroke="#ef4444" stroke-width="0.9" stroke-dasharray="2,1.5" stroke-opacity="0.85" />`;
            out += `<circle cx="${t.p2.x}" cy="${t.p2.y}" r="3.2" fill="none" stroke="#ef4444" stroke-width="0.9" stroke-opacity="0.9" />`;
            out += `<circle cx="${t.p2.x}" cy="${t.p2.y}" r="1.2" fill="#ef4444" fill-opacity="0.9" />`;
        }
        for (let p of oppPawns) {
            let p1 = pt(p.c, p.r);
            out += `<circle cx="${p1.x}" cy="${p1.y}" r="2" fill="none" stroke="#f59e0b" stroke-width="0.75" stroke-opacity="0.85" />`;
        }
        out += `</g>`;
        return out;
    }

    // Chess960 castling comes as king-takes-own-rook (f1h1). Draw where the
    // king lands, or the rook's move when the king already stands there.
    // The ponder move is read on the board after the best move, so a king
    // recapturing on the square a rook was just taken on stays a capture.
    function shown960(m, after) {
        if (!searchBoard960 || !m || m.length < 4 || m[1] === '@') return m;
        let board = searchBoard960;
        if (after && after.length >= 4 && after[1] !== '@') {
            board = board.map(row => row.slice());
            let [fr, fc, tr, tc] = [8 - +after[1], 'abcdefgh'.indexOf(after[0]), 8 - +after[3], 'abcdefgh'.indexOf(after[2])];
            if (board[fr] && board[tr]) { board[tr][tc] = board[fr][fc]; board[fr][fc] = ''; }
        }
        let at = sq => board[8 - +sq[1]]?.['abcdefgh'.indexOf(sq[0])] || '';
        let king = at(m.slice(0, 2)), rook = at(m.slice(2, 4));
        if (!/^[Kk]$/.test(king) || rook !== (king === 'K' ? 'R' : 'r')) return m;
        let short = m[2] > m[0], rank = m[1];
        let kingTo = (short ? 'g' : 'c') + rank;
        return kingTo !== m.slice(0, 2) ? m.slice(0, 2) + kingTo : m.slice(2, 4) + (short ? 'f' : 'd') + rank;
    }

    function render(flip) {
        let svg = document.getElementById("sa-arrows");
        if (!svg) return;
        let threats = renderEGThreats(flip);
        svg.innerHTML = `<defs>${["#3b82f6", "#ef4444", "#22c55e", "#a855f7"].map((c, i) => `<marker id="arr-${i === 3 ? 'p' : i}" orient="auto" markerWidth="4" markerHeight="4" refX="3" refY="2"><polygon points="0,0 4,2 0,4" fill="${c}"/></marker>`).join('')}</defs>`
            + threats
            + (ponder ? draw(shown960(ponder, moves[0]), 3, flip) : "") + [2, 1, 0].map(i => draw(shown960(moves[i]), i, flip)).join("");
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
    let engineStarting = false;    // one start at a time: the load is ~113MB
    let searching = false, ignoreInfo = false, pendingFen = null;
    let searchTurn = "w";          // side to move in the position being searched
    let engineFlip = false;
    let bootTimer = null, retryTimer = null;
    let usingFallback = false;
    let engineVariant = 'chess';   // UCI_Variant the worker plays; standard chess runs on SF18
    let engineFsf = false;         // whether the worker is Fairy-Stockfish rather than SF10
    let fsfBroken = false;         // Fairy-Stockfish failed on this page: variants use SF10
    let engine960 = false;         // UCI_Chess960 as last sent to the worker
    let pending960 = false;        // whether pendingFen is a Chess960 position
    let searchBoard960 = null;     // the Chess960 board being searched, to spot castling moves
    // A failed load or a crashed worker is retried a few times before giving up
    const ENGINE_RETRIES = 3;
    const ENGINE_RETRY_MS = 3000;
    let engineRetries = 0;

    async function createRemoteWorker() {
        let src = await fetchText(REMOTE_JS);
        let blobUrl = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
        let bytes = await idbGet('sf18-wasm');
        if (!bytes) {
            bytes = await fetchBytes(REMOTE_WASM);
            await idbPut('sf18-wasm', bytes);
        }
        let wasmRef = URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
        return new Worker(blobUrl + "#" + wasmRef);
    }

    async function sha256(data) {
        let digest = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data);
        return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function createVariantWorker() {
        let [src, bytes] = await Promise.all([fetchText(MV_JS), fetchBytes(MV_WASM)]);
        if (await sha256(src) !== MV_SHA256.js || await sha256(bytes) !== MV_SHA256.wasm) {
            throw new Error('variant engine files do not match their pinned hashes');
        }
        // The loader looks for stockfish.wasm beside itself, which a blob worker
        // has not got, so it reads the wasm blob from the worker URL hash instead
        src = src.replace('locateFile:function(e){return e}', 'locateFile:function(){return self.location.hash.slice(1)}');
        let blobUrl = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
        let wasmRef = URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
        return new Worker(blobUrl + "#" + wasmRef);
    }

    // Fairy-Stockfish's module and this UCI bridge run in one blob module
    // worker, and its threads start from the same blob, so nothing is
    // imported past the page's script policy. The bridge loads the variant's
    // network before passing UCI commands on; a failed start is thrown from
    // a timer so it reaches the worker's onerror.
    const FSF_BRIDGE = `
if (globalThis.name !== 'em-pthread') {
    let queue = [], sf = null;
    self.onmessage = async e => {
        if (e.data && e.data.boot) {
            let b = e.data.boot;
            try {
                sf = await Fsf_14_Web({ locateFile: () => b.wasm, mainScriptUrlOrBlob: import.meta.url });
                sf.listen = line => postMessage(line);
                sf.onError = line => postMessage('info string ' + line);
                sf.uci('setoption name UCI_Variant value ' + b.variant);
                sf.setNnueBuffer(new Uint8Array(b.nnue), 0);
                queue.forEach(c => sf.uci(c));
                queue = null;
            } catch (err) {
                setTimeout(() => { throw err; });
            }
        } else if (queue) queue.push(e.data);
        else sf.uci(e.data);
    };
}`;

    // A variant's network: fetched once, checked against the hash in its name, then kept in IndexedDB
    async function loadNnue(name) {
        let bytes = await idbGet('nnue-' + name);
        if (bytes) return bytes;
        bytes = await fetchBytes(NNUE_URL + name + '.nnue');
        if (!(await sha256(bytes)).startsWith(name.split('-').pop())) {
            throw new Error('network ' + name + ' does not match its name');
        }
        await idbPut('nnue-' + name, bytes);
        return bytes;
    }

    let fsfUsable = () => !fsfBroken && self.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';

    async function createFsfWorker(variant) {
        let rules = Object.values(LI_VARIANTS).find(v => v.uci === variant);
        let [src, wasm, nnue] = await Promise.all([fetchText(FSF_JS), fetchBytes(FSF_WASM), loadNnue(rules.nnue)]);
        if (await sha256(src) !== FSF_SHA256.js || await sha256(wasm) !== FSF_SHA256.wasm) {
            throw new Error('Fairy-Stockfish files do not match their pinned hashes');
        }
        let blobUrl = URL.createObjectURL(new Blob([src + FSF_BRIDGE], { type: "text/javascript" }));
        let wasmRef = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
        let w = new Worker(blobUrl, { type: "module" });
        w.postMessage({ boot: { wasm: wasmRef, nnue, variant } }, [nnue]);
        return w;
    }

    function wireEngine(w) {
        w.onmessage = e => {
            if (engine !== w) return;  // a replaced worker must not touch the arrows
            let str = String(e.data || "");
            if (str === "uciok") {
                w.postMessage("setoption name MultiPV value 3");
                if (engineVariant === 'chess') {
                    w.postMessage("setoption name Threads value 1");
                    w.postMessage("setoption name Hash value 64");
                    w.postMessage("setoption name Use NNUE value true");
                } else if (engineFsf) {
                    // "uci" resets the variant chosen at boot (the network stays loaded),
                    // so it is set again, as lichess does; half the cores, at most four
                    let threads = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
                    w.postMessage("setoption name UCI_Variant value " + engineVariant);
                    w.postMessage("setoption name Threads value " + threads);
                    w.postMessage("setoption name Hash value 64");
                } else {
                    // SF10 has one fixed thread and hash, and setting Threads hangs it;
                    // like lichess, it calls antichess giveaway
                    w.postMessage("setoption name UCI_Variant value " + (engineVariant === 'antichess' ? 'giveaway' : engineVariant));
                }
                w.postMessage("isready");
                return;
            }
            if (str === "readyok") {
                clearTimeout(bootTimer);
                engineReady = true;
                engineRetries = 0;
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
                    let sign = searchTurn === 'w' ? 1 : -1;
                    setScore(cp ? +cp[1] * sign : null, mate ? +mate[1] * sign : null, engineFlip);
                }
                render(engineFlip);
            }
        };
        w.onerror = () => {
            w.terminate();
            if (engine !== w) return;
            if (engineFsf) fsfBroken = true;
            engine = null;
            engineReady = false;
            searching = false;
            ignoreInfo = false;
            engineFailedOnce();
        };
    }

    // Retry a failed load or crashed worker; when retries run out, chess.com
    // falls back to its own engine once, everywhere else the engine gives up
    function engineFailedOnce() {
        clearTimeout(bootTimer);
        if (!iv) return;
        if (engineRetries < ENGINE_RETRIES) {
            engineRetries++;
            let btn = document.getElementById("sa-btn");
            if (btn) btn.innerHTML = "Restarting engine…";
            clearTimeout(retryTimer);
            retryTimer = setTimeout(ensureEngine, ENGINE_RETRY_MS);
            return;
        }
        if (SITE === 'chesscom' && !usingFallback) {
            usingFallback = true;
            engineRetries = 0;
            // deferred: a failing start is still holding engineStarting here
            clearTimeout(retryTimer);
            retryTimer = setTimeout(ensureEngine, 0);
            return;
        }
        engineFailed = true;
        let btn = document.getElementById("sa-btn");
        if (btn) btn.innerHTML = "Engine unavailable (press A twice to retry)";
    }

    function startWorker(w, bootMs) {
        engine = w;
        engineReady = false;
        engine960 = false;
        wireEngine(w);
        clearTimeout(bootTimer);
        bootTimer = setTimeout(() => {
            if (!engineReady && engine === w) w.onerror(new Event('error'));
        }, bootMs);
        w.postMessage("uci");
    }

    async function ensureEngine() {
        if (engine || engineFailed || engineStarting || !iv) return;
        engineStarting = true;
        let variant = engineVariant;
        let fsf = variant !== 'chess' && fsfUsable();
        let btn = document.getElementById("sa-btn");
        if (btn && !usingFallback) btn.innerHTML = variant === 'chess' ? "Loading engine… (one-time ~113MB)"
            : fsf ? "Loading variant engine… (one-time, up to ~59MB)" : "Loading variant engine…";
        try {
            let w = usingFallback ? new Worker(CC_FALLBACK)
                : variant === 'chess' ? await createRemoteWorker()
                : fsf ? await createFsfWorker(variant) : await createVariantWorker();
            // the analyzer stopped, or a game of another variant came up, while loading
            if (!iv || variant !== engineVariant) { w.terminate(); return; }
            engineFsf = fsf;
            startWorker(w, usingFallback ? 20000 : fsf ? 60000 : 300000);
        } catch (e) {
            // a Fairy-Stockfish that cannot load leaves the variants to SF10
            if (fsf) fsfBroken = true;
            // a failed load of a variant nobody wants any more is not a strike against the new one
            if (variant === engineVariant) engineFailedOnce();
        } finally {
            engineStarting = false;
            if (variant !== engineVariant) ensureEngine();
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
        searchTurn = f.split(' ')[1];
        if (pending960 !== engine960) {
            engine960 = pending960;
            engine.postMessage("setoption name UCI_Chess960 value " + engine960);
        }
        searchBoard960 = engine960 ? parsePlacement(f.split(' ')[0]) : null;
        engine.postMessage("position fen " + f);
        engine.postMessage("go infinite");
    }

    function analyzeWorker(fen, flip, variant, chess960) {
        // a worker plays one variant, so a game of another variant gets a fresh one
        if (variant !== engineVariant) {
            stopEngine();
            engineVariant = variant;
            engineFailed = false;
            engineRetries = 0;
        }
        engineFlip = flip;
        pendingFen = fen;
        pending960 = chess960;
        ensureEngine();
        pump();
    }

    // Nothing valid to analyze: end the current search so stale arrows don't return
    function idleEngine() {
        pendingFen = null;
        if (engine && searching) {
            ignoreInfo = true;
            engine.postMessage("stop");
        }
    }

    function stopEngine() {
        clearTimeout(bootTimer);
        clearTimeout(retryTimer);
        engine?.terminate();
        engine = null;
        engineReady = false;
        searching = false;
        ignoreInfo = false;
        pendingFen = null;
    }

    // ------------------------------------------------------- position check
    // Boards read mid-animation or with a misread turn can be impossible;
    // the engine answers those with no move, so screen them first.

    function parsePlacement(placement) {
        let rows = placement.split('/');
        if (rows.length !== 8) return null;
        let board = [];
        for (let row of rows) {
            let cells = [];
            for (let ch of row) {
                if (/\d/.test(ch)) for (let k = 0; k < +ch; k++) cells.push('');
                else cells.push(ch);
            }
            if (cells.length !== 8) return null;
            board.push(cells);
        }
        return board;
    }

    // Is the square at (row, col) — row 0 is rank 8 — attacked by that color?
    function attackedBy(board, r, c, white) {
        let at = (rr, cc) => (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) ? board[rr][cc] : null;
        let is = (p, type) => !!p && (p === p.toUpperCase()) === white && p.toLowerCase() === type;
        let pawnRow = white ? r + 1 : r - 1;
        if (is(at(pawnRow, c - 1), 'p') || is(at(pawnRow, c + 1), 'p')) return true;
        for (let [dr, dc] of [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]) {
            if (is(at(r + dr, c + dc), 'n')) return true;
        }
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if ((dr || dc) && is(at(r + dr, c + dc), 'k')) return true;
            }
        }
        for (let [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            let sliders = dr && dc ? 'bq' : 'rq';
            for (let k = 1; k < 8; k++) {
                let p = at(r + dr * k, c + dc * k);
                if (p === null) break;
                if (!p) continue;
                if (sliders.split('').some(t => is(p, t))) return true;
                break;
            }
        }
        return false;
    }

    // The FEN to analyze, or null when the board cannot be a real position.
    // Only the side to move can be in check, so a check fixes a misread turn.
    function playableFen(fen, rules = STANDARD) {
        let [placement, turn, ...rest] = fen.split(' ');
        // a crazyhouse pocket follows the placement in brackets
        let board = parsePlacement(placement.replace(/\[.*\]$/, ''));
        if (!board) return null;
        let kings = { K: [], k: [] };
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                let p = board[r][c];
                if (p === 'K' || p === 'k') kings[p].push([r, c]);
                if (p === 'p' && (r === 0 || r === 7)) return null;
                if (p === 'P' && (r === 0 || (r === 7 && !rules.firstRankPawns))) return null;
            }
        }
        if (rules.kings && (kings.K.length !== rules.kings[0] || kings.k.length !== rules.kings[1])) return null;
        if (rules.check === 'none') return fen;
        // atomic kings that touch cannot take each other, so neither is in check
        let touching = kings.K.length === 1 && kings.k.length === 1
            && Math.abs(kings.K[0][0] - kings.k[0][0]) <= 1 && Math.abs(kings.K[0][1] - kings.k[0][1]) <= 1;
        let inCheck = (own, byWhite) => own.length === 1 && !(rules.check === 'atomic' && touching)
            && attackedBy(board, own[0][0], own[0][1], byWhite);
        let whiteInCheck = inCheck(kings.K, false);
        let blackInCheck = inCheck(kings.k, true);
        if (whiteInCheck && blackInCheck) return null;
        if (rules.check === 'never' && (whiteInCheck || blackInCheck)) return null;
        if (whiteInCheck) turn = 'w';
        else if (blackInCheck) turn = 'b';
        return [placement, turn, ...rest].join(' ');
    }

    // --------------------------------------------------------------- chess960
    // A Chess960 side may castle with a rook while its king and that rook
    // still stand where they started, so the rights come from the game's
    // start position, which each site's game API names. One lookup per game.

    // Shredder-FEN rights (rook file letters, outer rook first)
    function castling960(placement, startFen) {
        let now = parsePlacement(placement), start = parsePlacement(startFen.split(' ')[0]);
        if (!now || !start) return '-';
        let rights = '';
        for (let [row, king, rook, fileA] of [[7, 'K', 'R', 65], [0, 'k', 'r', 97]]) {
            let kingFile = start[row].indexOf(king);
            if (kingFile < 0 || now[row][kingFile] !== king) continue;
            for (let f = 7; f >= 0; f--) {
                if (start[row][f] === rook && now[row][f] === rook) rights += String.fromCharCode(fileA + f);
            }
        }
        return rights || '-';
    }

    // The game to ask about, as { id, url, read }: read takes the response and
    // gives the start FEN, or null for a game that is not Chess960
    function game960() {
        if (SITE === 'lichess') {
            // lichess names the variant on the page, so other games need no lookup;
            // the analysis board, studies and broadcasts are not games
            if (!document.querySelector('.round__app.variant-chess960, main.analyse.variant-chess960')) return null;
            if (/^\/(analysis|study|broadcast)\b/.test(location.pathname)) return null;
            let id = location.pathname.match(/^\/(?:game\/)?(\w{8})/)?.[1];
            return id && {
                id,
                url: '/game/export/' + id + '?moves=false',
                read: r => r.text().then(pgn => pgn.match(/\[FEN "([^"]+)"\]/)?.[1] || null)
            };
        }
        if (SITE === 'chesscom') {
            let m = location.pathname.match(/\/game\/(?:(live|daily)\/)?(\d+)/);
            return m && {
                id: m[2],
                url: '/callback/' + (m[1] || 'live') + '/game/' + m[2],
                read: r => r.json().then(d => d?.game?.type === 'chess960' && d.game.initialSetup || null)
            };
        }
        return null;
    }

    // A few tries a few seconds apart, a minute after "too many requests";
    // a game that never answers is treated as standard chess
    const START960_TRIES = 3;
    const START960_RETRY_MS = 5000;
    const START960_BUSY_MS = 60000;
    let start960 = { id: '', fen: null, known: false, inFlight: false, tries: 0, retryAt: 0 };

    // The current game's Chess960 start FEN; null for other games and until it is known
    function chess960Start() {
        if (SITE === 'endgame') return egSecret.start960;
        let game = game960();
        if (!game) return null;
        if (start960.id !== game.id) start960 = { id: game.id, fen: null, known: false, inFlight: false, tries: 0, retryAt: 0 };
        let state = start960;
        if (!state.known && !state.inFlight && Date.now() >= state.retryAt) {
            state.inFlight = true;
            state.retryAt = Date.now() + START960_RETRY_MS;
            fetch(game.url)
                .then(r => {
                    if (r.status === 404) return null;
                    if (r.status === 429) state.retryAt = Date.now() + START960_BUSY_MS;
                    return r.ok ? game.read(r) : undefined;
                })
                .catch(() => undefined)
                .then(fen => {
                    if (fen !== undefined) state.fen = fen;
                    state.known = fen !== undefined || ++state.tries >= START960_TRIES;
                })
                .finally(() => { state.inFlight = false; });
        }
        return state.fen;
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

        // A fresh start retries everything, including an engine that gave up
        engineFailed = false;
        usingFallback = false;
        engineRetries = 0;
        btn.innerHTML = "Stop Analyzer";
        moves = []; ponder = "";
        let fen = "", flipped = null;

        iv = setInterval(() => {
            let pos = readBoard();
            if (!pos) return;
            // a variant no engine here plays gets no arrows rather than wrong ones
            if (pos.unsupported) {
                let note = "Variant not supported: " + pos.unsupported;
                if (fen !== note) {
                    fen = note;
                    idleEngine();
                    moves = []; ponder = "";
                    document.getElementById("sa-arrows")?.remove();
                    btn.innerHTML = note;
                }
                return;
            }
            ensureOverlay(pos.board);

            // Flipping keeps the FEN, so redraw for the new orientation without restarting the search.
            if (pos.flipped !== flipped) {
                flipped = pos.flipped;
                engineFlip = flipped;
                render(flipped);
            }

            // Chess960 castling rights come from the start position; pos.fen
            // itself stays as read, since the relay sends it on
            let rules = pos.rules || STANDARD;
            let start = rules.uci === 'chess' ? chess960Start() : null;
            let posFen = pos.fen;
            if (start) {
                let f = posFen.split(' ');
                f[2] = castling960(f[0], start);
                posFen = f.join(' ');
            }
            if (posFen === fen) return;

            fen = posFen;
            moves = []; ponder = "";
            render(pos.flipped);
            let playable = playableFen(fen, rules);
            if (playable) analyzeWorker(playable, pos.flipped, rules.uci, !!start);
            else idleEngine();
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
        } else if (SITE === 'endgame') {
            bottom = t('.widget-bottom-player .gp-username');
            top = t('.widget-top-player .gp-username');
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
        if (SITE === 'endgame') return !!document.querySelector('.finish-game-overlay');
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
        // Lets the web app load the finished game from endgame.ai by id
        let gameId = SITE === 'endgame' ? location.pathname.match(/^\/game\/([\w-]+)/)?.[1] : undefined;
        publish({ v: 1, type: 'pos', site: SITE, gameId, fen: pos.fen, moves: playedMoves, white: players.white, black: players.black, bottom: players.bottom, ts: Date.now() });
        return true;
    }

    // Variant games stay out of the relay: the web app reads every position as standard chess
    function readRelayBoard() {
        let pos = readBoard();
        return pos && !pos.unsupported && (pos.rules || STANDARD) === STANDARD ? pos : null;
    }

    function refreshRelayMoves(fen) {
        let pos = readRelayBoard();
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
            let pos = readRelayBoard();
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
        const pos = readRelayBoard();
        if (pos && !isGameOver()) publishRelayPosition(pos, true);
    }, 2000);

    // --------------------------------------------------------------------- ui

    function mountUI() {
        // Analyzer button
        if (!document.getElementById("sa-wrap")) {
            let variantsBoard = SITE === 'chesscom' && document.querySelector('.TheBoard-layers');
            if (SITE === 'chesscom' && !variantsBoard) {
                let host = document.querySelector(".board-layout-main");
                if (host) {
                    host.insertAdjacentHTML('afterbegin', `<div id="sa-wrap" style="display:flex;padding:10px;background:var(--globalBackgroundDark);border-radius:5px;margin-bottom:10px;"><button id="sa-btn" class="ui_v5-button-component ui_v5-button-primary" style="flex:1">Start Analyzer (Hotkey: A)</button></div>`);
                    document.getElementById("sa-btn").onclick = e => toggle(e.currentTarget);
                }
            } else if (variantsBoard || (SITE === 'endgame' ? findBoardEG() : SITE === 'lichess' && document.querySelector('cg-board'))) {
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
