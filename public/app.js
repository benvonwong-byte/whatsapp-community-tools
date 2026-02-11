// Admin mode: add ?admin=TOKEN to the URL to enable admin features
const adminToken = new URLSearchParams(window.location.search).get("admin");
const isAdmin = !!adminToken;

// State
let allEvents = [];
let categories = [];
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
  setupRecentBanner();
  setupQrOverlay();
  pollStatus();
  renderCurrentView();
  // Poll for new events every 30s
  setInterval(loadData, 30000);
  // Poll WhatsApp status every 10s
  setInterval(pollStatus, 10000);
});

// Helper: fetch an admin-protected endpoint with the token
function adminFetch(url, options = {}) {
  const separator = url.includes("?") ? "&" : "?";
  return fetch(`${url}${separator}token=${encodeURIComponent(adminToken)}`, options);
}

async function loadData() {
  try {
    const fetches = [
      fetch("/api/events"),
      fetch("/api/categories"),
      fetch("/api/stats"),
      fetch("/api/events/recent?limit=15"),
    ];
    // Only fetch blocked groups in admin mode (requires auth)
    if (isAdmin) {
      fetches.push(adminFetch("/api/groups/blocked"));
    }

    const results = await Promise.all(fetches);
    allEvents = await results[0].json();
    categories = await results[1].json();
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
      document.querySelector(".tab.active").classList.remove("active");
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

  // Sort
  const sortBy = document.getElementById("dash-sort").value;
  const sorted = [...groups].sort((a, b) => {
    if (sortBy === "events") return b.eventCount - a.eventCount;
    if (sortBy === "lastActive") {
      if (!a.lastActive && !b.lastActive) return 0;
      if (!a.lastActive) return 1;
      if (!b.lastActive) return -1;
      return b.lastActive.localeCompare(a.lastActive);
    }
    return b.ratio - a.ratio;
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
          const cat = categories.find((c) => c.id === catId);
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
    const res = await fetch("/api/status");
    const data = await res.json();
    waConnected = data.whatsappConnected;
  } catch {
    waConnected = false;
  }
  renderStatus();
}

function renderStatus() {
  const el = document.getElementById("wa-status");
  if (waConnected === null) {
    el.className = "wa-status checking";
    el.title = "WhatsApp: checking...";
    el.querySelector(".wa-label").textContent = "Checking...";
  } else if (waConnected) {
    el.className = "wa-status connected";
    el.title = "WhatsApp: connected";
    el.querySelector(".wa-label").textContent = "Connected";
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
  }
}

// ── Admin Mode ──

function setupAdminMode() {
  if (!isAdmin) {
    // Hide admin-only elements
    document.getElementById("dashboard-panel").classList.add("hidden");
    document.body.classList.add("public-mode");
    // Hide favorites tab in public mode
    const favTab = document.querySelector('.tab[data-view="favorites"]');
    if (favTab) favTab.classList.add("hidden");
    return;
  }

  document.body.classList.add("admin-mode");

  // Make status badge clickable to open QR
  document.getElementById("wa-status").addEventListener("click", () => {
    if (!waConnected && isAdmin) {
      openQrOverlay();
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
      const cat = categories.find((c) => c.id === ev.category);
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
    const res = await fetch(`/api/events/group/${encodeURIComponent(chatName)}`);
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
        const cat = categories.find((c) => c.id === ev.category);
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

// ── Keyboard Navigation ──

function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    // Skip when typing in input/select
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    // Skip if modal is open (except Escape and ?)
    const kbHelpOpen = !document.getElementById("kb-help-overlay").classList.contains("hidden");
    if (e.key === "?" || e.key === "/") {
      toggleKbHelp();
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
    const res = await fetch(`/api/events/${hash}/favorite`, { method: "POST" });
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
  const cat = categories.find((c) => c.id === event.category);
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
        ${isAdmin ? `<button class="fav-btn ${event.favorited ? "favorited" : ""}" data-hash="${event.hash}" title="Toggle favorite">
          ${event.favorited ? "\u2665" : "\u2661"}
        </button>` : ""}
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
        const res = await fetch(`/api/events/${hash}/favorite`, { method: "POST" });
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
  const cat = categories.find((c) => c.id === event.category);
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
    ${event.url ? `
    <div class="detail-row">
      <span class="detail-label">Link</span>
      <span class="detail-value"><a href="${escapeHtml(event.url)}" target="_blank" rel="noopener">${escapeHtml(event.url)}</a></span>
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

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
