// Auth: check URL params (?token= or ?admin=) then localStorage
const _params = new URLSearchParams(window.location.search);
const adminToken = _params.get("token") || _params.get("admin") || localStorage.getItem("adminToken");
const isAdmin = !!adminToken;
if (adminToken && !localStorage.getItem("adminToken")) {
  localStorage.setItem("adminToken", adminToken);
}

// API base: use Railway URL when hosted on Firebase, relative path otherwise
const API_BASE =
  window.location.hostname.includes("firebaseapp.com") ||
  window.location.hostname.includes("web.app")
    ? "https://whatsapp-events-nyc-production.up.railway.app"
    : "";

// Admin fetch helper — adds auth token
function adminFetch(path, opts = {}) {
  const headers = opts.headers ? { ...opts.headers } : {};
  headers["Authorization"] = `Bearer ${adminToken}`;
  return fetch(`${API_BASE}${path}`, { ...opts, headers });
}

// State
let stats = null;
let summaries = [];
let links = [];
let leaderboard = [];
let settings = {};
let activeLinkCategory = "all";
let expandedSummaries = new Set();
let refreshTimer = null;
let dailyDigests = [];
let upcomingEvents = [];
let topics = [];
let activeTopicPeriod = "week";

// ── Init ──

document.addEventListener("DOMContentLoaded", () => {
  if (!isAdmin) {
    document.getElementById("login-gate").classList.remove("hidden");
    document.getElementById("summarize-btn").classList.add("hidden");
    return;
  }

  document.getElementById("main-content").classList.remove("hidden");
  setupSummarizeButton();
  setupLinkFilterTabs();
  setupSettingsToggle();
  setupSettingsSave();
  setupScheduleVisibility();
  setupTopicPeriodTabs();
  loadDashboard();

  // Auto-refresh every 60 seconds
  refreshTimer = setInterval(loadDashboard, 60000);
});

// ── Data Loading ──

async function loadDashboard() {
  try {
    const [statsRes, summariesRes, linksRes, leaderboardRes, settingsRes, dailyRes, eventsRes, topicsRes] =
      await Promise.all([
        adminFetch("/api/metacrisis/stats"),
        adminFetch("/api/metacrisis/summaries?days=30&type=weekly"),
        adminFetch("/api/metacrisis/links?limit=50"),
        adminFetch("/api/metacrisis/leaderboard?limit=10"),
        adminFetch("/api/metacrisis/settings"),
        adminFetch("/api/metacrisis/summaries?days=7&type=daily"),
        adminFetch("/api/metacrisis/events"),
        adminFetch(`/api/metacrisis/topics?period=${activeTopicPeriod}`),
      ]);

    if (!statsRes.ok) throw new Error(`Stats: ${statsRes.status}`);
    if (!summariesRes.ok) throw new Error(`Summaries: ${summariesRes.status}`);
    if (!linksRes.ok) throw new Error(`Links: ${linksRes.status}`);
    if (!leaderboardRes.ok) throw new Error(`Leaderboard: ${leaderboardRes.status}`);
    if (!settingsRes.ok) throw new Error(`Settings: ${settingsRes.status}`);

    stats = await statsRes.json();
    summaries = await summariesRes.json();
    links = await linksRes.json();
    leaderboard = await leaderboardRes.json();
    settings = await settingsRes.json();
    dailyDigests = dailyRes.ok ? await dailyRes.json() : [];
    upcomingEvents = eventsRes.ok ? await eventsRes.json() : [];
    topics = topicsRes.ok ? await topicsRes.json() : [];

    renderDashboard();
  } catch (err) {
    console.error("Failed to load dashboard:", err);
    document.getElementById("loading-state").classList.add("hidden");
    const errorEl = document.getElementById("error-state");
    errorEl.textContent = `Failed to load dashboard: ${err.message}`;
    errorEl.classList.remove("hidden");
  }
}

// ── Summarize Now ──

