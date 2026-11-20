// ==UserScript==
// @name         x_fly
// @version      0.1.0
// @description  Configure the starting profile tab and hide previously viewed posts on X Home and Lists.
// @match        https://x.com/*
// @grant        GM_addStyle
// @grant        GM_listValues
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setValues
// @grant        GM_download
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        unsafeWindow
// @noframes
// @run-at       document-idle
// ==/UserScript==

(() => {
const hideReadKey = "hideReadPosts";
const profileViewKey = "profileStartPage";
const defaultProfileView = "photo";

function savedReadIds() {
    return GM_listValues().filter((key) => /^\d+$/.test(key));
}

function setupProfileNavigation() {
    let profileView = GM_getValue(profileViewKey, defaultProfileView);
    let profilePath;
    let profileStep = "profile";
    let profileTimer = null;

    function replaceProfileEntry(url) {
        const state = history.state;
        history.replaceState(state, "", url);
        // X updates its routed view on popstate; replaceState alone only changes the address.
        window.dispatchEvent(new PopStateEvent("popstate", { state }));
    }

    function selectProfileView(isHistoryTraversal = false) {
        const path = location.pathname.replace(/\/$/, "").toLowerCase();
        const currentProfile = path.match(/^\/\w{1,15}(?=\/|$)(?!\/status(?:\/|$))/)?.[0];
        if (currentProfile !== profilePath) {
            profilePath = currentProfile;
            profileStep = "profile";
        }
        if (isHistoryTraversal) profileStep = "done";
        if (!profilePath || profileStep === "done") return;

        const openingProfile = profileStep === "profile";
        const mediaPath = `${profilePath}/media`;
        if (path !== (openingProfile ? profilePath : mediaPath)) return;
        if (openingProfile && profileView === "home") {
            profileStep = "done";
            return;
        }
        if (!openingProfile && new URLSearchParams(location.search).has("filter")) {
            profileStep = "done";
            return;
        }

        const mediaTab = document.querySelector(
            `main [role="tablist"] a[role="tab"][href="${mediaPath}" i]`,
        );
        if (!mediaTab || mediaTab.getAttribute("aria-selected") !== String(!openingProfile)) return;
        if (openingProfile) {
            profileStep = profileView === "photo" ? "media" : "done";
            replaceProfileEntry(mediaTab.href);
            return;
        }

        profileStep = "done";
        if (mediaTab.getAttribute("aria-haspopup") !== "menu") return;
        const url = new URL(mediaTab.href);
        url.searchParams.set("filter", "photo");
        replaceProfileEntry(url);
    }

    function scheduleProfileNavigation() {
        // X can render before all popstate listeners have received a Back/Forward event.
        profileTimer ??= setTimeout(() => {
            profileTimer = null;
            selectProfileView();
        }, 0);
    }

    GM_addValueChangeListener(profileViewKey, (_key, _old, value) => { profileView = value; });
    new MutationObserver(scheduleProfileNavigation).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["href", "aria-selected", "aria-haspopup"],
    });
    window.addEventListener("popstate", (event) => {
        // Browser Back/Forward restores the entry. Synthetic popstate refreshes X's router.
        if (event.isTrusted) selectProfileView(true);
        scheduleProfileNavigation();
    });
    const navigationTiming = performance.getEntriesByType("navigation")[0];
    selectProfileView(navigationTiming?.type === "back_forward");
}

