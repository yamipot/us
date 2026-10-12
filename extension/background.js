import { pasteWithCdp } from "./cdp-paste.js";

const pasteModes = ["disable", "paste_event", "cdp_ctrl_v"];
const menuScope = {
    contexts: ["all"],
    documentUrlPatterns: ["https://game.granbluefantasy.jp/*"]
};

chrome.runtime.onInstalled.addListener(async () => {
    const settings = await chrome.storage.local.get({ autoCopy: true, pasteMode: "cdp_ctrl_v" });
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
        ...menuScope, id: "autoCopy", title: "Copy Battle ID",
        type: "checkbox", checked: settings.autoCopy
    });
    chrome.contextMenus.create({ ...menuScope, id: "autoPaste", title: "Paste Battle ID" });
    for (const mode of pasteModes) {
        chrome.contextMenus.create({
            ...menuScope, id: mode, parentId: "autoPaste", title: mode,
            type: "radio", checked: settings.pasteMode === mode
        });
    }
});

chrome.contextMenus.onClicked.addListener(async (info) => {
    if (info.menuItemId === "autoCopy") {
        await chrome.storage.local.set({ autoCopy: info.checked });
    } else if (pasteModes.includes(info.menuItemId)) {
        await chrome.storage.local.set({ pasteMode: info.menuItemId });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "cdpCtrlV" || sender.frameId !== 0 ||
        !sender.url?.startsWith("https://game.granbluefantasy.jp/")) return;
    pasteWithCdp(sender.tab.id).then(
        () => sendResponse({ ok: true }),
        (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
});