function setupSummarizeButton() {
  const btn = document.getElementById("summarize-btn");
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Summarizing...";
    try {
      const res = await adminFetch("/api/metacrisis/summarize", {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server returned ${res.status}`);
      }
      await loadDashboard();
    } catch (err) {
      console.error("Summarization failed:", err);
      alert("Summarization failed: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Summarize Now";
    }
  });
}

// ── Link Filter Tabs ──

function setupLinkFilterTabs() {
  const container = document.getElementById("link-filter-tabs");
  container.addEventListener("click", (e) => {
    const tab = e.target.closest(".filter-tab");
    if (!tab) return;
    activeLinkCategory = tab.dataset.category;
    container
      .querySelectorAll(".filter-tab")
      .forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    renderLinks();
  });
}

// ── Settings Toggle ──

function setupSettingsToggle() {
  const toggle = document.getElementById("settings-toggle");
  const body = document.getElementById("settings-body");
  toggle.addEventListener("click", () => {
    const isOpen = body.classList.toggle("open");
    toggle.textContent = isOpen ? "Hide settings" : "Show settings";
  });
}

// ── Schedule visibility (show push day only for weekly) ──

function setupScheduleVisibility() {
  const scheduleEl = document.getElementById("setting-schedule");
  scheduleEl.addEventListener("change", () => {
    updateDayRowVisibility();
  });
}

function updateDayRowVisibility() {
  const scheduleEl = document.getElementById("setting-schedule");
  const dayRow = document.getElementById("setting-day-row");
  if (scheduleEl.value === "weekly") {
    dayRow.style.display = "flex";
  } else {
    dayRow.style.display = "none";
  }
}

// ── Topic Period Tabs ──

function setupTopicPeriodTabs() {
  const container = document.getElementById("topic-period-tabs");
  if (!container) return;
  container.addEventListener("click", async (e) => {
    const tab = e.target.closest(".topic-period-tab");
    if (!tab) return;
    activeTopicPeriod = tab.dataset.period;
    container.querySelectorAll(".topic-period-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    // Fetch new topic data for the selected period
    try {
      const res = await adminFetch(`/api/metacrisis/topics?period=${activeTopicPeriod}`);
      if (res.ok) {
        topics = await res.json();
        renderTopics();
      }
    } catch (err) {
      console.error("Failed to load topics:", err);
    }
  });
}

// ── Settings Save ──

function setupSettingsSave() {
  const btn = document.getElementById("settings-save-btn");
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Saving...";
    try {
      const body = {
        push_schedule: document.getElementById("setting-schedule").value,
        push_day: document.getElementById("setting-day").value,
        push_hour: parseInt(document.getElementById("setting-hour").value, 10),
        format_template: document.getElementById("setting-template").value,
      };
      const res = await adminFetch("/api/metacrisis/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server returned ${res.status}`);
      }
      const result = await res.json();
      settings = result.settings || settings;
      renderSettings();
    } catch (err) {
      console.error("Failed to save settings:", err);
      alert("Failed to save settings: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Save Settings";
    }
  });
}

// ── Rendering ──

function renderDashboard() {
  document.getElementById("loading-state").classList.add("hidden");
  document.getElementById("error-state").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");

  renderMonitorBar();
  renderStats();
  renderDailyDigest();
  renderUpcomingEvents();
  renderTopics();
  renderLinks();
  renderLeaderboard();
  renderSummaries();
  renderSettings();
}

// ── Monitor Bar ──

function renderMonitorBar() {
  const dot = document.getElementById("monitor-dot");
  const lastMsgEl = document.getElementById("monitor-last-msg");
  const todayEl = document.getElementById("monitor-today-count");

  const rawTs = stats?.lastMessageTimestamp;
  // Backend returns Unix timestamp (number) — convert to ISO string for formatRelativeTime
  const lastMsg = rawTs ? (typeof rawTs === "number" ? new Date(rawTs * 1000).toISOString() : String(rawTs)) : null;
  const todayCount = stats?.todayMessageCount ?? 0;

  // Determine recency color
  let color = "red";
  if (lastMsg) {
    const diffMin = (Date.now() - new Date(lastMsg).getTime()) / 60000;
    if (diffMin < 30) color = "green";
    else if (diffMin < 120) color = "yellow";
  }

  dot.className = "monitor-dot " + color;

  if (lastMsg) {
    lastMsgEl.innerHTML = `Last message: <strong>${formatRelativeTime(lastMsg)}</strong>`;
  } else {
    lastMsgEl.innerHTML = `Last message: <strong>--</strong>`;
  }

  todayEl.innerHTML = `Today: <strong>${todayCount}</strong> messages`;
}

