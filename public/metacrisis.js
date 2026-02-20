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

// Composer state
let weeklyDraft = null;
let composerEvents = {};    // { index: boolean } — which events are checked
let composerResources = {}; // { index: boolean } — which resources are checked
let composerShowMember = true;
let composerShowEvents = true;
let composerShowResources = true;
let composerShowPulse = true;
let composerShowBuckets = true;
let composerShowHighlights = true;
let composerBuckets = {};     // { senderName: boolean } — which discussion buckets are checked

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
  setupComposer();
  loadDashboard();

  // Auto-refresh every 60 seconds
  refreshTimer = setInterval(loadDashboard, 60000);
});

// ── Data Loading ──

async function loadDashboard() {
  try {
    const [statsRes, summariesRes, linksRes, leaderboardRes, settingsRes, dailyRes, eventsRes, topicsRes, draftRes] =
      await Promise.all([
        adminFetch("/api/metacrisis/stats"),
        adminFetch("/api/metacrisis/summaries?days=30&type=weekly"),
        adminFetch("/api/metacrisis/links?limit=50"),
        adminFetch("/api/metacrisis/leaderboard?limit=10"),
        adminFetch("/api/metacrisis/settings"),
        adminFetch("/api/metacrisis/summaries?days=7&type=daily"),
        adminFetch("/api/metacrisis/events"),
        adminFetch(`/api/metacrisis/topics?period=${activeTopicPeriod}`),
        adminFetch("/api/metacrisis/weekly-draft"),
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

    // Load weekly draft for composer
    if (draftRes.ok) {
      const draft = await draftRes.json();
      // Only reset composer state on first load (when weeklyDraft is null)
      if (!weeklyDraft) {
        weeklyDraft = draft;
        composerEvents = {};
        (draft.events || []).forEach(function(_, i) { composerEvents[i] = true; });
        composerResources = {};
        (draft.topResources || []).forEach(function(_, i) { composerResources[i] = true; });
        composerShowMember = true;
        composerShowEvents = true;
        composerShowResources = true;
        composerShowPulse = true;
        composerShowBuckets = true;
        composerShowHighlights = true;
        composerBuckets = {};
        (draft.discussionBuckets || []).forEach(function(b) { composerBuckets[b.sender] = true; });
        var pulseEl = document.getElementById("composer-pulse-text");
        if (pulseEl) pulseEl.value = draft.communityPulse || "";
      } else {
        // Refresh data but keep user's toggle state
        weeklyDraft = draft;
      }
    }

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
  renderComposer();
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

// ── Weekly Update Composer ──

function setupComposer() {
  // Section toggles
  var evtToggle = document.getElementById("composer-events-toggle");
  var resToggle = document.getElementById("composer-resources-toggle");
  var memToggle = document.getElementById("composer-member-toggle");
  var pulseToggle = document.getElementById("composer-pulse-toggle");

  var bucketsToggle = document.getElementById("composer-buckets-toggle");
  var highlightsToggle = document.getElementById("composer-highlights-toggle");

  if (evtToggle) evtToggle.addEventListener("change", function() { composerShowEvents = evtToggle.checked; updateComposerPreview(); });
  if (resToggle) resToggle.addEventListener("change", function() { composerShowResources = resToggle.checked; updateComposerPreview(); });
  if (memToggle) memToggle.addEventListener("change", function() { composerShowMember = memToggle.checked; updateComposerPreview(); });
  if (pulseToggle) pulseToggle.addEventListener("change", function() { composerShowPulse = pulseToggle.checked; updateComposerPreview(); });
  if (bucketsToggle) bucketsToggle.addEventListener("change", function() { composerShowBuckets = bucketsToggle.checked; updateComposerPreview(); });
  if (highlightsToggle) highlightsToggle.addEventListener("change", function() { composerShowHighlights = highlightsToggle.checked; updateComposerPreview(); });

  // Pulse text edit
  var pulseText = document.getElementById("composer-pulse-text");
  if (pulseText) pulseText.addEventListener("input", function() { updateComposerPreview(); });

  // Copy button
  var copyBtn = document.getElementById("composer-copy");
  if (copyBtn) copyBtn.addEventListener("click", function() {
    var preview = document.getElementById("composer-preview");
    if (!preview) return;
    navigator.clipboard.writeText(preview.textContent || "").then(function() {
      var statusEl = document.getElementById("composer-status");
      if (statusEl) { statusEl.textContent = "Copied to clipboard!"; setTimeout(function() { statusEl.textContent = ""; }, 2000); }
    });
  });

  // Push button
  var pushBtn = document.getElementById("composer-push");
  if (pushBtn) pushBtn.addEventListener("click", handleComposerPush);

  // Regenerate button
  var regenBtn = document.getElementById("composer-regenerate");
  if (regenBtn) regenBtn.addEventListener("click", handleRegeneratePulse);
}

function renderComposer() {
  if (!weeklyDraft) return;

  // Date range
  var rangeEl = document.getElementById("composer-date-range");
  if (rangeEl) rangeEl.textContent = weeklyDraft.dateRange || "";

  // Events list with individual checkboxes
  var eventsList = document.getElementById("composer-events-list");
  if (eventsList) {
    var events = weeklyDraft.events || [];
    if (events.length === 0) {
      eventsList.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding-left:22px;">No upcoming events.</div>';
    } else {
      eventsList.innerHTML = events.map(function(evt, i) {
        var checked = composerEvents[i] !== false ? "checked" : "";
        var dateStr = evt.date ? new Date(evt.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "TBA";
        var details = [dateStr];
        if (evt.start_time) details.push(evt.start_time);
        if (evt.location) details.push(evt.location);
        return '<div class="composer-event-row">' +
          '<input type="checkbox" data-event-idx="' + i + '" ' + checked + '>' +
          '<span>' + escapeHtml(evt.name || "Untitled") + '</span>' +
          '<span class="composer-event-meta">' + escapeHtml(details.join(" · ")) + '</span>' +
        '</div>';
      }).join("");

      // Attach change listeners
      eventsList.querySelectorAll("input[data-event-idx]").forEach(function(cb) {
        cb.addEventListener("change", function() {
          composerEvents[parseInt(cb.dataset.eventIdx)] = cb.checked;
          updateComposerPreview();
        });
      });
    }
  }

  // Resources list
  var resourcesList = document.getElementById("composer-resources-list");
  if (resourcesList) {
    var resources = weeklyDraft.topResources || [];
    if (resources.length === 0) {
      resourcesList.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding-left:22px;">No resources shared this week.</div>';
    } else {
      resourcesList.innerHTML = resources.map(function(res, i) {
        var checked = composerResources[i] !== false ? "checked" : "";
        var displayUrl = truncateUrl(res.url, 50);
        return '<div class="composer-resource-row">' +
          '<input type="checkbox" data-resource-idx="' + i + '" ' + checked + '>' +
          '<a href="' + escapeAttr(res.url) + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-size:12px;">' + escapeHtml(res.title || displayUrl) + '</a>' +
          '<span class="composer-resource-meta">(' + (res.share_count || 1) + 'x' + (res.shared_by ? ' by ' + escapeHtml(res.shared_by) : '') + ')</span>' +
        '</div>';
      }).join("");

      resourcesList.querySelectorAll("input[data-resource-idx]").forEach(function(cb) {
        cb.addEventListener("change", function() {
          composerResources[parseInt(cb.dataset.resourceIdx)] = cb.checked;
          updateComposerPreview();
        });
      });
    }
  }

  // Most active member
  var memberContent = document.getElementById("composer-member-content");
  if (memberContent) {
    var member = weeklyDraft.topMember;
    if (member) {
      memberContent.textContent = member.sender_name + " — " + member.message_count + " messages this week";
    } else {
      memberContent.textContent = "No member data this week.";
    }
  }

  // Pulse text (only set if not user-edited)
  var pulseEl = document.getElementById("composer-pulse-text");
  if (pulseEl && !pulseEl.dataset.userEdited) {
    pulseEl.value = weeklyDraft.communityPulse || "";
  }

  // Discussion Buckets — messages with links grouped by sender
  var bucketsList = document.getElementById("composer-buckets-list");
  if (bucketsList) {
    var buckets = weeklyDraft.discussionBuckets || [];
    if (buckets.length === 0) {
      bucketsList.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding-left:22px;">No shared links this week.</div>';
    } else {
      bucketsList.innerHTML = buckets.map(function(bucket) {
        var senderKey = bucket.sender;
        var checked = composerBuckets[senderKey] !== false ? "checked" : "";
        var itemsHtml = bucket.items.map(function(item) {
          var linkTitle = item.link_title || truncateUrl(item.url, 40);
          var desc = item.link_description || "";
          var contextSnippet = item.body ? item.body.replace(/https?:\/\/[^\s]+/g, "").trim() : "";
          if (contextSnippet.length > 100) contextSnippet = contextSnippet.slice(0, 100) + "…";
          // Prefer scraped description over raw message context
          var displayDesc = desc || contextSnippet;
          if (displayDesc.length > 150) displayDesc = displayDesc.slice(0, 150) + "…";
          return '<div class="composer-bucket-item">' +
            '<span>→</span>' +
            '<div>' +
              '<a href="' + escapeAttr(item.url) + '" target="_blank" rel="noopener">' + escapeHtml(linkTitle) + '</a>' +
              (displayDesc ? '<div style="color:var(--text-dim);font-size:11px;margin-top:1px;">' + escapeHtml(displayDesc) + '</div>' : '') +
            '</div>' +
          '</div>';
        }).join("");
        return '<div class="composer-bucket">' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;" class="composer-bucket-sender">' +
            '<input type="checkbox" data-bucket-sender="' + escapeAttr(senderKey) + '" ' + checked + '>' +
            escapeHtml(senderKey) + ' <span style="color:var(--text-dim);font-weight:400;font-size:11px;">(' + bucket.items.length + ' link' + (bucket.items.length > 1 ? 's' : '') + ')</span>' +
          '</label>' +
          itemsHtml +
        '</div>';
      }).join("");

      // Attach bucket toggle listeners
      bucketsList.querySelectorAll("input[data-bucket-sender]").forEach(function(cb) {
        cb.addEventListener("change", function() {
          composerBuckets[cb.dataset.bucketSender] = cb.checked;
          updateComposerPreview();
        });
      });
    }
  }

  // Highlights — trending topics
  var highlightsList = document.getElementById("composer-highlights-list");
  if (highlightsList) {
    var highlights = weeklyDraft.highlights || [];
    if (highlights.length === 0) {
      highlightsList.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding-left:22px;">No trending topics this week.</div>';
    } else {
      highlightsList.innerHTML = highlights.map(function(h) {
        return '<div class="composer-highlight-row">' +
          '<span style="color:#00cec9;">•</span> ' +
          '<span>' + escapeHtml(h.topic) + '</span>' +
          '<span class="composer-highlight-count">' + h.mention_count + ' mention' + (h.mention_count > 1 ? 's' : '') + '</span>' +
        '</div>';
      }).join("");
    }
  }

  updateComposerPreview();
}

function buildComposerMessage() {
  if (!weeklyDraft) return "";

  var lines = [];
  lines.push("*Metacrisis Community — Weekly Update*");
  lines.push("*" + (weeklyDraft.dateRange || "") + "*");
  lines.push("");

  // Events
  if (composerShowEvents) {
    var events = (weeklyDraft.events || []).filter(function(_, i) { return composerEvents[i] !== false; });
    if (events.length > 0) {
      lines.push("*Upcoming Events*");
      events.forEach(function(evt) {
        var line = "- " + (evt.name || "Untitled");
        if (evt.date) {
          var d = new Date(evt.date + "T00:00:00");
          line += " — " + d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        }
        if (evt.start_time) line += " at " + evt.start_time;
        if (evt.location) line += " | " + evt.location;
        lines.push(line);
        if (evt.url) lines.push("  " + evt.url);
      });
      lines.push("");
    }
  }

  // Resources
  if (composerShowResources) {
    var resources = (weeklyDraft.topResources || []).filter(function(_, i) { return composerResources[i] !== false; });
    if (resources.length > 0) {
      lines.push("*Top Resources*");
      resources.forEach(function(res) {
        var title = res.title || truncateUrl(res.url, 40);
        lines.push("- " + title);
        lines.push("  " + res.url);
      });
      lines.push("");
    }
  }

  // Most active member
  if (composerShowMember && weeklyDraft.topMember) {
    lines.push("*Most Active Member*");
    lines.push(weeklyDraft.topMember.sender_name + " — " + weeklyDraft.topMember.message_count + " messages");
    lines.push("");
  }

  // Community pulse
  if (composerShowPulse) {
    var pulseEl = document.getElementById("composer-pulse-text");
    var pulseText = pulseEl ? pulseEl.value.trim() : "";
    if (pulseText) {
      lines.push("*Community Pulse*");
      lines.push(pulseText);
      lines.push("");
    }
  }

  // Discussion Highlights (buckets)
  if (composerShowBuckets && weeklyDraft.discussionBuckets) {
    var activeBuckets = (weeklyDraft.discussionBuckets || []).filter(function(b) { return composerBuckets[b.sender] !== false; });
    if (activeBuckets.length > 0) {
      lines.push("*What People Shared*");
      activeBuckets.forEach(function(bucket) {
        lines.push("");
        lines.push("*" + bucket.sender + "*:");
        bucket.items.forEach(function(item) {
          var title = item.link_title || truncateUrl(item.url, 40);
          var desc = item.link_description || "";
          var context = item.body ? item.body.replace(/https?:\/\/[^\s]+/g, "").trim() : "";
          if (context.length > 120) context = context.slice(0, 120) + "…";
          var summary = desc || context;
          if (summary.length > 150) summary = summary.slice(0, 150) + "…";
          if (summary) {
            lines.push("→ " + title + " — " + summary);
          } else {
            lines.push("→ " + title);
          }
          lines.push("  " + item.url);
        });
      });
      lines.push("");
    }
  }

  // Trending topics (highlights)
  if (composerShowHighlights && weeklyDraft.highlights) {
    var highlights = weeklyDraft.highlights || [];
    if (highlights.length > 0) {
      lines.push("*Trending Topics*");
      highlights.forEach(function(h) {
        lines.push("• " + h.topic + " (" + h.mention_count + " mention" + (h.mention_count > 1 ? "s" : "") + ")");
      });
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}

function updateComposerPreview() {
  var preview = document.getElementById("composer-preview");
  if (!preview) return;
  preview.textContent = buildComposerMessage();
}

async function handleComposerPush() {
  var message = buildComposerMessage();
  if (!message) {
    alert("Nothing to push — all sections are empty or unchecked.");
    return;
  }

  if (!confirm("Push this weekly update to the announcement chat?")) return;

  var pushBtn = document.getElementById("composer-push");
  var statusEl = document.getElementById("composer-status");
  if (pushBtn) { pushBtn.disabled = true; pushBtn.textContent = "Pushing..."; }

  try {
    var res = await adminFetch("/api/metacrisis/push-weekly", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message }),
    });
    if (!res.ok) {
      var data = await res.json().catch(function() { return {}; });
      throw new Error(data.error || "Server returned " + res.status);
    }
    if (statusEl) statusEl.textContent = "Pushed successfully!";
    setTimeout(function() { if (statusEl) statusEl.textContent = ""; }, 3000);
  } catch (err) {
    console.error("Push failed:", err);
    alert("Push failed: " + err.message);
  } finally {
    if (pushBtn) { pushBtn.disabled = false; pushBtn.textContent = "Push to Announcement Chat"; }
  }
}

async function handleRegeneratePulse() {
  var btn = document.getElementById("composer-regenerate");
  if (btn) { btn.disabled = true; btn.textContent = "Generating..."; }

  try {
    // Trigger daily digest to regenerate the community pulse
    var res = await adminFetch("/api/metacrisis/daily-digest", { method: "POST" });
    if (!res.ok) throw new Error("Digest failed");

    // Re-fetch the draft
    var draftRes = await adminFetch("/api/metacrisis/weekly-draft");
    if (draftRes.ok) {
      weeklyDraft = await draftRes.json();
      var pulseEl = document.getElementById("composer-pulse-text");
      if (pulseEl) {
        pulseEl.value = weeklyDraft.communityPulse || "";
        pulseEl.dataset.userEdited = "";
      }
      renderComposer();
    }
  } catch (err) {
    console.error("Regenerate failed:", err);
    alert("Failed to regenerate: " + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Regenerate Pulse"; }
  }
}