function setupReadPostHiding() {
    const cellSelector = '[data-testid="cellInnerDiv"]';
    const cardSelector = `main [data-testid="primaryColumn"] ${cellSelector} article[data-testid="tweet"]`;
    const hiddenClass = "yami-read-post-hidden";
    const hideBatchSize = 50;
    const saveBatchSize = 30;
    const readIds = new Set();
    const initialHiddenIds = new Set();
    const collapsedIds = new Set();
    const pendingIds = new Set();
    const partialViews = new Map();
    const mountedCards = new Map();
    const visibleCards = new Set();
    const hiddenNotices = new Map();
    const revealedIds = new Set();
    const viewport = window.visualViewport;
    const hideMoreButton = document.createElement("button");
    hideMoreButton.id = "yami-x-hide-more";
    hideMoreButton.type = "button";
    hideMoreButton.textContent = `+${hideBatchSize}`;
    hideMoreButton.title = `Hide ${hideBatchSize} more read posts`;
    hideMoreButton.setAttribute("aria-label", hideMoreButton.title);
    hideMoreButton.hidden = true;
    const saveReadsButton = document.createElement("button");
    const readCountText = document.createTextNode("0");
    saveReadsButton.id = "yami-x-save-reads";
    saveReadsButton.type = "button";
    saveReadsButton.append(readCountText);
    let hideRead = GM_getValue(hideReadKey, false);
    let remainingHides = hideBatchSize;
    let readCount = 0;
    let hideStart = null;
    let menuId;
    let frame = null;
    let scanPending = true;
    let activeFeed = null;

    function loadReadIds() {
        for (const id of savedReadIds()) {
            readIds.add(id);
            partialViews.delete(id);
        }
    }

    function updateReadCountButton() {
        readCountText.data = String(readCount);
        saveReadsButton.title = `Save read posts (${pendingIds.size} pending)`;
        saveReadsButton.setAttribute("aria-label", `${readCount} read posts. ${saveReadsButton.title}`);
    }

    function flushReadIds() {
        if (!pendingIds.size) return true;

        try {
            // Write independent ID keys so concurrent tabs can commit without replacing each other's batches.
            GM_setValues(Object.fromEntries([...pendingIds].map((id) => [id, true])));
            pendingIds.clear();
            return true;
        } catch (error) {
            console.warn("[x_fly] Could not save read IDs.", error);
            return false;
        }
    }

    function feedPath() {
        const path = location.pathname;
        return /^\/(?:home\/?|i\/lists\/\d+\/?)?$/.test(path) ? path : null;
    }

    function createHiddenNotice() {
        const details = document.createElement("details");
        details.className = "yami-x-read-notice";
        details.innerHTML = `
            <summary></summary>
            <form>
                <label>From
                    <select name="direction">
                        <option value="first">First</option>
                        <option value="last">Last</option>
                    </select>
                </label>
                <label>Count <input name="count" type="number" min="1" step="1" value="1" required></label>
                <button type="submit">Show</button>
            </form>
        `;
        const form = details.querySelector("form");
        const direction = form.elements.namedItem("direction");
        const count = form.elements.namedItem("count");
        const notice = { details, summary: details.querySelector("summary"), count, articles: [] };

        form.addEventListener("submit", (event) => {
            event.preventDefault();
            const amount = count.valueAsNumber;
            if (!Number.isSafeInteger(amount) || amount < 1) return;

            const available = notice.articles.filter((article) => {
                const id = mountedCards.get(article);
                return id && article.isConnected && article.classList.contains(hiddenClass) && postId(article) === id;
            });
            const selected = direction.value === "first" ? available.slice(0, amount) : available.slice(-amount);
            for (const article of selected) {
                const id = mountedCards.get(article);
                revealedIds.add(id);
                updateHidden(article, id);
            }
            details.open = false;
            refreshHiddenNotices(document.querySelectorAll(cardSelector));
            if (details.isConnected) notice.summary.focus({ preventScroll: true });
        });
        return notice;
    }

    function refreshHiddenNotices(articles) {
        const groups = new Map();
        let group;
        let previousCell;
        for (const article of articles) {
            if (!article.classList.contains(hiddenClass)) continue;
            const cell = article.closest(cellSelector);
            if (previousCell?.nextElementSibling !== cell) {
                group = [];
                groups.set(cell, group);
            }
            group.push(article);
            previousCell = cell;
        }

        for (const [cell, notice] of hiddenNotices) {
            if (!groups.has(cell)) {
                notice.details.remove();
                hiddenNotices.delete(cell);
            }
        }
        for (const [cell, groupArticles] of groups) {
            let notice = hiddenNotices.get(cell);
            if (!notice) {
                notice = createHiddenNotice();
                hiddenNotices.set(cell, notice);
            }
            notice.articles = groupArticles;
            const count = groupArticles.length;
            const message = count === 1 ? "1 read post hidden" : `${count} read posts hidden`;
            if (notice.summary.textContent !== message) notice.summary.textContent = message;
            if (notice.count.max !== String(count)) notice.count.max = String(count);
            if (notice.count.valueAsNumber > count) notice.count.value = String(count);
            // X keeps ownership of its tweet and virtual list cell. Only append our own notice.
            if (notice.details.parentElement !== cell) cell.append(notice.details);
        }
    }

    function postId(article) {
        const author = article.querySelector('[data-testid="User-Name"]');
        const link = author?.querySelector('a[href*="/status/"] time')?.closest("a");
        return link?.pathname.match(/^\/[^/]+\/status\/(\d+)\/?$/)?.[1];
    }

    function updateHidden(article, id) {
        article.classList.toggle(hiddenClass, hideRead && collapsedIds.has(id) && !revealedIds.has(id));
    }

    function cellTop(article) {
        return article.closest(cellSelector).getBoundingClientRect().top + window.scrollY;
    }

    function useHideQuota(articles) {
        if (!hideRead || remainingHides === 0) return;

        let firstMounted = null;
        if (hideStart) {
            firstMounted = [...articles].find((article) => mountedCards.get(article) === hideStart.id);
            if (firstMounted) hideStart.top = cellTop(firstMounted);
        }

        let reachedStart = !firstMounted;
        for (const article of articles) {
            if (article === firstMounted) reachedStart = true;
            if (!reachedStart) continue;
            const id = mountedCards.get(article);
            if (!initialHiddenIds.has(id) || collapsedIds.has(id) || revealedIds.has(id)) continue;
            // X can unmount the start cell when the timeline moves. Keep its last document position.
            if (hideStart && !firstMounted && cellTop(article) < hideStart.top) continue;
            collapsedIds.add(id);
            remainingHides -= 1;
            if (remainingHides === 0) break;
        }
    }

    function releaseCard(article) {
        mountedCards.delete(article);
        visibleCards.delete(article);
        intersectionObserver.unobserve(article);
        resizeObserver.unobserve(article);
        article.classList.remove(hiddenClass);
    }

    function reconcileCards() {
        const articles = new Set(document.querySelectorAll(cardSelector));
        for (const article of mountedCards.keys()) {
            if (!articles.has(article)) releaseCard(article);
        }

        for (const article of articles) {
            const id = postId(article);
            const previousId = mountedCards.get(article);
            if (id === previousId) continue;
            if (!id) {
                releaseCard(article);
                continue;
            }
            mountedCards.set(article, id);
            if (!previousId) {
                intersectionObserver.observe(article);
                resizeObserver.observe(article);
            }
        }
        useHideQuota(articles);
        for (const article of articles) updateHidden(article, mountedCards.get(article));
        refreshHiddenNotices(articles);
    }

    function measureVisibleCards() {
        const top = viewport.offsetTop;
        const bottom = top + viewport.height;
        const left = viewport.offsetLeft;
        const right = left + viewport.width;

        for (const article of visibleCards) {
            const id = mountedCards.get(article);
            if (!id || readIds.has(id)) continue;

            const rect = article.getBoundingClientRect();
            const visibleLeft = Math.max(left, rect.left);
            const visibleRight = Math.min(right, rect.right);
            if (visibleRight <= visibleLeft || rect.height <= 2 || rect.bottom <= top || rect.top >= bottom) continue;

            const center = (visibleLeft + visibleRight) / 2;
            const progress = partialViews.get(id) ?? { topSeen: false, bottomSeen: false };
            // Sample just inside each edge to exclude cards covered by X's sticky bars or dialogs.
            progress.topSeen ||= rect.top >= top && rect.top + 1 < bottom
                && article.contains(document.elementFromPoint(center, rect.top + 1));
            progress.bottomSeen ||= rect.bottom <= bottom && rect.bottom - 1 > top
                && article.contains(document.elementFromPoint(center, rect.bottom - 1));

            if (progress.topSeen && progress.bottomSeen) {
                partialViews.delete(id);
                readIds.add(id);
                pendingIds.add(id);
                readCount += 1;
                if (pendingIds.size % saveBatchSize === 0) flushReadIds();
                updateReadCountButton();
            } else if (progress.topSeen || progress.bottomSeen) {
                partialViews.set(id, progress);
            }
        }
    }

    function updateFrame() {
        frame = null;
        const feed = feedPath();
        if (feed !== activeFeed) {
            if (hideStart) {
                hideStart = null;
                remainingHides = 0;
            }
            for (const article of mountedCards.keys()) releaseCard(article);
            refreshHiddenNotices([]);
            activeFeed = feed;
            scanPending = true;
        }
        if (!feed) {
            hideMoreButton.hidden = true;
            return;
        }
        if (document.hidden) return;
        if (scanPending) {
            scanPending = false;
            reconcileCards();
            hideMoreButton.hidden = !hideRead || !initialHiddenIds.size || remainingHides > 0;
        }
        if (!document.querySelector("#yami-x-settings[open]")) measureVisibleCards();
    }

    function scheduleFrame() {
        if (!document.hidden && (activeFeed || feedPath())) {
            frame ??= requestAnimationFrame(updateFrame);
        }
    }

    function scheduleScan() {
        scanPending = true;
        scheduleFrame();
    }

    function applyHideRead(value) {
        hideRead = value;
        if (menuId !== undefined) GM_unregisterMenuCommand(menuId);
        menuId = GM_registerMenuCommand(`Hide read posts: ${hideRead ? "On" : "Off"}`, () => {
            GM_setValue(hideReadKey, !hideRead);
        });
        scheduleScan();
    }

    hideMoreButton.addEventListener("click", () => {
        if (!hideRead || !activeFeed || feedPath() !== activeFeed || remainingHides > 0) return;

        const top = viewport.offsetTop;
        const bottom = top + viewport.height;
        const left = viewport.offsetLeft;
        const right = left + viewport.width;
        const articles = [...document.querySelectorAll(cardSelector)].reverse();
        for (const article of articles) {
            const rect = article.getBoundingClientRect();
            const visibleTop = Math.max(rect.top, top);
            const visibleBottom = Math.min(rect.bottom, bottom);
            const visibleLeft = Math.max(rect.left, left);
            const visibleRight = Math.min(rect.right, right);
            if (visibleBottom <= visibleTop || visibleRight <= visibleLeft) continue;

            const x = (visibleLeft + visibleRight) / 2;
            const middle = (visibleTop + visibleBottom) / 2;
            const sampleRows = [Math.min(middle, visibleTop + 1), middle, Math.max(middle, visibleBottom - 1)];
            if (!sampleRows.some((y) => article.contains(document.elementFromPoint(x, y)))) continue;

            const id = postId(article);
            if (!id) continue;
            hideStart = { id, top: cellTop(article) };
            remainingHides = hideBatchSize;
            scheduleScan();
            return;
        }
    });
    saveReadsButton.addEventListener("click", () => {
        if (!flushReadIds()) return;
        readCount = 0;
        updateReadCountButton();
    });
    updateReadCountButton();
    document.body.append(hideMoreButton, saveReadsButton);

    const intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting && mountedCards.has(entry.target)) visibleCards.add(entry.target);
            else visibleCards.delete(entry.target);
        }
        scheduleFrame();
    });
    const resizeObserver = new ResizeObserver(scheduleFrame);

    GM_addStyle(`
        .${hiddenClass} { display: none !important; }
        #yami-x-hide-more[hidden] { display: none; }
        .yami-x-read-notice {
            display: block;
            border-block-end: 1px solid color-mix(in srgb, currentColor 15%, transparent);
            color: inherit;
            font: 13px/1.4 system-ui, sans-serif;
            text-align: center;
        }
        .yami-x-read-notice summary {
            padding: 6px 12px;
            list-style-position: inside;
            cursor: pointer;
        }
        .yami-x-read-notice form {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: center;
            gap: 8px;
            padding: 0 12px 8px;
            color-scheme: light dark;
        }
        .yami-x-read-notice label { display: inline-flex; align-items: center; gap: 4px; }
        .yami-x-read-notice :is(input, select, button) {
            box-sizing: border-box;
            min-block-size: 28px;
            padding: 2px 6px;
            border: 1px solid GrayText;
            border-radius: 6px;
            background: Canvas;
            color: CanvasText;
            font: inherit;
            font-size: 1rem;
        }
        .yami-x-read-notice input { inline-size: 4.5ch; }
        .yami-x-read-notice button { cursor: pointer; }
    `);
    loadReadIds();
    // Keep the hide set stable as X rebuilds its timeline during this visit.
    for (const id of readIds) initialHiddenIds.add(id);
    const navigationTiming = performance.getEntriesByType("navigation")[0];
    if (navigationTiming?.type === "back_forward") remainingHides = 0;
    applyHideRead(hideRead);
    GM_addValueChangeListener(hideReadKey, (_key, _old, value) => applyHideRead(value));

    new MutationObserver(scheduleScan).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["href", "data-testid"],
    });
    window.addEventListener("scroll", scheduleFrame, { capture: true, passive: true });
    window.addEventListener("popstate", (event) => {
        // Restoring the timeline can remount cards that have already been collapsed.
        if (event.isTrusted && feedPath()) remainingHides = 0;
        scheduleScan();
    });
    window.addEventListener("pageshow", (event) => {
        if (!event.persisted || !feedPath()) return;
        remainingHides = 0;
        scheduleScan();
    });
    viewport.addEventListener("scroll", scheduleFrame, { passive: true });
    viewport.addEventListener("resize", scheduleFrame);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            loadReadIds();
            scheduleScan();
        }
    });

    return scheduleFrame;
}

