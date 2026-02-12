// Admin mode: ?admin=TOKEN in URL, or saved token in localStorage
const adminToken = new URLSearchParams(window.location.search).get("admin") || localStorage.getItem("adminToken");
const isAdmin = !!adminToken;
// Persist URL token to localStorage so login survives navigation
if (adminToken && !localStorage.getItem("adminToken")) {
  localStorage.setItem("adminToken", adminToken);
}

// API base: use Railway URL when hosted on Firebase, relative path when on Railway/localhost
const API_BASE = window.location.hostname.includes("firebaseapp.com") || window.location.hostname.includes("web.app")
  ? "https://whatsapp-events-nyc-production.up.railway.app"
  : "";

// State
let allEvents = [];
let categories = [];
let catMap = {}; // id → category object (rebuilt on loadData)
let dashboardStats = null;
let recentEvents = [];
let blockedGroups = new Set();
let waConnected = null; // null = checking, true = connected, false = disconnected
let lastDataFetch = null;
let recentBannerCollapsed = false;
let currentView = "calendar";
let calendarDate = new Date();
let activeCategoryIndex = 0;
let dashboardExpanded = false;
let calCategoryFilter = null; // null = "All", or a category id string
let qrPollTimer = null;
let lastRenderedQr = null;
let backfillPollTimer = null;
let backfillDismissTimer = null;
let backfillDoneDismissed = false; // prevents re-showing after dismiss
let searchQuery = "";
let searchActive = false;
let previousView = null; // view to restore when search is cleared
let verifyPollTimer = null;
let dedupPollTimer = null;
let searchSort = "relevance"; // "relevance" | "date" | "proximity"
let proximityAddress = "";
let proximityCoords = null; // { lat, lng }
let geocodeCache = {}; // location string → { lat, lng } | null
let geocodingInProgress = false;
let geocodingAbort = false;

// Keyboard focus state
let focusedEventIndex = -1;
let focusedEventCards = [];

// Swipe state
let touchStartX = 0;
let touchEndX = 0;

// Category color map (mirrors CSS vars)
const catColors = {
  somatic: "#8e44ad",
  dance_movement: "#e84393",
  systems_metacrisis: "#636e72",
  environment: "#00b894",
  social_impact: "#d63031",
  learning: "#0984e3",
  skills: "#fdcb6e",
  multiday: "#e17055",
  conference: "#00cec9",
  online: "#a29bfe",
};

// Init
document.addEventListener("DOMContentLoaded", async () => {
  setupAdminMode();
  setupLogin();
  await loadData();
  setupTabs();
  setupCalendar();
  setupCategorySwipe();
  setupCalCategorySwipe();
  setupModal();
  setupDashboardPanel();
  setupKeyboard();
  setupKbHelp();
  setupKbPersistentPanel();
  setupSearch();
  setupRecentBanner();
  setupQrOverlay();
  pollStatus();
  pollBackfillStatus();
  renderCurrentView();
  // Poll for new events every 30s
  setInterval(loadData, 30000);
  // Poll WhatsApp status every 10s
  setInterval(pollStatus, 10000);
  // Poll backfill status every 5s (starts/stops dynamically)
  backfillPollTimer = setInterval(pollBackfillStatus, 5000);
});

// Helper: fetch an admin-protected endpoint with the token
function adminFetch(url, options = {}) {
  const separator = url.includes("?") ? "&" : "?";
  return fetch(`${API_BASE}${url}${separator}token=${encodeURIComponent(adminToken)}`, options);
}

// Helper: fetch a public API endpoint
function apiFetch(url, options = {}) {
  return fetch(`${API_BASE}${url}`, options);
}

async function loadData() {
  try {
    const fetches = [
      apiFetch("/api/events"),
      apiFetch("/api/categories"),
      apiFetch("/api/stats"),
      apiFetch("/api/events/recent?limit=15"),
    ];
    // Only fetch blocked groups in admin mode (requires auth)
    if (isAdmin) {
      fetches.push(adminFetch("/api/groups/blocked"));
    }

    const results = await Promise.all(fetches);
    allEvents = await results[0].json();
    categories = await results[1].json();
    catMap = {};
    for (const c of categories) catMap[c.id] = c;
    dashboardStats = await results[2].json();
    recentEvents = await results[3].json();
    if (isAdmin && results[4]) {
      const blockedList = await results[4].json();
      blockedGroups = new Set(blockedList);
    }
    lastDataFetch = new Date();
    renderCurrentView();
  } catch (err) {
    console.error("Failed to load data:", err);
  }
}

// ── Tabs ──

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      // Clear search if active
      if (searchActive) {
        searchActive = false;
        searchQuery = "";
        searchSort = "relevance";
        geocodingAbort = true;
        document.getElementById("search-input").value = "";
        document.getElementById("search-clear").classList.add("hidden");
        const sc = document.getElementById("search-sort");
        if (sc) sc.value = "relevance";
        const pw = document.getElementById("proximity-input-wrap");
        if (pw) pw.classList.remove("active");
        const scControls = document.getElementById("search-sort-controls");
        if (scControls) scControls.classList.add("hidden");
      }
      document.querySelector(".tab.active")?.classList.remove("active");
      tab.classList.add("active");
      document.querySelector(".view.active").classList.remove("active");
      const viewId = `view-${tab.dataset.view}`;
      document.getElementById(viewId).classList.add("active");
      currentView = tab.dataset.view;
      focusedEventIndex = -1;
      renderCurrentView();
    });
  });
}

function switchToView(viewName) {
  const tab = document.querySelector(`.tab[data-view="${viewName}"]`);
  if (tab) tab.click();
}

function renderCurrentView() {
  switch (currentView) {
    case "calendar": renderCalendar(); break;
    case "list": renderList(); break;
    case "categories": renderCategories(); break;
    case "favorites": renderFavorites(); break;
  }
  renderDashboard();
  updateFocusedCards();
}

// ── Dashboard Panel (persistent, collapsible) ──

function setupDashboardPanel() {
  const toggle = document.getElementById("dash-toggle");
  toggle.addEventListener("click", () => {
    dashboardExpanded = !dashboardExpanded;
    const collapsible = document.getElementById("dash-collapsible");
    const arrow = toggle.querySelector(".dash-toggle-arrow");
    collapsible.classList.toggle("open", dashboardExpanded);
    arrow.classList.toggle("open", dashboardExpanded);
  });

  const sortSelect = document.getElementById("dash-sort");
  sortSelect.addEventListener("change", () => renderDashboard());
}

