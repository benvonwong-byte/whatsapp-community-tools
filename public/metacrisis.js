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
let composerLinks = {};      // { index: boolean } — which links are selected

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
  setupQuickShare();
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
        composerLinks = {};
        ["events", "videos", "articles"].forEach(function(cat) {
          (draft[cat] || []).forEach(function(link) { composerLinks[link.id] = true; });
        });
      } else {
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

  // Per-section All/None buttons
  ["events", "videos", "articles"].forEach(function(cat) {
    var allBtn = document.getElementById("composer-" + cat + "-all");
    var noneBtn = document.getElementById("composer-" + cat + "-none");
    if (allBtn) allBtn.addEventListener("click", function() {
      if (!weeklyDraft) return;
      (weeklyDraft[cat] || []).forEach(function(link) { composerLinks[link.id] = true; });
      renderComposer();
    });
    if (noneBtn) noneBtn.addEventListener("click", function() {
      if (!weeklyDraft) return;
      (weeklyDraft[cat] || []).forEach(function(link) { composerLinks[link.id] = false; });
      renderComposer();
    });
  });
}

function renderComposer() {
  if (!weeklyDraft) return;

  // Date range
  var rangeEl = document.getElementById("composer-date-range");
  if (rangeEl) rangeEl.textContent = weeklyDraft.dateRange || "";

  // Last update sent
  var lastSentEl = document.getElementById("composer-last-sent");
  if (lastSentEl) {
    if (weeklyDraft.lastUpdateSent) {
      lastSentEl.textContent = "Last sent: " + formatRelativeTime(weeklyDraft.lastUpdateSent);
    } else {
      lastSentEl.textContent = "No updates sent yet";
    }
  }

  // Render each category section
  renderComposerSection("events", weeklyDraft.events || []);
  renderComposerSection("articles", weeklyDraft.articles || []);
  renderComposerSection("videos", weeklyDraft.videos || []);

  // Weekly topics summary
  var topicsEl = document.getElementById("composer-topics-summary");
  if (topicsEl) {
    var topics = weeklyDraft.weeklyTopics || [];
    var participants = weeklyDraft.participants || [];
    var totalMsgs = weeklyDraft.totalMessages || 0;
    if (topics.length === 0) {
      topicsEl.innerHTML = '<span style="color:var(--text-dim);">No topic data this week.</span>';
    } else {
      var topicsHtml = topics.map(function(t) {
        return '<span style="display:inline-block;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:2px 10px;margin:2px;font-size:11px;">' +
          escapeHtml(t.topic) + ' <span style="color:var(--text-dim);">(' + t.count + ')</span></span>';
      }).join("");
      var statsLine = totalMsgs + ' messages from ' + participants.length + ' participants';
      topicsEl.innerHTML = '<div style="margin-bottom:6px;">' + topicsHtml + '</div>' +
        '<div style="font-size:10px;color:var(--text-dim);">' + escapeHtml(statsLine) + '</div>';
    }
  }

  updateComposerPreview();
}

function renderComposerSection(category, links) {
  var container = document.getElementById("composer-" + category + "-list");
  var countEl = document.getElementById("composer-" + category + "-count");

  if (countEl) countEl.textContent = "(" + links.length + ")";

  if (!container) return;

  if (links.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:8px 0;">No ' + category + ' this week.</div>';
    return;
  }

  container.innerHTML = links.map(function(link) {
    var checked = composerLinks[link.id] !== false ? "checked" : "";
    var title = link.title && link.title !== "(untitled)" && link.title !== "(error)" ? link.title : truncateUrl(link.url, 50);
    var summary = link.description || "";

    var metaHtml = "";
    if (category === "events") {
      if (link.event_date) {
        var ed = new Date(link.event_date + "T00:00:00");
        metaHtml += '<div style="font-size:11px;color:var(--accent);font-weight:500;">' +
          ed.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + '</div>';
      }
      if (link.event_location) {
        metaHtml += '<div style="font-size:11px;color:var(--text-dim);">' + escapeHtml(link.event_location) + '</div>';
      }
    }

    return '<div class="composer-link-row">' +
      '<input type="checkbox" data-link-id="' + link.id + '" ' + checked + '>' +
      '<div class="composer-link-info">' +
        '<div class="composer-link-title"><a href="' + escapeAttr(link.url) + '" target="_blank" rel="noopener">' + escapeHtml(title) + '</a></div>' +
        metaHtml +
        (summary ? '<div class="composer-link-summary">' + escapeHtml(summary) + '</div>' : '') +
      '</div>' +
    '</div>';
  }).join("");

  // Attach checkbox listeners
  container.querySelectorAll("input[data-link-id]").forEach(function(cb) {
    cb.addEventListener("change", function() {
      composerLinks[parseInt(cb.dataset.linkId)] = cb.checked;
      updateComposerPreview();
    });
  });
}