function setupVideoDownloads() {
    const postSelector = 'article[data-testid="tweet"]';
    const viewerSelector = '[data-testid="swipe-to-dismiss"]';
    const immersiveCellSelector = '[data-testid^="cellInnerDiv-tweet-"]';
    const immersiveBackSelector = 'button[data-testid^="immersive-tweet-back-button-"]';
    const immersivePlayerSelector = '[data-testid="videoComponent"]';
    const playerSelector = `:is(${postSelector}, ${viewerSelector}) [data-testid="videoPlayer"],
        ${immersiveCellSelector}:has(${immersiveBackSelector}) ${immersivePlayerSelector}`;
    const buttonClass = "yami-x-download-video";
    const buttons = new Map();
    let scanFrame = null;

    function getDownloadUrl(player) {
        // X's <video> plays a blob URL. Its player component holds the MP4 download link.
        const fiberKey = Object.keys(player).find((key) => key.startsWith("__reactFiber$"));
        for (let fiber = player[fiberKey]; fiber && fiber.type !== "article" && fiber.type !== "main"; fiber = fiber.return) {
            const link = fiber.memoizedProps?.source?.downloadLink;
            if (typeof link !== "string" || !link.startsWith("https://video.twimg.com/")) continue;
            const url = new URL(link);
            if (url.pathname.endsWith(".mp4")) return url;
        }
    }

    function viewerBackButton(viewer) {
        for (let container = viewer.parentElement; container && container.tagName !== "MAIN"; container = container.parentElement) {
            const back = container.querySelector(':scope > [role="presentation"] > button[role="button"]');
            if (back) return back;
        }
    }

    function createDownloadButton(player) {
        const button = document.createElement("button");
        button.className = buttonClass;
        button.type = "button";
        button.textContent = "↓";
        button.title = "Download video";
        button.setAttribute("aria-label", button.title);
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            const url = getDownloadUrl(player);
            if (!url) {
                button.remove();
                return;
            }

            button.disabled = true;
            button.textContent = "…";
            function complete(error) {
                button.disabled = false;
                button.textContent = error ? "!" : "↓";
                button.title = error ? "Video download failed. Try again." : "Download video";
                button.setAttribute("aria-label", button.title);
                if (error) console.warn("[x_fly] Could not download video.", error);
            }

            try {
                GM_download({
                    url: url.href,
                    name: url.pathname.split("/").at(-1),
                    onload: () => complete(),
                    onerror: complete,
                    ontimeout: () => complete("timeout"),
                });
            } catch (error) {
                complete(error);
            }
        });
        return button;
    }

    function placeDownloadButtons() {
        scanFrame = null;
        const players = new Set(unsafeWindow.document.querySelectorAll(playerSelector));
        for (const [player, button] of buttons) {
            if (players.has(player) && button.isConnected) continue;
            button.remove();
            buttons.delete(player);
            resizeObserver.unobserve(player);
        }

        for (const player of players) {
            const viewer = player.closest(viewerSelector);
            const immersiveCell = player.matches(immersivePlayerSelector) ? player.closest(immersiveCellSelector) : null;
            const back = immersiveCell?.querySelector(immersiveBackSelector) ?? (viewer && viewerBackButton(viewer));
            const host = viewer || immersiveCell ? back?.parentElement : player.closest(postSelector);
            if (!host) continue;

            let button = buttons.get(player);
            if (!button) {
                if (!getDownloadUrl(player)) continue;
                button = createDownloadButton(player);
                buttons.set(player, button);
                resizeObserver.observe(player);
            }

            // Position in the post or controls wrapper, outside the clipped video.
            const anchorRect = (back ?? player).getBoundingClientRect();
            const hostRect = host.getBoundingClientRect();
            const left = back ? anchorRect.left + anchorRect.width / 2 : anchorRect.left;
            const top = back ? anchorRect.bottom + 8 : anchorRect.top;
            button.classList.toggle("yami-x-download-video-viewer", Boolean(back));
            button.style.setProperty("--x-fly-video-left", `${left - hostRect.left - host.clientLeft}px`);
            button.style.setProperty("--x-fly-video-top", `${top - hostRect.top - host.clientTop}px`);
            if (button.parentElement !== host) host.append(button);
        }
    }

    function schedulePlacement() {
        scanFrame ??= requestAnimationFrame(placeDownloadButtons);
    }

    const resizeObserver = new ResizeObserver(schedulePlacement);
    GM_addStyle(`
        .${buttonClass} {
            position: absolute;
            top: var(--x-fly-video-top);
            left: max(0px, calc(var(--x-fly-video-left) - 52px));
            z-index: 2;
            display: grid;
            place-items: center;
            inline-size: 44px;
            block-size: 44px;
            padding: 0;
            border: 0;
            border-radius: 12px;
            color: white;
            background: rgb(0 0 0 / 72%);
            font: 22px/1 system-ui, sans-serif;
            cursor: pointer;
            pointer-events: auto;
        }
        .${buttonClass}.yami-x-download-video-viewer {
            left: var(--x-fly-video-left);
            translate: -50% 0;
        }
        .${buttonClass}:hover { background: rgb(0 0 0 / 90%); }
        .${buttonClass}:focus-visible { outline: 2px solid white; outline-offset: 2px; }
        .${buttonClass}:disabled { cursor: progress; }
    `);
    new MutationObserver(schedulePlacement).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedulePlacement);
    placeDownloadButtons();
}