function renderDashboard() {
  if (!dashboardStats) return;

  document.getElementById("dash-total-msgs").textContent =
    dashboardStats.totalMessages.toLocaleString();
  document.getElementById("dash-total-events").textContent =
    dashboardStats.totalEvents.toLocaleString();

  const overallRatio = dashboardStats.totalMessages > 0
    ? ((dashboardStats.totalEvents / dashboardStats.totalMessages) * 100).toFixed(1)
    : "0";
  document.getElementById("dash-overall-ratio").textContent = overallRatio + "%";

  const groups = dashboardStats.groups || [];

  // Toggle summary
  const activeGroups = groups.filter((g) => !blockedGroups.has(g.chatName));
  const blockedCount = groups.filter((g) => blockedGroups.has(g.chatName)).length;
  const summaryEl = document.getElementById("dash-toggle-summary");
  summaryEl.textContent = `${activeGroups.length} groups · ${blockedCount} blocked · ${dashboardStats.totalEvents} events`;

  // Monitor summary
  const monitorEl = document.getElementById("dash-monitor-summary");
  monitorEl.textContent = `${groups.length} groups monitored, ${blockedCount} blocked`;

  const container = document.getElementById("dash-groups");
  const empty = document.getElementById("dash-empty");

  if (groups.length === 0) {
    container.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  // Sort — blocked groups always go to the bottom
  const sortVal = document.getElementById("dash-sort").value;
  const [sortBy, sortDir] = sortVal.split("-");
  const dir = sortDir === "asc" ? 1 : -1;
  const sorted = [...groups].sort((a, b) => {
    // Blocked groups always sink to bottom
    const aBlocked = blockedGroups.has(a.chatName) ? 1 : 0;
    const bBlocked = blockedGroups.has(b.chatName) ? 1 : 0;
    if (aBlocked !== bBlocked) return aBlocked - bBlocked;

    if (sortBy === "events") {
      const diff = (a.eventCount - b.eventCount) * dir;
      return diff !== 0 ? diff : b.messageCount - a.messageCount;
    }
    if (sortBy === "lastActive") {
      if (!a.lastActive && !b.lastActive) return 0;
      if (!a.lastActive) return 1;
      if (!b.lastActive) return -1;
      const diff = a.lastActive.localeCompare(b.lastActive) * dir;
      return diff !== 0 ? diff : b.messageCount - a.messageCount;
    }
    // Ratio sort: tiebreak by most messages first (higher volume = more meaningful)
    const ratioDiff = (a.ratio - b.ratio) * dir;
    if (ratioDiff !== 0) return ratioDiff;
    return b.messageCount - a.messageCount;
  });

  // Find max ratio for scaling bars
  const maxRatio = Math.max(...sorted.map((g) => g.ratio), 0.01);

  container.innerHTML = sorted
    .map((g) => {
      const pct = ((g.ratio / maxRatio) * 100).toFixed(0);
      const signalClass =
        g.ratio > 0.05 ? "signal-high" : g.ratio > 0.01 ? "signal-mid" : "signal-low";
      const barColor =
        g.ratio > 0.05 ? "#00b894" : g.ratio > 0.01 ? "#fdcb6e" : "#d63031";
      const ratioPct = (g.ratio * 100).toFixed(1);
      const isBlocked = blockedGroups.has(g.chatName);
      const blockedClass = isBlocked ? " blocked" : "";

      // Top categories badges
      const topCats = (g.topCategories || [])
        .slice(0, 3)
        .map((catId) => {
          const cat = catMap[catId];
          const name = cat ? cat.name : catId;
          return `<span class="category-badge mini" data-category="${catId}">${escapeHtml(name)}</span>`;
        })
        .join("");

      // Last active date
      const lastActiveStr = g.lastActive
        ? new Date(g.lastActive + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : "—";

      // Block/unblock button
      const blockBtn = isBlocked
        ? `<button class="dash-block-btn resubscribe" data-group="${escapeAttr(g.chatName)}" title="Resubscribe">&#8634;</button>`
        : `<button class="dash-block-btn" data-group="${escapeAttr(g.chatName)}" title="Unsubscribe">&times;</button>`;

      return `
        <div class="dash-group-row ${signalClass}${blockedClass}">
          <div class="dash-group-name clickable" data-group="${escapeAttr(g.chatName)}" title="${escapeHtml(g.chatName)}">${escapeHtml(g.chatName)}</div>
          <div class="dash-group-cats">${topCats}</div>
          <div class="dash-group-stats">
            <span>${g.messageCount} msgs</span>
            <span>${g.eventCount} ev</span>
            <span>${ratioPct}%</span>
          </div>
          <span class="dash-last-active">${lastActiveStr}</span>
          <div class="dash-ratio-bar">
            <div class="dash-ratio-fill" style="width: ${pct}%; background: ${barColor};"></div>
          </div>
          ${blockBtn}
        </div>`;
    })
    .join("");

  // Attach group click listeners
  container.querySelectorAll(".dash-group-name.clickable").forEach((el) => {
    el.addEventListener("click", () => {
      showGroupEvents(el.dataset.group);
    });
  });

  // Attach block/unblock listeners
  container.querySelectorAll(".dash-block-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const chatName = btn.dataset.group;
      const isBlocked = blockedGroups.has(chatName);
      try {
        if (isBlocked) {
          await adminFetch(`/api/groups/${encodeURIComponent(chatName)}/block`, { method: "DELETE" });
          blockedGroups.delete(chatName);
        } else {
          await adminFetch(`/api/groups/${encodeURIComponent(chatName)}/block`, { method: "POST" });
          blockedGroups.add(chatName);
        }
        renderDashboard();
      } catch (err) {
        console.error("Failed to toggle block:", err);
      }
    });
  });
}

// ── WhatsApp Status ──

async function pollStatus() {
  try {
    const res = await apiFetch("/api/status");
    const data = await res.json();
    waConnected = data.whatsappConnected;
  } catch {
    waConnected = false;
  }
  renderStatus();
}

function renderStatus() {
  const el = document.getElementById("wa-status");
  const refreshBtn = document.getElementById("refresh-btn");
  if (waConnected === null) {
    el.className = "wa-status checking";
    el.title = "WhatsApp: checking...";
    el.querySelector(".wa-label").textContent = "Checking...";
    // Show scan button for admin (disabled while checking)
    if (refreshBtn && isAdmin) {
      refreshBtn.classList.remove("hidden");
      refreshBtn.disabled = true;
      refreshBtn.title = "Waiting for WhatsApp...";
    }
  } else if (waConnected) {
    el.className = "wa-status connected";
    el.title = "WhatsApp: connected";
    el.querySelector(".wa-label").textContent = "Connected";
    // Show scan button enabled when connected + admin
    if (refreshBtn && isAdmin) {
      refreshBtn.classList.remove("hidden");
      refreshBtn.disabled = false;
      refreshBtn.title = "Scan for new events";
    }
    // Stop QR polling when connected
    if (qrPollTimer) {
      clearInterval(qrPollTimer);
      qrPollTimer = null;
    }
    document.getElementById("qr-overlay").classList.add("hidden");
  } else {
    el.className = "wa-status disconnected" + (isAdmin ? " admin-clickable" : "");
    el.title = isAdmin ? "Click to connect WhatsApp" : "WhatsApp: disconnected";
    el.querySelector(".wa-label").textContent = "Disconnected";
    // Show scan button for admin (disabled when disconnected)
    if (refreshBtn && isAdmin) {
      refreshBtn.classList.remove("hidden");
      refreshBtn.disabled = true;
      refreshBtn.title = "WhatsApp disconnected";
    }
  }
}

// ── Backfill Progress ──

async function pollBackfillStatus() {
  try {
    const res = await apiFetch("/api/backfill-status");
    const progress = await res.json();
    renderBackfillProgress(progress);
  } catch {
    // silently ignore
  }
}

function renderBackfillProgress(progress) {
  const el = document.getElementById("backfill-progress");
  if (!el) return;

  // When idle (or unknown), hide and reset flags for next backfill
  if (!progress.active && progress.phase !== "done" && progress.phase !== "error") {
    el.classList.add("hidden");
    el.classList.remove("done", "error");
    backfillDoneDismissed = false;
    if (backfillDismissTimer) { clearTimeout(backfillDismissTimer); backfillDismissTimer = null; }
    return;
  }

  // If we already dismissed the "done" state, don't re-show
  if (progress.phase === "done" && backfillDoneDismissed) {
    return;
  }

  // Active backfill resets the dismissed flag
  if (progress.active) {
    backfillDoneDismissed = false;
    if (backfillDismissTimer) { clearTimeout(backfillDismissTimer); backfillDismissTimer = null; }
  }

  el.classList.remove("hidden");

  const label = document.getElementById("backfill-progress-label");
  const fill = document.getElementById("backfill-progress-fill");
  const detail = document.getElementById("backfill-progress-detail");
  const eventsEl = document.getElementById("backfill-progress-events");

  if (progress.phase === "fetching") {
    const groupInfo = progress.totalGroups > 0
      ? `Scanning group ${progress.groupsScanned} of ${progress.totalGroups}...`
      : "Connecting to chats...";
    const fetchPct = progress.totalGroups > 0
      ? Math.round((progress.groupsScanned / progress.totalGroups) * 100)
      : 5;
    label.textContent = "Fetching WhatsApp messages...";
    fill.style.width = `${Math.max(fetchPct, 5)}%`;
    detail.textContent = groupInfo;
    eventsEl.textContent = "";
    el.classList.remove("done", "error");
  } else if (progress.phase === "processing") {
    const pct = progress.totalMessages > 0
      ? Math.round((progress.processedMessages / progress.totalMessages) * 100)
      : 0;
    label.textContent = `Scanning for events... ${pct}%`;
    fill.style.width = `${pct}%`;
    detail.textContent = `${progress.processedMessages} / ${progress.totalMessages} messages`;
    eventsEl.textContent = `${progress.eventsFound} event${progress.eventsFound !== 1 ? "s" : ""} found`;
    el.classList.remove("done", "error");
  } else if (progress.phase === "error") {
    label.textContent = "Scan failed";
    fill.style.width = "100%";
    detail.textContent = progress.errorMessage || "Unknown error";
    eventsEl.textContent = isAdmin ? "Check Logs for details" : "";
    el.classList.remove("done");
    el.classList.add("error");
  } else if (progress.phase === "done") {
    label.textContent = "Scan complete!";
    fill.style.width = "100%";
    detail.textContent = `${progress.totalMessages} messages scanned`;
    eventsEl.textContent = `${progress.eventsFound} event${progress.eventsFound !== 1 ? "s" : ""} found`;
    el.classList.remove("error");
    el.classList.add("done");

    // Auto-hide after 8 seconds, reload data
    if (!backfillDismissTimer) {
      loadData();
      backfillDismissTimer = setTimeout(() => {
        el.classList.add("hidden");
        el.classList.remove("done");
        backfillDoneDismissed = true;
        backfillDismissTimer = null;
      }, 8000);
    }
  }
}

// ── Verify Progress ──

async function pollVerifyStatus() {
  if (!isAdmin) return;
  try {
    const res = await apiFetch("/api/verify-status");
    const progress = await res.json();
    renderVerifyProgress(progress);
  } catch {
    // silently ignore
  }
}