function buildComposerMessage() {
  if (!weeklyDraft) return "";

  var lines = [];
  lines.push("*Metacrisis Community \u2014 Weekly Update*");
  lines.push("*" + (weeklyDraft.dateRange || "") + "*");
  lines.push("");

  // Events
  var selectedEvents = (weeklyDraft.events || []).filter(function(l) { return composerLinks[l.id] !== false; });
  if (selectedEvents.length > 0) {
    lines.push("\uD83D\uDCC5 *Upcoming Events*");
    lines.push("");
    selectedEvents.forEach(function(link) {
      var title = link.title && link.title !== "(untitled)" && link.title !== "(error)" ? link.title : truncateUrl(link.url, 40);
      lines.push("*" + title + "*");
      if (link.event_date) {
        var ed = new Date(link.event_date + "T00:00:00");
        lines.push("\uD83D\uDDD3 " + ed.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" }));
      }
      if (link.event_location) lines.push("\uD83D\uDCCD " + link.event_location);
      if (link.description) lines.push(link.description);
      lines.push("\uD83D\uDD17 " + link.url);
      lines.push("");
    });
  }

  // Articles
  var selectedArticles = (weeklyDraft.articles || []).filter(function(l) { return composerLinks[l.id] !== false; });
  if (selectedArticles.length > 0) {
    lines.push("\uD83D\uDCF0 *Articles*");
    lines.push("");
    selectedArticles.forEach(function(link) {
      var title = link.title && link.title !== "(untitled)" && link.title !== "(error)" ? link.title : truncateUrl(link.url, 40);
      lines.push("*" + title + "*");
      if (link.description) lines.push(link.description);
      lines.push("\uD83D\uDD17 " + link.url);
      lines.push("");
    });
  }

  // Videos
  var selectedVideos = (weeklyDraft.videos || []).filter(function(l) { return composerLinks[l.id] !== false; });
  if (selectedVideos.length > 0) {
    lines.push("\uD83C\uDFA5 *Videos*");
    lines.push("");
    selectedVideos.forEach(function(link) {
      var title = link.title && link.title !== "(untitled)" && link.title !== "(error)" ? link.title : truncateUrl(link.url, 40);
      lines.push("*" + title + "*");
      if (link.description) lines.push(link.description);
      lines.push("\uD83D\uDD17 " + link.url);
      lines.push("");
    });
  }

  // Discussion Summary
  var topics = weeklyDraft.weeklyTopics || [];
  if (topics.length > 0) {
    lines.push("*Discussion Summary*");
    lines.push("Topics covered: " + topics.map(function(t) { return t.topic; }).join(", "));
    var participants = weeklyDraft.participants || [];
    if (participants.length > 0) {
      lines.push("Active participants: " + participants.join(", "));
    }
    lines.push("");
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
    alert("Nothing to push \u2014 all sections are empty or unchecked.");
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

// ── Quick Link Sharer ──

var qsData = null; // scraped data

function setupQuickShare() {
  var scrapeBtn = document.getElementById("qs-scrape-btn");
  var urlInput = document.getElementById("qs-url");
  var copyBtn = document.getElementById("qs-copy");
  var pushBtn = document.getElementById("qs-push");

  if (scrapeBtn) scrapeBtn.addEventListener("click", handleQuickScrape);

  // Allow Enter key in URL input to trigger scrape
  if (urlInput) urlInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter") { e.preventDefault(); handleQuickScrape(); }
  });

  if (copyBtn) copyBtn.addEventListener("click", function() {
    var preview = document.getElementById("qs-preview");
    if (!preview || !preview.textContent) return;
    navigator.clipboard.writeText(preview.textContent).then(function() {
      var statusEl = document.getElementById("qs-status");
      if (statusEl) { statusEl.textContent = "Copied to clipboard!"; setTimeout(function() { statusEl.textContent = ""; }, 2000); }
    });
  });

  if (pushBtn) pushBtn.addEventListener("click", function() { handleQuickSharePush("community"); });

  var pushAdjacentBtn = document.getElementById("qs-push-adjacent");
  if (pushAdjacentBtn) pushAdjacentBtn.addEventListener("click", function() { handleQuickSharePush("adjacent"); });

  // Live-update preview on field edits
  ["qs-title", "qs-date", "qs-time", "qs-location", "qs-description"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("input", updateQuickSharePreview);
  });
}