function setupSettings(onClose) {
    const settingsButton = document.createElement("button");
    settingsButton.id = "yami-x-settings-button";
    settingsButton.type = "button";
    const gear = document.createElement("span");
    gear.setAttribute("aria-hidden", "true");
    gear.textContent = "⚙︎";
    settingsButton.append(gear);
    settingsButton.setAttribute("aria-label", "X Fly settings");
    settingsButton.title = "X Fly settings";
    settingsButton.setAttribute("aria-haspopup", "dialog");
    settingsButton.setAttribute("aria-controls", "yami-x-settings");

    const settingsDialog = document.createElement("dialog");
    settingsDialog.id = "yami-x-settings";
    settingsDialog.setAttribute("aria-labelledby", "yami-x-settings-title");
    settingsDialog.innerHTML = `
        <form method="dialog" aria-labelledby="yami-x-settings-title">
            <header>
                <h2 id="yami-x-settings-title">X Fly settings</h2>
                <button type="submit" aria-label="Close settings">×</button>
            </header>
            <fieldset>
                <legend>Profile start page</legend>
                <label><input type="radio" name="profile-view" value="home" autofocus> Posts</label>
                <label><input type="radio" name="profile-view" value="video"> Videos</label>
                <label><input type="radio" name="profile-view" value="photo"> Photos</label>
            </fieldset>
            <label><input type="checkbox" name="hide-read"> Hide read posts</label>
            <p id="yami-x-saved-read-count"></p>
        </form>
    `;
    const hideReadCheckbox = settingsDialog.querySelector('[name="hide-read"]');
    const savedReadCount = settingsDialog.querySelector("#yami-x-saved-read-count");
    const profileOptions = settingsDialog.querySelectorAll('[name="profile-view"]');
    hideReadCheckbox.addEventListener("change", () => GM_setValue(hideReadKey, hideReadCheckbox.checked));
    for (const option of profileOptions) {
        option.addEventListener("change", () => GM_setValue(profileViewKey, option.value));
    }
    function showProfilePreference(value) {
        for (const option of profileOptions) option.checked = option.value === value;
    }
    GM_addValueChangeListener(hideReadKey, (_key, _old, value) => { hideReadCheckbox.checked = value; });
    GM_addValueChangeListener(profileViewKey, (_key, _old, value) => showProfilePreference(value));

    settingsButton.addEventListener("click", () => {
        hideReadCheckbox.checked = GM_getValue(hideReadKey, false);
        const count = savedReadIds().length;
        savedReadCount.textContent = `${count.toLocaleString("en-US")} saved read ${count === 1 ? "post" : "posts"}`;
        showProfilePreference(GM_getValue(profileViewKey, defaultProfileView));
        settingsDialog.querySelector("[autofocus]")?.removeAttribute("autofocus");
        settingsDialog.querySelector('[name="profile-view"]:checked')?.setAttribute("autofocus", "");
        settingsDialog.showModal();
    });
    settingsDialog.addEventListener("close", onClose);

    GM_addStyle(`
        :is(#yami-x-settings-button, #yami-x-settings, #yami-x-hide-more, #yami-x-save-reads) {
            --x-fly-dock-offset: max(72px, calc(env(safe-area-inset-bottom) + 16px));
            color-scheme: light dark;
            background: Canvas;
            color: CanvasText;
            border: 1px solid color-mix(in srgb, CanvasText 24%, Canvas);
            position: fixed;
            inset-inline-end: max(16px, env(safe-area-inset-right));
            box-sizing: border-box;
        }
        body:has([data-testid="GrokDrawerHeader"], [data-testid="chat-drawer-main"])
            :is(#yami-x-settings-button, #yami-x-settings, #yami-x-hide-more, #yami-x-save-reads) {
            --x-fly-dock-offset: max(160px, calc(env(safe-area-inset-bottom) + 128px));
        }
        :is(#yami-x-settings-button, #yami-x-hide-more, #yami-x-save-reads) {
            z-index: 9999;
            display: grid;
            place-items: center;
            inline-size: 44px;
            block-size: 44px;
            padding: 0;
            border-radius: 12px;
            text-align: center;
            box-shadow: 0 2px 6px rgb(0 0 0 / 12%);
            cursor: pointer;
        }
        #yami-x-settings-button {
            inset-block-end: var(--x-fly-dock-offset);
            font: 22px/1 system-ui, sans-serif;
        }
        #yami-x-hide-more {
            inset-block-end: calc(var(--x-fly-dock-offset) + 104px);
            font: 14px/1 system-ui, sans-serif;
        }
        #yami-x-save-reads {
            inset-block-end: calc(var(--x-fly-dock-offset) + 52px);
            font: 14px/1 system-ui, sans-serif;
            font-variant-numeric: tabular-nums;
            inline-size: max-content;
            min-inline-size: 44px;
            padding-inline: 6px;
        }
        :is(#yami-x-settings-button, #yami-x-hide-more, #yami-x-save-reads):hover { background: ButtonFace; }
        :is(#yami-x-hide-more, #yami-x-save-reads):active { scale: 0.97; }
        :is(#yami-x-hide-more, #yami-x-save-reads):focus-visible { outline: 2px solid CanvasText; outline-offset: 3px; }
        #yami-x-settings {
            --x-fly-dialog-offset: min(calc(var(--x-fly-dock-offset) + 54px), 36dvh);
            inset-block-start: auto;
            inset-block-end: var(--x-fly-dialog-offset);
            inset-inline-start: auto;
            margin: 0;
            inline-size: min(300px, calc(100vw - 32px));
            max-block-size: calc(100dvh - var(--x-fly-dialog-offset) - 16px);
            overflow: auto;
            padding: 12px 16px 16px;
            border-radius: 16px;
            font: 1rem/1.4 system-ui, sans-serif;
            box-shadow: 0 8px 28px rgb(0 0 0 / 20%);
        }
        #yami-x-settings:modal { overscroll-behavior: contain; }
        #yami-x-settings::backdrop {
            background: rgb(0 0 0 / 18%);
            overflow: hidden;
            overscroll-behavior: contain;
        }
        #yami-x-settings header {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        #yami-x-settings h2 { margin: 0; font-size: 1.125rem; }
        #yami-x-settings header button {
            inline-size: 48px;
            block-size: 48px;
            border: 0;
            border-radius: 50%;
            background: transparent;
            color: inherit;
            font: 24px system-ui, sans-serif;
            cursor: pointer;
        }
        #yami-x-settings fieldset {
            display: flex;
            flex-wrap: wrap;
            column-gap: 16px;
            margin: 4px 0;
            padding: 0;
            border: 0;
        }
        #yami-x-settings label {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            min-block-size: 48px;
            cursor: pointer;
        }
        #yami-x-settings input { font: inherit; }
        #yami-x-saved-read-count { margin: 0; }
    `);
    document.body.append(settingsButton, settingsDialog);
}

setupProfileNavigation();
const scheduleReadCheck = setupReadPostHiding();
setupVideoDownloads();
setupSettings(scheduleReadCheck);
})();