function renderVerifyProgress(progress) {
  const verifyBtn = document.getElementById("verify-btn");
  if (!verifyBtn) return;

  const el = document.getElementById("verify-progress");
  if (!el) return;

  const label = document.getElementById("verify-progress-label");
  const fill = document.getElementById("verify-progress-fill");
  const detail = document.getElementById("verify-progress-detail");
  const eventsEl = document.getElementById("verify-progress-events");
  const icon = el.querySelector(".verify-icon");

  if (progress.phase === "idle" && !progress.active) {
    verifyBtn.disabled = false;
    verifyBtn.classList.remove("verifying");
    verifyBtn.textContent = "Verify";
    el.classList.add("hidden");
    el.classList.remove("done", "error");
    if (verifyPollTimer) {
      clearInterval(verifyPollTimer);
      verifyPollTimer = null;
    }
    return;
  }

  if (progress.phase === "running") {
    verifyBtn.disabled = true;
    verifyBtn.classList.add("verifying");
    const pct = progress.total > 0 ? Math.round((progress.checked / progress.total) * 100) : 0;
    verifyBtn.textContent = `Verifying ${pct}%`;

    el.classList.remove("hidden", "done", "error");
    label.textContent = progress.currentEvent
      ? `Checking: ${progress.currentEvent}`
      : `Verifying events... ${pct}%`;
    fill.style.width = `${pct}%`;
    detail.textContent = `${progress.checked} / ${progress.total} events checked`;
    eventsEl.textContent = `${progress.updated} updated, ${progress.deleted} deleted`;
    if (icon) icon.style.animation = "spin-icon 1.5s linear infinite";

    // Set up polling if not already active (handles page refresh during verify)
    if (!verifyPollTimer) {
      verifyPollTimer = setInterval(pollVerifyStatus, 2000);
    }
  } else if (progress.phase === "done") {
    verifyBtn.disabled = false;
    verifyBtn.classList.remove("verifying");
    verifyBtn.textContent = "Verify";

    el.classList.remove("hidden", "error");
    el.classList.add("done");
    label.textContent = "Verification complete!";
    fill.style.width = "100%";
    detail.textContent = `${progress.total} events checked`;
    eventsEl.textContent = `${progress.updated} updated, ${progress.deleted} deleted`;
    if (icon) icon.style.animation = "none";

    loadData();
    setTimeout(() => {
      el.classList.add("hidden");
      el.classList.remove("done");
    }, 8000);

    if (verifyPollTimer) { clearInterval(verifyPollTimer); verifyPollTimer = null; }
  } else if (progress.phase === "error") {
    verifyBtn.disabled = false;
    verifyBtn.classList.remove("verifying");
    verifyBtn.textContent = "Verify";

    el.classList.remove("hidden", "done");
    el.classList.add("error");
    label.textContent = "Verification failed";
    fill.style.width = "100%";
    detail.textContent = progress.errorMessage || "Unknown error";
    eventsEl.textContent = "";
    if (icon) icon.style.animation = "none";

    if (verifyPollTimer) { clearInterval(verifyPollTimer); verifyPollTimer = null; }
  }
}

// ── Dedup Progress ──

async function pollDedupStatus() {
  if (!isAdmin) return;
  try {
    const res = await apiFetch("/api/dedup-status");
    const progress = await res.json();
    renderDedupProgress(progress);
  } catch {}
}

function renderDedupProgress(progress) {
  const dedupBtn = document.getElementById("dedup-btn");
  if (!dedupBtn) return;

  const el = document.getElementById("dedup-progress");
  if (!el) return;

  const label = document.getElementById("dedup-progress-label");
  const fill = document.getElementById("dedup-progress-fill");
  const detail = document.getElementById("dedup-progress-detail");
  const eventsEl = document.getElementById("dedup-progress-events");

  if (progress.phase === "idle" && !progress.active) {
    dedupBtn.disabled = false;
    dedupBtn.textContent = "Dedup";
    el.classList.add("hidden");
    el.classList.remove("done");
    if (dedupPollTimer) { clearInterval(dedupPollTimer); dedupPollTimer = null; }
    return;
  }

  if (progress.phase === "running") {
    dedupBtn.disabled = true;
    dedupBtn.textContent = "Deduping...";
    el.classList.remove("hidden", "done");
    const pct = progress.total > 0 ? Math.round((progress.checked / progress.total) * 100) : 0;
    label.textContent = progress.currentEvent
      ? `Checking: ${progress.currentEvent}`
      : `Scanning for duplicates... ${pct}%`;
    fill.style.width = `${pct}%`;
    detail.textContent = `${progress.checked} / ${progress.total} events scanned`;
    eventsEl.textContent = `${progress.deleted} duplicates removed`;

    if (!dedupPollTimer) {
      dedupPollTimer = setInterval(pollDedupStatus, 1000);
    }
  } else if (progress.phase === "done") {
    dedupBtn.disabled = false;
    dedupBtn.textContent = "Dedup";
    el.classList.remove("hidden");
    el.classList.add("done");
    label.textContent = "Deduplication complete!";
    fill.style.width = "100%";
    detail.textContent = `${progress.total} events scanned`;
    eventsEl.textContent = `${progress.deleted} duplicates removed`;

    loadData();
    setTimeout(() => {
      el.classList.add("hidden");
      el.classList.remove("done");
    }, 8000);

    if (dedupPollTimer) { clearInterval(dedupPollTimer); dedupPollTimer = null; }
  }
}

// ── Admin Mode ──

function setupAdminMode() {
  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");

  if (!isAdmin) {
    // Hide admin-only elements
    document.getElementById("dashboard-panel").classList.add("hidden");
    document.body.classList.add("public-mode");
    // Hide favorites tab in public mode
    const favTab = document.querySelector('.tab[data-view="favorites"]');
    if (favTab) favTab.classList.add("hidden");
    // Show login, hide logout
    loginBtn.classList.remove("hidden");
    logoutBtn.classList.add("hidden");
    return;
  }

  // Admin mode active
  document.body.classList.add("admin-mode");
  loginBtn.classList.add("hidden");
  logoutBtn.classList.remove("hidden");

  // Make status badge clickable to open QR
  document.getElementById("wa-status").addEventListener("click", () => {
    if (!waConnected && isAdmin) {
      openQrOverlay();
    }
  });

  // Refresh/Scan button: triggers a backfill
  const refreshBtn = document.getElementById("refresh-btn");
  refreshBtn.addEventListener("click", async () => {
    if (refreshBtn.disabled) return;
    refreshBtn.disabled = true;
    refreshBtn.classList.add("scanning");
    refreshBtn.textContent = "Scanning...";
    backfillDoneDismissed = false; // Reset so progress bar shows
    try {
      await adminFetch("/api/backfill", { method: "POST" });
    } catch (err) {
      console.error("Backfill trigger failed:", err);
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove("scanning");
      refreshBtn.innerHTML = "&#8635; Scan";
      loadData();
    }
  });

  // Verify button: triggers bulk date verification
  const verifyBtn = document.getElementById("verify-btn");
  verifyBtn.classList.remove("hidden");
  verifyBtn.addEventListener("click", async () => {
    if (verifyBtn.disabled) return;
    verifyBtn.disabled = true;
    verifyBtn.classList.add("verifying");
    verifyBtn.textContent = "Verifying...";
    try {
      await adminFetch("/api/verify-all", { method: "POST" });
      // Start polling for progress
      pollVerifyStatus();
      if (!verifyPollTimer) {
        verifyPollTimer = setInterval(pollVerifyStatus, 2000);
      }
    } catch (err) {
      console.error("Verify trigger failed:", err);
      verifyBtn.disabled = false;
      verifyBtn.classList.remove("verifying");
      verifyBtn.textContent = "Verify";
    }
  });

  // Poll verify status on load (in case one is already running)
  pollVerifyStatus();

  // Dedup button: triggers fuzzy duplicate removal
  const dedupBtn = document.getElementById("dedup-btn");
  dedupBtn.classList.remove("hidden");
  dedupBtn.addEventListener("click", async () => {
    if (dedupBtn.disabled) return;
    dedupBtn.disabled = true;
    dedupBtn.textContent = "Deduping...";
    try {
      await adminFetch("/api/dedup", { method: "POST" });
      pollDedupStatus();
      if (!dedupPollTimer) {
        dedupPollTimer = setInterval(pollDedupStatus, 1000);
      }
    } catch (err) {
      console.error("Dedup trigger failed:", err);
      dedupBtn.disabled = false;
      dedupBtn.textContent = "Dedup";
    }
  });

  // Poll dedup status on load (in case one is already running)
  pollDedupStatus();

  // Logs button
  const logsBtn = document.getElementById("logs-btn");
  logsBtn.classList.remove("hidden");
  logsBtn.addEventListener("click", () => openLogsModal());

  // Logs modal close
  document.getElementById("logs-close").addEventListener("click", () => {
    document.getElementById("logs-overlay").classList.add("hidden");
  });
  document.getElementById("logs-overlay").addEventListener("click", (e) => {
    if (e.target.id === "logs-overlay") document.getElementById("logs-overlay").classList.add("hidden");
  });
  document.getElementById("logs-refresh").addEventListener("click", () => fetchAndRenderLogs());
  document.getElementById("logs-copy").addEventListener("click", () => copyLogs());
  document.getElementById("logs-filter").addEventListener("change", () => fetchAndRenderLogs());
}