// ── Stats Grid ──

function renderStats() {
  document.getElementById("stat-total-messages").textContent = (
    stats?.totalMessages ?? 0
  ).toLocaleString();
  document.getElementById("stat-summaries").textContent = (
    stats?.totalSummaries ?? 0
  ).toLocaleString();
  document.getElementById("stat-links").textContent = (
    stats?.totalLinks ?? 0
  ).toLocaleString();
  document.getElementById("stat-members").textContent = (
    leaderboard?.length ?? 0
  ).toLocaleString();
}

// ── Daily Digest ──

function renderDailyDigest() {
  const container = document.getElementById("digest-content");
  if (!container) return;

  if (!dailyDigests || dailyDigests.length === 0) {
    container.innerHTML = '<div class="digest-empty">No daily digests yet. They run automatically at 9 AM.</div>';
    return;
  }

  // Show the most recent daily digest
  const latest = dailyDigests[0];
  const dateObj = new Date(latest.date + "T00:00:00");
  const dateLabel = dateObj.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  let html = `<div class="digest-date-label">${escapeHtml(dateLabel)} &middot; ${latest.message_count ?? 0} messages</div>`;

  // Who Said What
  const whoSaidWhat = safeJsonParse(latest.who_said_what_json);
  if (whoSaidWhat.length > 0) {
    html += '<ul class="digest-who-list">';
    for (const entry of whoSaidWhat) {
      html += `<li class="digest-who-item"><span class="digest-who-name">${escapeHtml(entry.sender || entry.name || "Unknown")}</span>: ${escapeHtml(entry.summary || entry.contribution || "")}</li>`;
    }
    html += '</ul>';
  }

  // General Reaction / Mood
  if (latest.summary) {
    html += `<div class="digest-mood">${escapeHtml(latest.summary)}</div>`;
  }

  // Recommendations
  const recs = safeJsonParse(latest.recommendations_json);
  if (recs.length > 0) {
    html += '<div class="digest-recs">';
    html += '<div class="digest-recs-title">Action Needed</div>';
    for (const rec of recs) {
      html += `<div class="digest-rec-item">${escapeHtml(typeof rec === "string" ? rec : rec.text || rec.recommendation || JSON.stringify(rec))}</div>`;
    }
    html += '</div>';
  }

  container.innerHTML = html;
}

// ── Upcoming Events ──

function renderUpcomingEvents() {
  const container = document.getElementById("events-list");
  if (!container) return;

  if (!upcomingEvents || upcomingEvents.length === 0) {
    container.innerHTML = '<div class="events-empty">No upcoming events tracked.</div>';
    return;
  }

  container.innerHTML = upcomingEvents.map((evt) => {
    const dateObj = evt.date ? new Date(evt.date + "T00:00:00") : null;
    const monthStr = dateObj ? dateObj.toLocaleDateString("en-US", { month: "short" }) : "TBA";
    const dayStr = dateObj ? dateObj.getDate() : "?";

    let details = [];
    if (evt.start_time) details.push(evt.start_time);
    if (evt.location) details.push(evt.location);
    const detailStr = details.join(" &middot; ");

    const nameHtml = evt.url
      ? `<a href="${escapeAttr(evt.url)}" target="_blank" rel="noopener">${escapeHtml(evt.name || "Untitled Event")}</a>`
      : escapeHtml(evt.name || "Untitled Event");

    return `
    <div class="event-card">
      <div class="event-date-box">
        <div class="event-date-month">${escapeHtml(monthStr)}</div>
        <div class="event-date-day">${escapeHtml(String(dayStr))}</div>
      </div>
      <div class="event-info">
        <div class="event-name">${nameHtml}</div>
        ${detailStr ? `<div class="event-detail">${detailStr}</div>` : ""}
        ${evt.description ? `<div class="event-detail">${escapeHtml(evt.description)}</div>` : ""}
      </div>
    </div>`;
  }).join("");
}

