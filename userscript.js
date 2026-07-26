// ==UserScript==
// @name         Chess Analyzer
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Chess Analyzer
// @author       Peenjeee
// @match        https://www.chess.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    let engine, iv, fen = "", moves = [], ponder = "";
    let currentTurn = "w"; 

    let getBoard = () => document.querySelector(".board-layout-main wc-chess-board") || document.querySelector("wc-chess-board");

    let getVP = (b, sq) => {
        let nodes = b.querySelectorAll(`.piece.${sq}`);
        for(let p of nodes) {
            if(p.style.display === 'none' || p.style.opacity === '0' || p.style.visibility === 'hidden') continue;
            if(p.classList.contains('ghost') || p.classList.contains('hint')) continue;
            return p;
        }
        return null;
    };

    function getFen() {
        let f = "";
        let lastMovedColor = null;
        let b = getBoard();
        if (!b) return "";
        
        let highlightCount = b.querySelectorAll('.highlight').length;
        let pieceMap = {};
        for (let p of b.querySelectorAll('.piece')) {
            if(p.style.display === 'none' || p.style.opacity === '0' || p.style.visibility === 'hidden') continue;
            if(p.classList.contains('ghost') || p.classList.contains('hint')) continue;
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
        
        if (lastMovedColor === 'w') currentTurn = 'b';
        else if (lastMovedColor === 'b') currentTurn = 'w';
        
        return f.replace(/1+/g, match => match.length);
    }

    function draw(m, i) {
        if (!m || m.length < 4) return "";
        let b = getBoard();
        let flip = b?.classList.contains("flipped");
        let c = (f, r) => { 
            let x = {a:1,b:2,c:3,d:4,e:5,f:6,g:7,h:8}[f], y = +r; 
            if (!x || isNaN(y)) return null;
            if (flip) { x=9-x; y=9-y; } 
            return {x: (x-1)*12.5+6.25, y: (8-y)*12.5+6.25}; 
        };
        let p1 = c(m[0], m[1]), p2 = c(m[2], m[3]);
        if (!p1 || !p2) return "";
        let col = ["#3b82f6", "#ef4444", "#22c55e", "#a855f7"][i];
        let sqStart = `square-${{a:1,b:2,c:3,d:4,e:5,f:6,g:7,h:8}[m[0]]}${m[1]}`;
        let pNode = b ? getVP(b, sqStart) : null;
        let isK = pNode ? pNode.className.match(/\b[bw]n\b/) : false;
        let d = isK ? `M ${p1.x} ${p1.y} L ${p1.x} ${p2.y} L ${p2.x} ${p2.y}` : `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
        return `<path d="${d}" fill="none" stroke="${col}" stroke-width="${i<3?1.5:1}" stroke-opacity="0.9" stroke-linejoin="round" ${i===3?'stroke-dasharray="2,1"':''} marker-end="url(#arr-${i<3?i:'p'})" />`;
    }

    function render() {
        let svg = document.getElementById("sa-arrows");
        if (!svg) return;
        svg.innerHTML = `<defs>${["#3b82f6", "#ef4444", "#22c55e", "#a855f7"].map((c,i)=>`<marker id="arr-${i<3?i:'p'}" orient="auto" markerWidth="4" markerHeight="4" refX="3" refY="2"><polygon points="0,0 4,2 0,4" fill="${c}"/></marker>`).join('')}</defs>` 
            + (ponder ? draw(ponder, 3) : "") + [2,1,0].map(i => draw(moves[i], i)).join("");
    }

    function toggle(btn) {
        if (iv) {
            clearInterval(iv);
            engine?.terminate();
            iv = engine = null;
            document.getElementById("sa-arrows")?.remove();
            btn.innerHTML = "Start Analyzer (Hotkey: A)";
            return;
        }
        
        let b = getBoard();
        b?.insertAdjacentHTML('beforeend', `<svg id="sa-arrows" viewBox="0 0 100 100" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:100;"></svg>`);
        
        let startEngine = (targetFen) => {
            if (engine) engine.terminate();
            // Using chess.com's internal stockfish worker
            engine = new Worker("/bundles/app/js/vendor/jschessengine/stockfish.asm.1abfa10c.js");
            engine.postMessage("uci");
            engine.postMessage("setoption name MultiPV value 3");
            engine.postMessage("setoption name Use NNUE value true");
            
            engine.onmessage = e => {
                let str = e.data;
                if (str.startsWith("info ")) {
                    let mPV = str.match(/multipv (\d+).* pv (.*)/);
                    if (mPV) {
                        let idx = +mPV[1] - 1;
                        let pvList = mPV[2].trim().split(" ");
                        moves[idx] = pvList[0];
                        if (idx === 0) {
                            ponder = pvList.length > 1 ? pvList[1] : "";
                            let mate = str.match(/score mate (-?\d+)/);
                            let cp = str.match(/score cp (-?\d+)/);
                            let bg = "#6b7280"; 
                            
                            let b = getBoard();
                            let flip = b?.classList.contains("flipped");
                            
                            let wMate = mate ? (+mate[1] * (currentTurn === 'w' ? 1 : -1)) : null;
                            let wCp = cp ? (+cp[1] * (currentTurn === 'w' ? 1 : -1)) : null;
                            let uScore = flip ? (wMate !== null ? -wMate : -wCp) : (wMate !== null ? wMate : wCp);
                            
                            if (wMate !== null) {
                                bg = uScore > 0 ? "#22c55e" : "#ef4444";
                            } else if (wCp !== null) {
                                bg = uScore > 30 ? "#22c55e" : (uScore < -30 ? "#ef4444" : "#6b7280");
                            }
                            
                            let scStr = "";
                            if (wMate !== null) {
                                scStr = (uScore > 0 ? "+M" : "-M") + Math.abs(uScore);
                            } else if (wCp !== null) {
                                if (uScore === 0) scStr = "0.0";
                                else scStr = (uScore > 0 ? "+" : "") + (uScore / 100).toFixed(1);
                            }

                            if (scStr) {
                                let span = btn.querySelector('span');
                                if (span) {
                                    span.style.background = bg;
                                    span.innerHTML = scStr;
                                } else {
                                    btn.innerHTML = `Stop Analyzer <span style="background:${bg};color:white;padding:2px 6px;border-radius:4px;margin-left:5px">${scStr}</span>`;
                                }
                            }
                        }
                        render();
                    }
                }
            };
            
            if (targetFen) {
                engine.postMessage(`position fen ${targetFen}`);
                engine.postMessage("go depth 50");
            }
        };

        startEngine();
        btn.innerHTML = "Stop Analyzer";
        fen = ""; moves = []; ponder = "";
        let stableFen = "";
        let stableFrames = 0;
        
        iv = setInterval(() => {
            let rawFen = getFen(); 
            if (!rawFen) return;
            
            let b = getBoard();
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
            if (!castling) castling = "-";

            if (b && !document.getElementById("sa-arrows")) {
                b.insertAdjacentHTML('beforeend', `<svg id="sa-arrows" viewBox="0 0 100 100" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:100;"></svg>`);
            }

            let nf = rawFen + " " + currentTurn + " " + castling + " - 0 1";
            
            if (nf === fen) return; 
            
            if (nf !== stableFen) {
                stableFen = nf;
                stableFrames = 0;
                moves = []; ponder = "";
                render(); 
                return;
            }
            
            stableFrames++;
            if (stableFrames === 4) { 
                fen = nf;
                startEngine(fen);
            }
        }, 30);
    }

    let obs = new MutationObserver((m, o) => {
        let board = document.querySelector(".board-layout-main");
        if (!board) return;
        board.insertAdjacentHTML('afterbegin', `<div id="sa-wrap" style="display:flex;padding:10px;background:var(--globalBackgroundDark);border-radius:5px;margin-bottom:10px;"><button id="sa-btn" class="ui_v5-button-component ui_v5-button-primary" style="flex:1">Start Analyzer (Hotkey: A)</button></div>`);
        document.getElementById("sa-btn").onclick = e => toggle(e.currentTarget);
        o.disconnect();
    });
    obs.observe(document, {childList: true, subtree: true});

    document.addEventListener('keydown', e => {
        if (e.key.toLowerCase() === 'a' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
            let btn = document.getElementById("sa-btn");
            if (btn) btn.click();
        }
        if (e.key === 'Insert') {
            let wrap = document.getElementById("sa-wrap");
            if (wrap) wrap.style.display = wrap.style.display === 'none' ? 'flex' : 'none';
        }
    });

})();