async function openLogsModal() {
  document.getElementById("logs-overlay").classList.remove("hidden");
  await fetchAndRenderLogs();
}

async function fetchAndRenderLogs() {
  const container = document.getElementById("logs-content");
  const filter = document.getElementById("logs-filter").value;
  const url = filter ? `/api/logs?level=${filter}` : "/api/logs";
  try {
    const res = await adminFetch(url);
    const logs = await res.json();
    if (logs.length === 0) {
      container.innerHTML = '<div style="color: var(--text-dim); padding: 20px; text-align: center;">No log entries.</div>';
      return;
    }
    container.innerHTML = logs.map((entry) => {
      const d = new Date(entry.timestamp);
      const ts = d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
      const cls = `log-entry log-${entry.level}`;
      return `<div class="${cls}"><span class="log-ts">${escapeHtml(ts)}</span>${escapeHtml(entry.message)}</div>`;
    }).join("");
    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  } catch (err) {
    container.innerHTML = `<div style="color: #d63031; padding: 20px;">Failed to load logs: ${escapeHtml(String(err))}</div>`;
  }
}

function copyLogs() {
  const container = document.getElementById("logs-content");
  const text = container.innerText;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById("logs-copy");
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  }).catch(() => {});
}

function setupLogin() {
  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");
  const overlay = document.getElementById("login-overlay");
  const closeBtn = document.getElementById("login-close");
  const form = document.getElementById("login-form");
  const errorEl = document.getElementById("login-error");

  loginBtn.addEventListener("click", () => {
    overlay.classList.remove("hidden");
    document.getElementById("login-email").focus();
  });

  closeBtn.addEventListener("click", () => overlay.classList.add("hidden"));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.add("hidden");
  });

  logoutBtn.addEventListener("click", () => {
    localStorage.removeItem("adminToken");
    // Remove ?admin= from URL if present
    const url = new URL(window.location);
    url.searchParams.delete("admin");
    window.location.href = url.toString();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.classList.add("hidden");
    const email = document.getElementById("login-email").value;
    const password = document.getElementById("login-password").value;
    const submitBtn = form.querySelector(".login-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in...";

    try {
      const res = await fetch(`${API_BASE}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok && data.token) {
        localStorage.setItem("adminToken", data.token);
        window.location.reload();
      } else {
        errorEl.textContent = data.error || "Login failed.";
        errorEl.classList.remove("hidden");
      }
    } catch (err) {
      errorEl.textContent = "Connection error. Try again.";
      errorEl.classList.remove("hidden");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign In";
    }
  });
}

function setupQrOverlay() {
  document.getElementById("qr-close").addEventListener("click", closeQrOverlay);
  document.getElementById("qr-overlay").addEventListener("click", (e) => {
    if (e.target.id === "qr-overlay") closeQrOverlay();
  });
}

function openQrOverlay() {
  document.getElementById("qr-overlay").classList.remove("hidden");
  document.getElementById("qr-canvas-container").classList.add("hidden");
  document.getElementById("qr-waiting").classList.remove("hidden");
  document.getElementById("qr-expired").classList.add("hidden");
  lastRenderedQr = null;
  pollQrCode();
  // Poll QR every 3s
  if (qrPollTimer) clearInterval(qrPollTimer);
  qrPollTimer = setInterval(pollQrCode, 3000);
}

function closeQrOverlay() {
  document.getElementById("qr-overlay").classList.add("hidden");
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    qrPollTimer = null;
  }
}

async function pollQrCode() {
  try {
    const res = await adminFetch("/api/qr");
    if (res.status === 401) { console.warn("QR endpoint requires admin token"); return; }
    const data = await res.json();
    if (data.qr) {
      // Only re-render if the QR data actually changed
      if (data.qr === lastRenderedQr) return;
      lastRenderedQr = data.qr;
      document.getElementById("qr-waiting").classList.add("hidden");
      document.getElementById("qr-expired").classList.add("hidden");
      document.getElementById("qr-canvas-container").classList.remove("hidden");
      const canvas = document.getElementById("qr-canvas");
      QRCode.toCanvas(canvas, data.qr, {
        width: 320,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });
    } else if (waConnected) {
      closeQrOverlay();
    }
  } catch (err) {
    console.error("Failed to fetch QR code:", err);
  }
}

// ── Recent Events Banner (Calendar top) ──

function setupRecentBanner() {
  const toggleBtn = document.getElementById("recent-banner-toggle");
  toggleBtn.addEventListener("click", () => {
    recentBannerCollapsed = !recentBannerCollapsed;
    const banner = document.getElementById("recent-banner");
    banner.classList.toggle("collapsed", recentBannerCollapsed);
    toggleBtn.textContent = recentBannerCollapsed ? "Show" : "Hide";
  });
}

function renderRecentBanner() {
  const container = document.getElementById("recent-banner-list");
  const empty = document.getElementById("recent-banner-empty");
  const updatedEl = document.getElementById("recent-banner-updated");

  // Show last updated time
  if (lastDataFetch) {
    const ago = formatRelativeTime(lastDataFetch.toISOString());
    updatedEl.textContent = `Last refreshed: ${ago}`;
  }

  if (!recentEvents || recentEvents.length === 0) {
    container.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  container.innerHTML = recentEvents
    .map((ev) => {
      const cat = catMap[ev.category];
      const catName = cat ? cat.name : ev.category;
      const addedLabel = formatRelativeTime(ev.createdAt);
      const evDate = new Date(ev.date + "T00:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });

      return `
        <div class="recent-row" data-hash="${ev.hash}" data-category="${ev.category}">
          <span class="recent-row-time" title="${escapeAttr(ev.createdAt)}">${addedLabel}</span>
          <span class="recent-row-name">${escapeHtml(ev.name)}</span>
          <span class="category-badge mini" data-category="${ev.category}">${escapeHtml(catName)}</span>
          <span class="recent-row-date">${evDate}</span>
          <span class="recent-row-source" title="${escapeAttr(ev.sourceChat || "")}">${escapeHtml(ev.sourceChat || "")}</span>
        </div>`;
    })
    .join("");

  // Click to open event detail
  container.querySelectorAll(".recent-row").forEach((row) => {
    row.addEventListener("click", () => {
      const hash = row.dataset.hash;
      const event = allEvents.find((e) => e.hash === hash) || recentEvents.find((e) => e.hash === hash);
      if (event) showModal(event);
    });
  });
}

function formatRelativeTime(str) {
  if (!str) return "";
  // SQLite datetime: "2026-02-11 16:56:17" → replace space with T, add Z for UTC
  const normalized = str.includes("T") ? str : str.replace(" ", "T");
  const date = new Date(normalized + (normalized.includes("Z") || normalized.includes("+") ? "" : "Z"));
  if (isNaN(date.getTime())) return str;
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

async function showGroupEvents(chatName) {
  try {
    const res = await apiFetch(`/api/events/group/${encodeURIComponent(chatName)}`);
    const events = await res.json();

    const content = document.getElementById("modal-content");

    if (events.length === 0) {
      content.innerHTML = `
        <h2>${escapeHtml(chatName)}</h2>
        <p style="color: var(--text-dim);">No events found from this group.</p>`;
    } else {
      let html = `<h2>${escapeHtml(chatName)}</h2>
        <p style="color: var(--text-dim); margin-bottom: 16px;">${events.length} event(s) extracted</p>`;
      html += events.map((ev) => {
        const cat = catMap[ev.category];
        const catName = cat ? cat.name : ev.category;
        const timeStr = ev.startTime
          ? formatTime(ev.startTime) + (ev.endTime ? ` - ${formatTime(ev.endTime)}` : "")
          : "All day";
        const dateLabel = new Date(ev.date + "T00:00:00").toLocaleDateString("en-US", {
          month: "short", day: "numeric",
        });
        return `
          <div style="padding: 10px 0; border-bottom: 1px solid var(--border);">
            <div style="font-weight: 600; font-size: 14px;">${escapeHtml(ev.name)}</div>
            <div style="font-size: 12px; color: var(--text-dim); margin-top: 4px;">
              ${dateLabel} · ${timeStr}
              ${ev.location ? ` · ${escapeHtml(ev.location)}` : ""}
            </div>
            <span class="category-badge mini" data-category="${ev.category}">${escapeHtml(catName)}</span>
          </div>`;
      }).join("");
      content.innerHTML = html;
    }

    document.getElementById("modal-overlay").classList.remove("hidden");
  } catch (err) {
    console.error("Failed to load group events:", err);
  }
}

// ── Calendar View ──

function setupCalendar() {
  document.getElementById("cal-prev").addEventListener("click", () => {
    calendarDate.setMonth(calendarDate.getMonth() - 1);
    renderCalendar();
  });
  document.getElementById("cal-next").addEventListener("click", () => {
    calendarDate.setMonth(calendarDate.getMonth() + 1);
    renderCalendar();
  });
}

function renderCalCategoryTabs() {
  const container = document.getElementById("cal-cat-tabs");
  container.innerHTML = "";

  // "All" tab
  const allBtn = document.createElement("button");
  allBtn.className = "cal-cat-tab" + (calCategoryFilter === null ? " active" : "");
  allBtn.textContent = "All";
  allBtn.style.background = calCategoryFilter === null ? "var(--accent)" : "";
  allBtn.addEventListener("click", () => {
    calCategoryFilter = null;
    renderCalendar();
  });
  container.appendChild(allBtn);

  // One tab per category
  categories.forEach((cat) => {
    const btn = document.createElement("button");
    btn.className = "cal-cat-tab" + (calCategoryFilter === cat.id ? " active" : "");
    btn.textContent = cat.name;
    btn.style.background = calCategoryFilter === cat.id ? (catColors[cat.id] || "var(--accent)") : "";
    btn.addEventListener("click", () => {
      calCategoryFilter = cat.id;
      renderCalendar();
    });
    container.appendChild(btn);
  });

  // Scroll the active tab into view
  const activeTab = container.querySelector(".cal-cat-tab.active");
  if (activeTab) {
    activeTab.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }
}

function renderCalendar() {
  renderRecentBanner();
  renderCalCategoryTabs();

  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const today = new Date();

  document.getElementById("cal-month-label").textContent =
    calendarDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  // Apply calendar category filter
  const filteredEvents = calCategoryFilter
    ? allEvents.filter((ev) => ev.category === calCategoryFilter)
    : allEvents;

  // Build event map: dateStr -> events[]
  const eventMap = {};
  filteredEvents.forEach((ev) => {
    const key = ev.date;
    if (!eventMap[key]) eventMap[key] = [];
    eventMap[key].push(ev);
    // Multi-day: add dots for each day
    if (ev.endDate && ev.endDate !== ev.date) {
      const start = new Date(ev.date + "T00:00:00");
      const end = new Date(ev.endDate + "T00:00:00");
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const k = dateStr(d);
        if (k !== key) {
          if (!eventMap[k]) eventMap[k] = [];
          eventMap[k].push(ev);
        }
      }
    }
  });

  // First day of month and padding
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();

  const container = document.getElementById("cal-days");
  container.innerHTML = "";

  // Previous month padding
  for (let i = firstDay - 1; i >= 0; i--) {
    const day = daysInPrev - i;
    const d = new Date(year, month - 1, day);
    container.appendChild(createCalDay(d, eventMap, true));
  }

  // Current month
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    const isToday =
      d.getDate() === today.getDate() &&
      d.getMonth() === today.getMonth() &&
      d.getFullYear() === today.getFullYear();
    container.appendChild(createCalDay(d, eventMap, false, isToday));
  }

  // Next month padding
  const totalCells = container.children.length;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let day = 1; day <= remaining; day++) {
    const d = new Date(year, month + 1, day);
    container.appendChild(createCalDay(d, eventMap, true));
  }

  // Hide day detail
  document.getElementById("cal-day-detail").classList.add("hidden");
}

function createCalDay(date, eventMap, otherMonth, isToday = false) {
  const el = document.createElement("div");
  el.className = "cal-day" + (otherMonth ? " other-month" : "") + (isToday ? " today" : "");

  const num = document.createElement("div");
  num.className = "day-number";
  num.textContent = date.getDate();
  el.appendChild(num);

  const key = dateStr(date);
  const events = eventMap[key] || [];

  if (events.length > 0) {
    // Deduplicate by hash
    const unique = [];
    const seen = new Set();
    events.forEach((ev) => {
      if (!seen.has(ev.hash)) {
        seen.add(ev.hash);
        unique.push(ev);
      }
    });

    const maxVisible = 3;
    const eventsContainer = document.createElement("div");
    eventsContainer.className = "day-events";

    unique.slice(0, maxVisible).forEach((ev) => {
      const item = document.createElement("div");
      item.className = "day-event-item";
      item.dataset.category = ev.category;
      item.dataset.hash = ev.hash;
      item.textContent = ev.name;
      item.title = ev.name;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        const event = allEvents.find((x) => x.hash === ev.hash);
        if (event) showModal(event);
      });
      eventsContainer.appendChild(item);
    });

    if (unique.length > maxVisible) {
      const more = document.createElement("div");
      more.className = "day-event-more";
      more.textContent = `+${unique.length - maxVisible} more`;
      eventsContainer.appendChild(more);
    }

    el.appendChild(eventsContainer);
  }

  el.addEventListener("click", () => {
    showDayDetail(date, events);
  });

  return el;
}

function showDayDetail(date, events) {
  const detail = document.getElementById("cal-day-detail");
  const label = document.getElementById("cal-day-label");
  const container = document.getElementById("cal-day-events");

  label.textContent = date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  // Deduplicate
  const unique = [];
  const seen = new Set();
  events.forEach((ev) => {
    if (!seen.has(ev.hash)) {
      seen.add(ev.hash);
      unique.push(ev);
    }
  });

  if (unique.length === 0) {
    container.innerHTML = '<p style="color: var(--text-dim); font-size: 14px;">No events on this day.</p>';
  } else {
    container.innerHTML = unique.map(eventCardHTML).join("");
    attachCardListeners(container);
  }

  detail.classList.remove("hidden");
  updateFocusedCards();
}

// ── List View ──

function renderList() {
  const today = todayStr();
  const filter = document.getElementById("list-filter").value;
  let events = filter === "favorites"
    ? allEvents.filter((e) => e.favorited)
    : filter === "all"
      ? allEvents
      : allEvents.filter((e) => e.category === filter);

  // Hide past events (use endDate for multi-day events)
  events = events.filter((e) => (e.endDate || e.date) >= today);

  // Populate filter dropdown with categories (only once)
  const select = document.getElementById("list-filter");
  if (select.options.length <= 2) {
    categories.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat.id;
      opt.textContent = cat.name;
      select.appendChild(opt);
    });
    select.addEventListener("change", renderList);
  }

  const container = document.getElementById("list-events");
  const empty = document.getElementById("list-empty");

  if (events.length === 0) {
    container.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  // Group by date
  const grouped = {};
  events.forEach((ev) => {
    if (!grouped[ev.date]) grouped[ev.date] = [];
    grouped[ev.date].push(ev);
  });

  let html = "";
  Object.keys(grouped)
    .sort()
    .forEach((date) => {
      const d = new Date(date + "T00:00:00");
      const label = d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      html += `<div class="list-date-header">${label}</div>`;
      html += grouped[date].map(eventCardHTML).join("");
    });

  container.innerHTML = html;
  attachCardListeners(container);
}

// ── Categories View ──

function renderCategories() {
  const tabsContainer = document.getElementById("cat-tabs");
  const swiperContainer = document.getElementById("cat-swiper");

  // Build tabs
  tabsContainer.innerHTML = "";
  categories.forEach((cat, i) => {
    const btn = document.createElement("button");
    btn.className = "cat-tab" + (i === activeCategoryIndex ? " active" : "");
    btn.textContent = cat.name;
    btn.style.background = i === activeCategoryIndex ? catColors[cat.id] : "";
    btn.addEventListener("click", () => {
      activeCategoryIndex = i;
      renderCategories();
    });
    tabsContainer.appendChild(btn);
  });

  // Build panel for active category (hide past events)
  const today = todayStr();
  const cat = categories[activeCategoryIndex];
  const events = allEvents.filter((e) => e.category === cat.id && (e.endDate || e.date) >= today);

  if (events.length === 0) {
    swiperContainer.innerHTML = `
      <div class="cat-panel active">
        <div class="cat-panel-empty">No ${cat.name} events yet.</div>
      </div>`;
  } else {
    // Group by date
    const grouped = {};
    events.forEach((ev) => {
      if (!grouped[ev.date]) grouped[ev.date] = [];
      grouped[ev.date].push(ev);
    });

    let html = '<div class="cat-panel active"><div class="event-list">';
    Object.keys(grouped)
      .sort()
      .forEach((date) => {
        const d = new Date(date + "T00:00:00");
        const label = d.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
        html += `<div class="list-date-header">${label}</div>`;
        html += grouped[date].map(eventCardHTML).join("");
      });
    html += "</div></div>";
    swiperContainer.innerHTML = html;
  }

  attachCardListeners(swiperContainer);
}

function setupCategorySwipe() {
  const swiper = document.getElementById("cat-swiper");

  swiper.addEventListener("touchstart", (e) => {
    touchStartX = e.changedTouches[0].screenX;
  });

  swiper.addEventListener("touchend", (e) => {
    touchEndX = e.changedTouches[0].screenX;
    const diff = touchStartX - touchEndX;

    if (Math.abs(diff) > 60) {
      if (diff > 0 && activeCategoryIndex < categories.length - 1) {
        activeCategoryIndex++;
        renderCategories();
      } else if (diff < 0 && activeCategoryIndex > 0) {
        activeCategoryIndex--;
        renderCategories();
      }
    }
  });
}

function setupCalCategorySwipe() {
  const calView = document.getElementById("view-calendar");

  calView.addEventListener("touchstart", (e) => {
    touchStartX = e.changedTouches[0].screenX;
  });

  calView.addEventListener("touchend", (e) => {
    touchEndX = e.changedTouches[0].screenX;
    const diff = touchStartX - touchEndX;

    if (Math.abs(diff) > 60) {
      const catIds = categories.map((c) => c.id);
      const currentIdx = calCategoryFilter === null ? -1 : catIds.indexOf(calCategoryFilter);

      if (diff > 0 && currentIdx < catIds.length - 1) {
        calCategoryFilter = catIds[currentIdx + 1];
        renderCalendar();
      } else if (diff < 0 && currentIdx > -1) {
        calCategoryFilter = currentIdx <= 0 ? null : catIds[currentIdx - 1];
        renderCalendar();
      }
    }
  });
}

// ── Favorites View ──

function renderFavorites() {
  const events = allEvents.filter((e) => e.favorited);
  const container = document.getElementById("fav-events");
  const empty = document.getElementById("fav-empty");

  if (events.length === 0) {
    container.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  // Group by date
  const grouped = {};
  events.forEach((ev) => {
    if (!grouped[ev.date]) grouped[ev.date] = [];
    grouped[ev.date].push(ev);
  });

  let html = "";
  Object.keys(grouped)
    .sort()
    .forEach((date) => {
      const d = new Date(date + "T00:00:00");
      const label = d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      html += `<div class="list-date-header">${label}</div>`;
      html += grouped[date].map(eventCardHTML).join("");
    });

  container.innerHTML = html;
  attachCardListeners(container);
}

// ── Search ──

// Geocoding utilities
function loadGeocodeCache() {
  try {
    const raw = localStorage.getItem("geocodeCache");
    if (raw) geocodeCache = JSON.parse(raw);
  } catch {}
}

function saveGeocodeCache() {
  try {
    localStorage.setItem("geocodeCache", JSON.stringify(geocodeCache));
  } catch {}
}

async function geocodeAddress(address) {
  if (!address) return null;
  const key = address.toLowerCase().trim();
  if (key in geocodeCache) return geocodeCache[key];

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`;
    const res = await fetch(url, { headers: { "User-Agent": "NYCEventsApp/1.0" } });
    const data = await res.json();
    if (data.length > 0) {
      const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      geocodeCache[key] = result;
      saveGeocodeCache();
      return result;
    }
    geocodeCache[key] = null;
    saveGeocodeCache();
    return null;
  } catch {
    return null;
  }
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(miles) {
  if (miles < 0.1) return "< 0.1 mi";
  if (miles < 10) return miles.toFixed(1) + " mi";
  return Math.round(miles) + " mi";
}

async function geocodeSearchResults(results) {
  geocodingInProgress = true;
  geocodingAbort = false;
  const uniqueLocations = [...new Set(results.map(r => r.event.location).filter(Boolean))];
  const toGeocode = uniqueLocations.filter(loc => !(loc.toLowerCase().trim() in geocodeCache));
  const status = document.getElementById("proximity-status");

  for (let i = 0; i < toGeocode.length; i++) {
    if (geocodingAbort) break;
    status.textContent = `Geocoding ${i + 1} of ${toGeocode.length} locations...`;
    // Try with "NYC" context first for better results, fall back to raw location
    let result = await geocodeAddress(toGeocode[i] + ", NYC");
    if (!result) {
      await new Promise(r => setTimeout(r, 1000));
      result = await geocodeAddress(toGeocode[i]);
    }
    // If NYC variant succeeded, also cache under the raw key
    if (result) {
      const rawKey = toGeocode[i].toLowerCase().trim();
      if (!(rawKey in geocodeCache)) {
        geocodeCache[rawKey] = result;
        saveGeocodeCache();
      }
    }
    // Rate limit: 1 request per second for Nominatim
    if (i < toGeocode.length - 1 && !geocodingAbort) {
      await new Promise(r => setTimeout(r, 1000));
    }
    // Re-render incrementally so distances appear as they're resolved
    if (!geocodingAbort && searchActive) renderSearchResults();
  }

  geocodingInProgress = false;
  if (!geocodingAbort && status) {
    status.textContent = toGeocode.length > 0 ? "Done" : "";
  }
}

function setupSearch() {
  const input = document.getElementById("search-input");
  const clearBtn = document.getElementById("search-clear");

  input.addEventListener("input", () => {
    searchQuery = input.value.trim();
    clearBtn.classList.toggle("hidden", !searchQuery);

    if (searchQuery.length > 0) {
      if (!searchActive) {
        previousView = currentView;
        searchActive = true;
        // Show search view, hide others
        document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
        document.getElementById("view-search").classList.add("active");
        // Deactivate nav tabs
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      }
      renderSearchResults();
    } else {
      exitSearch();
    }
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    searchQuery = "";
    clearBtn.classList.add("hidden");
    exitSearch();
    input.focus();
  });

  // Escape while focused in search clears it
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      searchQuery = "";
      clearBtn.classList.add("hidden");
      exitSearch();
      input.blur();
      e.preventDefault();
    }
  });

  // Load geocode cache from localStorage
  loadGeocodeCache();

  // Sort dropdown
  const sortSelect = document.getElementById("search-sort");
  const proximityWrap = document.getElementById("proximity-input-wrap");
  const proximityInput = document.getElementById("proximity-address");
  const proximityGoBtn = document.getElementById("proximity-go");

  sortSelect.addEventListener("change", () => {
    searchSort = sortSelect.value;
    if (searchSort === "proximity") {
      proximityWrap.classList.add("active");
      proximityInput.focus();
    } else {
      proximityWrap.classList.remove("active");
      geocodingAbort = true;
    }
    if (searchActive) renderSearchResults();
  });

  const triggerProximitySearch = async () => {
    const addr = proximityInput.value.trim();
    if (!addr) return;
    proximityAddress = addr;
    const status = document.getElementById("proximity-status");
    status.textContent = "Geocoding address...";
    status.classList.remove("error");
    proximityCoords = await geocodeAddress(addr + " NYC");
    if (!proximityCoords) {
      // Try without NYC suffix
      proximityCoords = await geocodeAddress(addr);
    }
    if (!proximityCoords) {
      status.textContent = "Address not found";
      status.classList.add("error");
      return;
    }
    status.textContent = "";
    status.classList.remove("error");
    renderSearchResults();
    // Start batch geocoding event locations
    const results = searchEvents(searchQuery);
    geocodeSearchResults(results);
  };

  proximityGoBtn.addEventListener("click", triggerProximitySearch);
  proximityInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); triggerProximitySearch(); }
  });
}