// ── Topic Trends ──

function renderTopics() {
  const container = document.getElementById("topics-list");
  if (!container) return;

  if (!topics || topics.length === 0) {
    container.innerHTML = '<div class="topics-empty">No topic data yet for this period.</div>';
    return;
  }

  const maxCount = topics[0]?.total_mentions || topics[0]?.count || 1;

  container.innerHTML = topics.map((t) => {
    const count = t.total_mentions || t.count || 0;
    const pct = Math.max(2, Math.round((count / maxCount) * 100));
    return `
    <div class="topic-bar-item">
      <span class="topic-bar-name">${escapeHtml(t.topic)}</span>
      <div class="topic-bar-bg">
        <div class="topic-bar-fill" style="width: ${pct}%"></div>
      </div>
      <span class="topic-bar-count">${count}</span>
    </div>`;
  }).join("");
}

// ── Links ──

function renderLinks() {
  const container = document.getElementById("links-list");
  const filtered =
    activeLinkCategory === "all"
      ? links
      : links.filter(
          (l) =>
            (l.category || "other").toLowerCase() ===
            activeLinkCategory.toLowerCase()
        );

  if (filtered.length === 0) {
    container.innerHTML =
      '<div class="link-empty">No links found for this category.</div>';
    return;
  }

  container.innerHTML = filtered
    .map((link) => {
      const cat = (link.category || "other").toLowerCase();
      const displayUrl = truncateUrl(link.url, 60);
      const title = link.title
        ? escapeHtml(link.title)
        : escapeHtml(displayUrl);
      const sender = link.sender_name
        ? escapeHtml(link.sender_name)
        : "Unknown";
      const timeStr = link.timestamp
        ? formatRelativeTime(typeof link.timestamp === "number" ? new Date(link.timestamp * 1000).toISOString() : link.timestamp)
        : "";

      return `
      <div class="link-item">
        <a class="link-url" href="${escapeAttr(link.url)}" target="_blank" rel="noopener" title="${escapeAttr(link.url)}">${title}</a>
        <span class="link-category-badge ${escapeAttr(cat)}">${escapeHtml(cat)}</span>
        <span class="link-meta">${sender}${timeStr ? " &middot; " + timeStr : ""}</span>
      </div>`;
    })
    .join("");
}

// ── Leaderboard ──

function renderLeaderboard() {
  const container = document.getElementById("leaderboard-list");

  if (!leaderboard || leaderboard.length === 0) {
    container.innerHTML =
      '<div class="leaderboard-empty">No member data yet.</div>';
    return;
  }

  const maxCount = leaderboard[0]?.message_count || 1;

  container.innerHTML = leaderboard
    .map((member, i) => {
      const pct = Math.max(
        2,
        Math.round((member.message_count / maxCount) * 100)
      );
      return `
      <div class="leaderboard-item">
        <span class="leaderboard-rank">#${i + 1}</span>
        <span class="leaderboard-name">${escapeHtml(member.sender_name)}</span>
        <div class="leaderboard-bar-bg">
          <div class="leaderboard-bar-fill" style="width: ${pct}%"></div>
        </div>
        <span class="leaderboard-count">${(member.message_count ?? 0).toLocaleString()} msgs</span>
      </div>`;
    })
    .join("");
}

// ── Summaries ──

