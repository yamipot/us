// ==UserScript==
// @name         GBF auto-copy battle ID
// @version      0.1.2
// @description  Copy rescue IDs and fill valid clipboard IDs when the entry field is focused.
// @match        https://game.granbluefantasy.jp/*
// @grant        GM_setClipboard
// @sandbox      DOM
// @inject-into  content
// @run-at       document-start
// ==/UserScript==

// Copy the ID whenever the rescue popup appears.
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

document.addEventListener("focusin", async (event) => {
    const input = event.target;
    if (!input.matches(".prt-input-form .frm-battle-key") || input.value) return;

    try {
        const id = (await navigator.clipboard.readText()).trim();
        if (!/^[a-z0-9]{8}$/i.test(id)) return;
        // Clipboard access is asynchronous; preserve any typing or navigation since focus.
        if (!input.isConnected || document.activeElement !== input || input.value) return;
        input.value = id;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (error) {
        console.warn("[GBF auto ID] Could not read the clipboard.", error);
    }
});