function exitSearch() {
  if (!searchActive) return;
  searchActive = false;
  // Reset sort state
  searchSort = "relevance";
  geocodingAbort = true;
  const sortSelect = document.getElementById("search-sort");
  if (sortSelect) sortSelect.value = "relevance";
  const proximityWrap = document.getElementById("proximity-input-wrap");
  if (proximityWrap) proximityWrap.classList.remove("active");
  const sortControls = document.getElementById("search-sort-controls");
  if (sortControls) sortControls.classList.add("hidden");
  // Restore previous view
  const viewName = previousView || "calendar";
  currentView = viewName;
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${viewName}`).classList.add("active");
  const tab = document.querySelector(`.tab[data-view="${viewName}"]`);
  if (tab) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
  }
  renderCurrentView();
}

function fuzzyScore(query, text) {
  if (!text) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact substring match — highest score
  if (t.includes(q)) return 100;

  // Word-start matching: check if query matches the start of any word
  const words = t.split(/\s+/);
  for (const word of words) {
    if (word.startsWith(q)) return 80;
  }

  // All query words present (for multi-word queries like "yoga brooklyn")
  const queryWords = q.split(/\s+/);
  if (queryWords.length > 1) {
    const allPresent = queryWords.every((qw) => t.includes(qw));
    if (allPresent) return 90;
  }

  // Fuzzy character matching: all characters of query appear in order
  let qi = 0;
  let consecutiveBonus = 0;
  let lastMatchIdx = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (ti === lastMatchIdx + 1) consecutiveBonus += 5;
      lastMatchIdx = ti;
      qi++;
    }
  }
  if (qi === q.length) {
    return 40 + consecutiveBonus;
  }

  return 0;
}

function searchEvents(query) {
  if (!query) return [];

  const results = [];
  const today = todayStr();

  for (const ev of allEvents) {
    // Skip past events
    if ((ev.endDate || ev.date) < today) continue;

    const cat = catMap[ev.category];
    const catName = cat ? cat.name : "";

    // Score across multiple fields with weights
    const nameScore = fuzzyScore(query, ev.name) * 3;
    const locationScore = fuzzyScore(query, ev.location) * 2;
    const descScore = fuzzyScore(query, ev.description) * 1.5;
    const catScore = fuzzyScore(query, catName) * 1.5;
    const groupScore = fuzzyScore(query, ev.sourceChat) * 1;

    const totalScore = Math.max(nameScore, locationScore, descScore, catScore, groupScore);

    if (totalScore > 0) {
      // Determine which field matched best for highlighting
      let matchField = "name";
      const scores = { name: nameScore, location: locationScore, description: descScore, category: catScore, group: groupScore };
      let best = 0;
      for (const [field, s] of Object.entries(scores)) {
        if (s > best) { best = s; matchField = field; }
      }

      // Calculate distance if in proximity mode
      let distance = null;
      if (searchSort === "proximity" && proximityCoords && ev.location) {
        const locKey = ev.location.toLowerCase().trim();
        const locCoords = geocodeCache[locKey];
        if (locCoords) {
          distance = haversineDistance(proximityCoords.lat, proximityCoords.lng, locCoords.lat, locCoords.lng);
        }
      }

      results.push({ event: ev, score: totalScore, matchField, distance });
    }
  }

  // Sort based on current mode
  if (searchSort === "date") {
    results.sort((a, b) => {
      const dateCmp = a.event.date.localeCompare(b.event.date);
      if (dateCmp !== 0) return dateCmp;
      const aTime = a.event.startTime || "99:99";
      const bTime = b.event.startTime || "99:99";
      return aTime.localeCompare(bTime);
    });
  } else if (searchSort === "proximity") {
    results.sort((a, b) => {
      // null distances sort to bottom
      if (a.distance == null && b.distance == null) return a.event.date.localeCompare(b.event.date);
      if (a.distance == null) return 1;
      if (b.distance == null) return -1;
      const distCmp = a.distance - b.distance;
      if (Math.abs(distCmp) > 0.01) return distCmp;
      return a.event.date.localeCompare(b.event.date);
    });
  } else {
    // Relevance: score desc, then date asc
    results.sort((a, b) => b.score - a.score || a.event.date.localeCompare(b.event.date));
  }

  return results;
}

function renderSearchResults() {
  const results = searchEvents(searchQuery);
  const container = document.getElementById("search-events");
  const empty = document.getElementById("search-empty");
  const summary = document.getElementById("search-summary");
  const sortControls = document.getElementById("search-sort-controls");

  summary.textContent = results.length > 0
    ? `${results.length} event${results.length !== 1 ? "s" : ""} matching "${searchQuery}"`
    : "";

  if (results.length === 0) {
    container.innerHTML = "";
    empty.classList.remove("hidden");
    sortControls.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  sortControls.classList.remove("hidden");

  let html = "";

  if (searchSort === "proximity") {
    // Flat list (no date grouping) with distance badges
    html = results.map(({ event, matchField, distance }) => {
      const card = eventCardHTML(event);
      // Build distance badge
      let distBadge = "";
      if (!event.location) {
        distBadge = `<span class="event-distance no-location">No location</span>`;
      } else if (distance != null) {
        distBadge = `<span class="event-distance">${formatDistance(distance)}</span>`;
      } else {
        const locKey = event.location.toLowerCase().trim();
        if (locKey in geocodeCache && geocodeCache[locKey] === null) {
          distBadge = `<span class="event-distance no-location">Location not found</span>`;
        } else {
          distBadge = `<span class="event-distance calculating">Calculating...</span>`;
        }
      }
      // Build date label for inline display
      const d = new Date(event.date + "T00:00:00");
      const dateLabel = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const dateInline = `<span class="search-match-hint">${dateLabel}${distBadge}</span>`;
      // Insert date + distance before the last closing </div>
      const lastClose = card.lastIndexOf("</div>");
      return card.slice(0, lastClose) + dateInline + card.slice(lastClose);
    }).join("");
  } else if (searchSort === "relevance") {
    // Flat list sorted by relevance with inline date + match hint
    html = results.map(({ event, matchField }) => {
      let matchHint = "";
      if (matchField === "location" && event.location) matchHint = `Location: ${escapeHtml(event.location)}`;
      else if (matchField === "group" && event.sourceChat) matchHint = `Group: ${escapeHtml(event.sourceChat)}`;
      else if (matchField === "category") {
        const cat = catMap[event.category];
        if (cat) matchHint = `Category: ${escapeHtml(cat.name)}`;
      }
      else if (matchField === "description") matchHint = "Description match";
      const d = new Date(event.date + "T00:00:00");
      const dateLabel = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const inlineInfo = `<span class="search-match-hint">${dateLabel}${matchHint ? " · " + matchHint : ""}</span>`;
      const card = eventCardHTML(event);
      const lastClose = card.lastIndexOf("</div>");
      return card.slice(0, lastClose) + inlineInfo + card.slice(lastClose);
    }).join("");
  } else {
    // Date mode: group by date
    const grouped = {};
    results.forEach(({ event: ev, matchField }) => {
      if (!grouped[ev.date]) grouped[ev.date] = [];
      grouped[ev.date].push({ event: ev, matchField });
    });

    const sortedDates = Object.keys(grouped).sort();
    sortedDates.forEach((date) => {
      const d = new Date(date + "T00:00:00");
      const label = d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      html += `<div class="list-date-header">${label}</div>`;
      html += grouped[date].map(({ event, matchField }) => {
        const card = eventCardHTML(event);
        return card;
      }).join("");
    });
  }

  container.innerHTML = html;
  attachCardListeners(container);
  updateFocusedCards();
}

// ── Keyboard Navigation ──

function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    // Skip when typing in input/select
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    // Skip if modal is open (except Escape and ?)
    const kbHelpOpen = !document.getElementById("kb-help-overlay").classList.contains("hidden");
    if (e.key === "?") {
      toggleKbHelp();
      e.preventDefault();
      return;
    }
    if (e.key === "/") {
      document.getElementById("search-input").focus();
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" && kbHelpOpen) {
      document.getElementById("kb-help-overlay").classList.add("hidden");
      e.preventDefault();
      return;
    }
    if ((isModalOpen() || kbHelpOpen) && e.key !== "Escape") return;

    switch (e.key) {
      case "1": switchToView("calendar"); e.preventDefault(); break;
      case "2": switchToView("list"); e.preventDefault(); break;
      case "3": switchToView("categories"); e.preventDefault(); break;
      case "4": switchToView("favorites"); e.preventDefault(); break;
      case "j":
      case "ArrowDown":
        navigateEvents(1);
        e.preventDefault();
        break;
      case "k":
      case "ArrowUp":
        navigateEvents(-1);
        e.preventDefault();
        break;
      case "f":
        favoriteFocusedEvent();
        e.preventDefault();
        break;
      case "Enter":
        openFocusedEvent();
        e.preventDefault();
        break;
      case "d":
        document.getElementById("dash-toggle").click();
        e.preventDefault();
        break;
      case "ArrowRight":
        if (currentView === "calendar") {
          if (calCategoryFilter === null) {
            calCategoryFilter = categories.length > 0 ? categories[0].id : null;
          } else {
            const idx = categories.findIndex((c) => c.id === calCategoryFilter);
            if (idx < categories.length - 1) calCategoryFilter = categories[idx + 1].id;
          }
          renderCalendar();
          e.preventDefault();
        } else if (currentView === "categories" && activeCategoryIndex < categories.length - 1) {
          activeCategoryIndex++;
          renderCategories();
          e.preventDefault();
        }
        break;
      case "ArrowLeft":
        if (currentView === "calendar") {
          if (calCategoryFilter !== null) {
            const idx = categories.findIndex((c) => c.id === calCategoryFilter);
            calCategoryFilter = idx <= 0 ? null : categories[idx - 1].id;
          }
          renderCalendar();
          e.preventDefault();
        } else if (currentView === "categories" && activeCategoryIndex > 0) {
          activeCategoryIndex--;
          renderCategories();
          e.preventDefault();
        }
        break;
      case "Escape":
        if (isModalOpen()) {
          document.getElementById("modal-overlay").classList.add("hidden");
          e.preventDefault();
        }
        break;
    }
  });
}

function setupKbHelp() {
  // Click keyboard icon: restore persistent panel if dismissed, otherwise toggle full help
  document.querySelector(".kb-hint").addEventListener("click", () => {
    const panel = document.getElementById("kb-persistent-panel");
    if (panel && panel.classList.contains("dismissed")) {
      panel.classList.remove("dismissed");
      localStorage.removeItem("kb-panel-dismissed");
      return;
    }
    toggleKbHelp();
  });

  // Close button
  document.getElementById("kb-help-close").addEventListener("click", () => {
    document.getElementById("kb-help-overlay").classList.add("hidden");
  });

  // Click overlay to close
  document.getElementById("kb-help-overlay").addEventListener("click", (e) => {
    if (e.target.id === "kb-help-overlay") {
      document.getElementById("kb-help-overlay").classList.add("hidden");
    }
  });
}

function setupKbPersistentPanel() {
  const panel = document.getElementById("kb-persistent-panel");
  if (!panel) return;

  if (localStorage.getItem("kb-panel-dismissed") === "true") {
    panel.classList.add("dismissed");
  }

  document.getElementById("kb-persistent-dismiss").addEventListener("click", () => {
    panel.classList.add("dismissed");
    localStorage.setItem("kb-panel-dismissed", "true");
  });
}

function toggleKbHelp() {
  const overlay = document.getElementById("kb-help-overlay");
  overlay.classList.toggle("hidden");
}

function updateFocusedCards() {
  // Collect all visible event cards in the active view
  const activeView = document.querySelector(".view.active");
  if (!activeView) return;
  focusedEventCards = Array.from(activeView.querySelectorAll(".event-card"));

  // Re-apply focus if valid
  focusedEventCards.forEach((c) => c.classList.remove("kb-focused"));
  if (focusedEventIndex >= 0 && focusedEventIndex < focusedEventCards.length) {
    focusedEventCards[focusedEventIndex].classList.add("kb-focused");
  }
}

function navigateEvents(direction) {
  if (focusedEventCards.length === 0) return;

  // Remove old focus
  if (focusedEventIndex >= 0 && focusedEventIndex < focusedEventCards.length) {
    focusedEventCards[focusedEventIndex].classList.remove("kb-focused");
  }

  focusedEventIndex += direction;
  if (focusedEventIndex < 0) focusedEventIndex = 0;
  if (focusedEventIndex >= focusedEventCards.length) focusedEventIndex = focusedEventCards.length - 1;

  const card = focusedEventCards[focusedEventIndex];
  card.classList.add("kb-focused");
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function favoriteFocusedEvent() {
  if (focusedEventIndex < 0 || focusedEventIndex >= focusedEventCards.length) return;
  const card = focusedEventCards[focusedEventIndex];
  const hash = card.dataset.hash;
  if (!hash) return;

  try {
    const res = await apiFetch(`/api/events/${hash}/favorite`, { method: "POST" });
    const result = await res.json();
    const ev = allEvents.find((e) => e.hash === hash);
    if (ev) ev.favorited = result.favorited;
    renderCurrentView();
  } catch (err) {
    console.error("Failed to toggle favorite:", err);
  }
}

function openFocusedEvent() {
  if (focusedEventIndex < 0 || focusedEventIndex >= focusedEventCards.length) return;
  const card = focusedEventCards[focusedEventIndex];
  const hash = card.dataset.hash;
  if (!hash) return;
  const event = allEvents.find((e) => e.hash === hash);
  if (event) showModal(event);
}

function isModalOpen() {
  return !document.getElementById("modal-overlay").classList.contains("hidden");
}

// ── Event Card HTML ──

function eventCardHTML(event) {
  const cat = catMap[event.category];
  const catName = cat ? cat.name : event.category;
  const timeStr = event.startTime
    ? formatTime(event.startTime) + (event.endTime ? ` - ${formatTime(event.endTime)}` : "")
    : "All day";

  return `
    <div class="event-card" data-hash="${event.hash}" data-category="${event.category}">
      <div class="event-top">
        <div>
          <div class="event-name">${escapeHtml(event.name)}</div>
          <div class="event-meta">
            <span>${timeStr}</span>
            ${event.location ? `<span>${escapeHtml(event.location)}</span>` : ""}
          </div>
          <span class="category-badge" data-category="${event.category}">${escapeHtml(catName)}</span>
        </div>
        <div class="card-actions">
          ${isAdmin ? `<button class="delete-btn" data-hash="${event.hash}" title="Delete event">&times;</button>` : ""}
          ${isAdmin ? `<button class="fav-btn ${event.favorited ? "favorited" : ""}" data-hash="${event.hash}" title="Toggle favorite">
            ${event.favorited ? "\u2665" : "\u2661"}
          </button>` : ""}
        </div>
      </div>
    </div>`;
}

function attachCardListeners(container) {
  // Favorite buttons
  container.querySelectorAll(".fav-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const hash = btn.dataset.hash;
      try {
        const res = await apiFetch(`/api/events/${hash}/favorite`, { method: "POST" });
        const result = await res.json();
        // Update local state
        const ev = allEvents.find((e) => e.hash === hash);
        if (ev) ev.favorited = result.favorited;
        renderCurrentView();
      } catch (err) {
        console.error("Failed to toggle favorite:", err);
      }
    });
  });

  // Delete buttons (admin)
  container.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const hash = btn.dataset.hash;
      const ev = allEvents.find((e) => e.hash === hash);
      if (!ev || !confirm(`Delete "${ev.name}"?`)) return;
      try {
        await adminFetch(`/api/events/${hash}`, { method: "DELETE" });
        allEvents = allEvents.filter((e) => e.hash !== hash);
        renderCurrentView();
      } catch (err) {
        console.error("Failed to delete event:", err);
      }
    });
  });

  // Card click -> modal
  container.querySelectorAll(".event-card").forEach((card) => {
    card.addEventListener("click", () => {
      const hash = card.dataset.hash;
      const event = allEvents.find((e) => e.hash === hash);
      if (event) showModal(event);
    });
  });
}

// ── Modal ──

function setupModal() {
  const overlay = document.getElementById("modal-overlay");
  document.getElementById("modal-close").addEventListener("click", () => {
    overlay.classList.add("hidden");
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.add("hidden");
  });
}

function showModal(event) {
  const cat = catMap[event.category];
  const catName = cat ? cat.name : event.category;
  const timeStr = event.startTime
    ? formatTime(event.startTime) + (event.endTime ? ` - ${formatTime(event.endTime)}` : "")
    : "All day";

  const dateStr2 = new Date(event.date + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  let endDateStr = "";
  if (event.endDate && event.endDate !== event.date) {
    endDateStr = " to " + new Date(event.endDate + "T00:00:00").toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }

  const content = document.getElementById("modal-content");
  content.innerHTML = `
    <h2>${escapeHtml(event.name)}</h2>
    <div class="detail-row">
      <span class="detail-label">Date</span>
      <span class="detail-value">${dateStr2}${endDateStr}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Time</span>
      <span class="detail-value">${timeStr}</span>
    </div>
    ${event.location ? `
    <div class="detail-row">
      <span class="detail-label">Location</span>
      <span class="detail-value">${escapeHtml(event.location)}</span>
    </div>` : ""}
    <div class="detail-row">
      <span class="detail-label">Category</span>
      <span class="detail-value">
        <span class="category-badge" data-category="${event.category}">${escapeHtml(catName)}</span>
      </span>
    </div>
    ${event.url && /^https?:\/\//i.test(event.url) ? `
    <div class="detail-row">
      <span class="detail-label">Link</span>
      <span class="detail-value"><a href="${escapeHtml(event.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(event.url)}</a></span>
    </div>` : ""}
    <div class="detail-row">
      <span class="detail-label">Source</span>
      <span class="detail-value">${escapeHtml(event.sourceChat || "Unknown")}</span>
    </div>
    ${event.description ? `<div class="detail-description">${escapeHtml(event.description)}</div>` : ""}
    ${event.sourceText ? `
    <button class="source-toggle" onclick="this.classList.toggle('open'); this.nextElementSibling.classList.toggle('open');">
      <span class="arrow">&#9654;</span> View raw source message
    </button>
    <div class="source-text">${escapeHtml(event.sourceText)}</div>
    ` : ""}
  `;

  document.getElementById("modal-overlay").classList.remove("hidden");
}

// ── Utilities ──

function todayStr() {
  return dateStr(new Date());
}

function dateStr(d) {
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

function formatTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":");
  const hour = parseInt(h);
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12}:${m} ${ampm}`;
}

const _escapeEl = document.createElement("div");
function escapeHtml(str) {
  if (!str) return "";
  _escapeEl.textContent = str;
  return _escapeEl.innerHTML;
}

function escapeAttr(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