function renderSummaries() {
  const container = document.getElementById("summaries-list");

  if (!summaries || summaries.length === 0) {
    container.innerHTML =
      '<div class="summary-empty">No summaries generated yet. Click "Summarize Now" to create one.</div>';
    return;
  }

  container.innerHTML = summaries
    .map((s) => {
      const dateObj = new Date(s.date + "T00:00:00");
      const dateLabel = dateObj.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      const expanded = expandedSummaries.has(s.id);
      const topics = parseTopics(s.key_topics_json);
      const isPushed = s.pushed === 1 || s.pushed === true;

      return `
      <div class="summary-card${expanded ? " expanded" : ""}" data-id="${s.id}" data-date="${escapeAttr(s.date)}">
        <div class="summary-card-header" data-action="toggle">
          <span class="summary-card-date">${dateLabel}</span>
          <span class="summary-card-count">${s.message_count ?? 0} msgs</span>
          <span class="summary-push-status">
            ${
              isPushed
                ? '<span class="push-badge pushed">Pushed &#10003;</span>'
                : `<button class="push-btn" data-action="push" data-date="${escapeAttr(s.date)}">Push to Group</button>`
            }
          </span>
        </div>
        ${
          topics.length > 0
            ? `<div class="summary-topics">${topics.map((t) => `<span class="topic-tag">${escapeHtml(t)}</span>`).join("")}</div>`
            : ""
        }
        ${!expanded ? '<div class="summary-expand-hint">Click to expand summary...</div>' : ""}
        <div class="summary-text">${escapeHtml(s.summary)}</div>
      </div>`;
    })
    .join("");

  // Attach event listeners
  container.querySelectorAll(".summary-card-header[data-action='toggle']").forEach((header) => {
    header.addEventListener("click", (e) => {
      // Don't toggle if clicking push button
      if (e.target.closest("[data-action='push']")) return;
      const card = header.closest(".summary-card");
      const id = parseInt(card.dataset.id, 10);
      if (expandedSummaries.has(id)) {
        expandedSummaries.delete(id);
      } else {
        expandedSummaries.add(id);
      }
      renderSummaries();
    });
  });

  container.querySelectorAll("[data-action='push']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handlePush(btn);
    });
  });
}

async function handlePush(btn) {
  const date = btn.dataset.date;
  if (!confirm(`Push the summary for ${date} to the WhatsApp group?`)) return;

  btn.disabled = true;
  btn.textContent = "Pushing...";
  try {
    const res = await adminFetch(`/api/metacrisis/push/${encodeURIComponent(date)}`, {
      method: "POST",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server returned ${res.status}`);
    }
    // Refresh data after push
    await loadDashboard();
  } catch (err) {
    console.error("Push failed:", err);
    alert("Push failed: " + err.message);
    btn.disabled = false;
    btn.textContent = "Push to Group";
  }
}

// ── Settings ──

function renderSettings() {
  const scheduleEl = document.getElementById("setting-schedule");
  const dayEl = document.getElementById("setting-day");
  const hourEl = document.getElementById("setting-hour");
  const templateEl = document.getElementById("setting-template");

  if (settings.push_schedule) scheduleEl.value = settings.push_schedule;
  if (settings.push_day) dayEl.value = settings.push_day;
  if (settings.push_hour !== undefined) hourEl.value = settings.push_hour;
  if (settings.format_template) templateEl.value = settings.format_template;

  updateDayRowVisibility();
}

// ── Utilities ──

function formatRelativeTime(str) {
  if (!str) return "";
  const normalized = str.includes("T") ? str : str.replace(" ", "T");
  const date = new Date(
    normalized +
      (normalized.includes("Z") || normalized.includes("+") ? "" : "Z")
  );
  if (isNaN(date.getTime())) return str;
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 0) return "just now";
  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function truncateUrl(url, maxLen) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const display = u.hostname + u.pathname;
    if (display.length > maxLen) return display.slice(0, maxLen) + "...";
    return display;
  } catch {
    if (url.length > maxLen) return url.slice(0, maxLen) + "...";
    return url;
  }
}

function parseTopics(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const _escEl = document.createElement("div");
function escapeHtml(str) {
  if (!str) return "";
  _escEl.textContent = str;
  return _escEl.innerHTML;
}

function escapeAttr(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeJsonParse(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
