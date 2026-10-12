const attachedTabs = new Set();

chrome.debugger.onDetach.addListener(({ tabId }) => attachedTabs.delete(tabId));

export async function pasteWithCdp(tabId) {
    const target = { tabId };
    if (!attachedTabs.has(tabId)) {
        await chrome.debugger.attach(target, "1.3");
        attachedTabs.add(tabId);
    }
    const keys = [
        ["rawKeyDown", "Control", "ControlLeft", 17, 2],
        ["rawKeyDown", "v", "KeyV", 86, 2],
        ["keyUp", "v", "KeyV", 86, 2],
        ["keyUp", "Control", "ControlLeft", 17, 0]
    ];
    for (const [type, key, code, windowsVirtualKeyCode, modifiers] of keys) {
        await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            type, key, code, windowsVirtualKeyCode, modifiers
        });
    }
}
