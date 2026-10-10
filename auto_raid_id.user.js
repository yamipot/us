// ==UserScript==
// @name         GBF auto-copy battle ID
// @match        https://game.granbluefantasy.jp/#raid_multi/*
// @grant        GM_setClipboard
// @sandbox      DOM
// @inject-into  content
// @run-at       document-start
// ==/UserScript==

// Runs in the isolated world and only reads the DOM: copy the ID whenever the rescue popup appears.
let copied = null;
new MutationObserver(() => {
    const node = document.querySelector(".pop-start-assist.pop-show .prt-battle-id");
    if (!node) { copied = null; return; }
    const id = node.textContent.trim();
    if (id && node !== copied) {
        copied = node;
        GM_setClipboard(id, "text");
    }
}).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
