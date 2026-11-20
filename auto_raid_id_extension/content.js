(async () => {
    const settings = await chrome.storage.local.get({ autoCopy: true, pasteMode: "cdp_ctrl_v" });
    let copied = null;

    function copyRescueId() {
        if (!settings.autoCopy) return;
        const node = document.querySelector(".pop-start-assist.pop-show .prt-battle-id");
        if (!node) { copied = null; return; }
        const id = node.textContent.trim();
        if (id && node !== copied) {
            copied = node;
            navigator.clipboard.writeText(id).catch((error) => {
                console.warn("[GBF Battle ID] Could not copy the rescue ID.", error);
            });
        }
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.autoCopy) {
            settings.autoCopy = changes.autoCopy.newValue !== false;
            copied = null;
            copyRescueId();
        }
        if (changes.pasteMode) {
            settings.pasteMode = changes.pasteMode.newValue ?? "cdp_ctrl_v";
        }
    });

    new MutationObserver(copyRescueId).observe(document, {
        childList: true, subtree: true, attributes: true, attributeFilter: ["class"]
    });
    copyRescueId();

    document.addEventListener("focusin", (event) => {
        const mode = settings.pasteMode;
        const input = event.target;
        if (mode === "disable" || !input.matches(".prt-input-form .frm-battle-key") || input.value) return;
        setTimeout(async () => {
            try {
                if (!input.isConnected || document.activeElement !== input || input.value) return;
                const id = (await navigator.clipboard.readText()).trim();
                if (!/^[a-z0-9]{8}$/i.test(id)) return;
                // Clipboard access is asynchronous; preserve any typing or navigation since focus.
                if (!input.isConnected || document.activeElement !== input || input.value) return;
                if (mode === "cdp_ctrl_v") {
                    const response = await chrome.runtime.sendMessage({ type: "cdpCtrlV" });
                    if (!response.ok) throw new Error(response.error);
                } else if (mode === "paste_event" && !document.execCommand("paste")) {
                    console.warn("[GBF Battle ID] The browser rejected the paste command.");
                }
            } catch (error) {
                console.warn("[GBF Battle ID] Could not paste the battle ID.", error);
            }
        }, 100 + Math.floor(Math.random() * 201));
    });
})();
