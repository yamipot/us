// ==UserScript==
// @name         X profile photos
// @version      0.1.2
// @description  Open the Photos filter when visiting an X profile.
// @match        https://x.com/*
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

(() => {
    let profilePath;
    let step = "profile";

    function replaceCurrentEntry(url) {
        const state = history.state;
        history.replaceState(state, "", url);
        // X's router listens for popstate, which replaceState does not fire.
        window.dispatchEvent(new PopStateEvent("popstate", { state }));
    }

    function selectPhotos() {
        const path = location.pathname.replace(/\/$/, "").toLowerCase();
        const currentProfile = path.match(/^\/\w{1,15}(?=\/|$)/)?.[0];
        if (currentProfile !== profilePath) {
            profilePath = currentProfile;
            step = "profile";
        }
        if (!profilePath || step === "done") return;

        const mediaPath = `${profilePath}/media`;
        const openingProfile = step === "profile";
        if (path !== (openingProfile ? profilePath : mediaPath)) return;
        if (!openingProfile && new URLSearchParams(location.search).has("filter")) {
            step = "done";
            return;
        }

        const mediaTab = document.querySelector(
            `main [role="tablist"] a[role="tab"][href="${mediaPath}" i]`,
        );
        if (!mediaTab || mediaTab.getAttribute("aria-selected") !== String(!openingProfile)) return;

        if (openingProfile) {
            step = "media";
            replaceCurrentEntry(mediaTab.href);
            return;
        }

        // X exposes the video/photo filter as a menu on the active Media tab.
        step = "done";
        if (mediaTab.getAttribute("aria-haspopup") !== "menu") return;

        const photosUrl = new URL(mediaTab.href);
        photosUrl.searchParams.set("filter", "photo");
        replaceCurrentEntry(photosUrl);
    }

    new MutationObserver(selectPhotos).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["href", "aria-selected", "aria-haspopup"],
    });
    window.addEventListener("popstate", selectPhotos);
    selectPhotos();
})();