async function handleQuickScrape() {
  var urlInput = document.getElementById("qs-url");
  var scrapeBtn = document.getElementById("qs-scrape-btn");
  var fieldsContainer = document.getElementById("qs-fields-container");
  var statusEl = document.getElementById("qs-status");

  var url = (urlInput.value || "").trim();
  if (!url) { urlInput.focus(); return; }

  // Basic URL validation
  if (!/^https?:\/\/.+/i.test(url)) {
    url = "https://" + url;
    urlInput.value = url;
  }

  scrapeBtn.disabled = true;
  scrapeBtn.textContent = "Scraping...";
  if (statusEl) statusEl.textContent = "";

  try {
    var res = await adminFetch("/api/metacrisis/scrape-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url }),
    });
    if (!res.ok) {
      var data = await res.json().catch(function() { return {}; });
      throw new Error(data.error || "Server returned " + res.status);
    }

    qsData = await res.json();

    // Populate fields
    document.getElementById("qs-title").value = qsData.title || "";
    document.getElementById("qs-date").value = qsData.date || "";
    document.getElementById("qs-time").value = qsData.time || "";
    document.getElementById("qs-location").value = qsData.location || "";
    document.getElementById("qs-description").value = qsData.description || "";

    // Show fields
    fieldsContainer.classList.remove("hidden");
    updateQuickSharePreview();
  } catch (err) {
    console.error("Scrape failed:", err);
    if (statusEl) statusEl.textContent = "Scrape failed: " + err.message;
  } finally {
    scrapeBtn.disabled = false;
    scrapeBtn.textContent = "Scrape";
  }
}

function buildQuickShareMessage() {
  var title = (document.getElementById("qs-title").value || "").trim();
  var date = (document.getElementById("qs-date").value || "").trim();
  var time = (document.getElementById("qs-time").value || "").trim();
  var location = (document.getElementById("qs-location").value || "").trim();
  var description = (document.getElementById("qs-description").value || "").trim();
  var url = (document.getElementById("qs-url").value || "").trim();

  if (!title && !description) return "";

  var lines = [];

  if (title) lines.push("*" + title + "*");

  // Date/time line
  if (date) {
    var dateParts = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    var dateStr = date;
    if (dateParts) {
      var d = new Date(date + "T00:00:00");
      dateStr = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
    }
    var timeLine = "\uD83D\uDDD3 " + dateStr;
    if (time) timeLine += " at " + time;
    lines.push(timeLine);
  }

  if (location) lines.push("\uD83D\uDCCD " + location);

  if (url) lines.push("\uD83D\uDD17 " + url);

  if (description) {
    lines.push("");
    lines.push(description);
  }

  return lines.join("\n");
}

function updateQuickSharePreview() {
  var preview = document.getElementById("qs-preview");
  if (!preview) return;
  preview.textContent = buildQuickShareMessage();
}

async function handleQuickSharePush(target) {
  var message = buildQuickShareMessage();
  if (!message) {
    alert("Nothing to push \u2014 scrape a URL first.");
    return;
  }

  var isAdjacent = target === "adjacent";
  var chatLabel = isAdjacent ? "Adjacent Events" : "Community Chat";
  var endpoint = isAdjacent ? "/api/metacrisis/push-to-adjacent" : "/api/metacrisis/push-to-chat";

  if (!confirm("Push this message to " + chatLabel + "?")) return;

  var btn = document.getElementById(isAdjacent ? "qs-push-adjacent" : "qs-push");
  var statusEl = document.getElementById("qs-status");
  var originalText = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Pushing..."; }

  try {
    var res = await adminFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message }),
    });
    if (!res.ok) {
      var data = await res.json().catch(function() { return {}; });
      throw new Error(data.error || "Server returned " + res.status);
    }
    if (statusEl) statusEl.textContent = "Pushed to " + chatLabel + "!";
    setTimeout(function() { if (statusEl) statusEl.textContent = ""; }, 3000);
  } catch (err) {
    console.error("Push failed:", err);
    alert("Push failed: " + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
}

