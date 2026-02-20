// ── State ──

let contacts = [];
let groups = [];
let chats = [];
let selectedRecipients = new Set();
let currentSort = { field: "last_seen", dir: "desc" };

// ── Data cache with stale-while-revalidate ──
const _cache = {};
const CACHE_TTL = 120000; // 2 min fresh
const CACHE_STALE = 600000; // 10 min stale-usable
function cachedFetch(url, opts) {
  const key = url + (opts ? JSON.stringify(opts) : "");
  const cached = _cache[key];
  if (cached) {
    const age = Date.now() - cached.time;
    if (age < CACHE_TTL) return Promise.resolve(cached.response.clone());
    // Stale-while-revalidate: return stale immediately, refresh in background
    if (age < CACHE_STALE) {
      adminFetch(url, opts).then(res => {
        if (res.ok) _cache[key] = { time: Date.now(), response: res.clone() };
      }).catch(() => {});
      return Promise.resolve(cached.response.clone());
    }
  }
  return adminFetch(url, opts).then(res => {
    if (res.ok) _cache[key] = { time: Date.now(), response: res.clone() };
    return res;
  });
}
function invalidateCache(prefix) {
  for (const key of Object.keys(_cache)) {
    if (!prefix || key.includes(prefix)) delete _cache[key];
  }
}
let weeklyChart = null;
let hourlyChart = null;
let detailChart = null;
let sendPollTimer = null;
let searchDebounceTimer = null;
let activeTagFilters = new Set();
let tagFilterMode = "OR";
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth() + 1;
let negWindowDays = 30;
let negOffsetPeriods = 90;
let neglectedData = [];
let negNavBound = false;
let dashboardTierFilter = null; // null = all, number = tier_id, "none" = unassigned

// ── Init ──

document.addEventListener("DOMContentLoaded", () => {
  if (!isAdmin) {
    $("login-gate")?.classList.remove("hidden");
    $("main-content")?.classList.add("hidden");
    return;
  }

  $("login-gate")?.classList.add("hidden");
  $("main-content")?.classList.remove("hidden");

  // Tab navigation
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.tab;
      const content = $("tab-" + target);
      if (content) content.classList.add("active");

      // Load data on tab switch
      if (target === "dashboard") loadDashboard();
      else if (target === "contacts") loadContacts();
      else if (target === "tiers") loadTiers();
      else if (target === "groups") loadGroups();
      else if (target === "graph") loadGraph();
      else if (target === "calls") loadCallsTab();
      else if (target === "messaging") loadMessagingRecipients();
      else if (target === "chats") loadChats();
    });
  });

  // Button handlers
  setupScanButton();
  setupBackfillButton();
  setupTagAllHeaderButton();
  setupDetailPanel();
  setupContactFilters();
  setupMessagingHandlers();
  setupTierHandlers();
  setupGroupHandlers();
  setupCalendarHandlers();
  setupAISearch();
  setupGraphHandlers();
  setupCallsTab();
  setupBotDetection();
  _initNameEditHandlers();

  // Load initial tab — show skeleton immediately
  showDashboardSkeleton();
  loadDashboard();

  // Prefetch other tabs eagerly (stale-while-revalidate means this is cheap)
  setTimeout(() => {
    cachedFetch("/api/friends/contacts?sort=last_seen&dir=desc");
    cachedFetch("/api/friends/tiers");
    cachedFetch("/api/friends/groups");
    cachedFetch("/api/friends/tags");
    // Prefetch graph data so it's instant when user clicks the tab
    _prefetchGraphData();
  }, 300);
});

// ── Scan & Backfill Buttons ──

function setupScanButton() {
  const btn = $("scan-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Scanning...";
    try {
      const res = await adminFetch("/api/friends/scan", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Scan failed");
      alert("Scan complete! Found " + data.chatsFound + " chats.");
    } catch (err) {
      alert("Scan failed: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Scan Chats";
    }
  });
}

function setupBackfillButton() {
  const btn = $("backfill-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    if (!confirm("Fetch all available message history from monitored WhatsApp chats?")) return;
    btn.disabled = true;
    btn.textContent = "Backfilling...";
    try {
      const res = await adminFetch("/api/friends/backfill", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Backfill failed");
      alert("Backfill complete! Imported " + data.messagesImported + " messages.");
    } catch (err) {
      alert("Backfill failed: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Backfill";
    }
  });
}

function setupTagAllHeaderButton() {
  const btn = $("tag-all-header-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Tagging...";
    try {
      const res = await adminFetch("/api/friends/tags/extract", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Tag extraction failed");
      btn.textContent = data.contactsProcessed + " tagged!";
      loadDashboard();
    } catch (err) {
      btn.textContent = "Failed!";
      alert("Tag extraction failed: " + err.message);
    } finally {
      setTimeout(() => { btn.textContent = "Tag All"; btn.disabled = false; }, 3000);
    }
  });
}

// ── Detail Panel ──

function setupDetailPanel() {
  const closeBtn = $("detail-close");
  const overlay = $("detail-overlay");
  if (closeBtn) closeBtn.addEventListener("click", closeDetailPanel);
  if (overlay) overlay.addEventListener("click", closeDetailPanel);

  // Time range pills
  document.querySelectorAll(".detail-range-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      const range = pill.dataset.range;
      if (!currentDetailContactId || range === currentDetailRange) return;
      refreshDetailRange(currentDetailContactId, range);
    });
  });

  // Add note with Ctrl/Cmd+Enter
  const noteInput = $("new-note-input");
  if (noteInput) {
    noteInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        $("add-note-btn")?.click();
      }
    });
  }

  // Add note button
  const addNoteBtn = $("add-note-btn");
  if (addNoteBtn) {
    addNoteBtn.addEventListener("click", async () => {
      const input = $("new-note-input");
      const content = (input?.value || "").trim();
      if (!content || !currentDetailContactId) return;
      addNoteBtn.disabled = true;
      try {
        const res = await adminFetch("/api/friends/contacts/" + encodeURIComponent(currentDetailContactId) + "/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        if (!res.ok) throw new Error("Failed to add note");
        input.value = "";
        // Refresh notes
        const notesRes = await adminFetch("/api/friends/contacts/" + encodeURIComponent(currentDetailContactId) + "/notes");
        if (notesRes.ok) {
          const data = await notesRes.json();
          renderContactNotes(currentDetailContactId, data.notes);
        }
      } catch (err) {
        alert("Failed to add note: " + err.message);
      } finally {
        addNoteBtn.disabled = false;
      }
    });
  }
}

function closeDetailPanel() {
  $("detail-panel")?.classList.remove("open");
  $("detail-overlay")?.classList.remove("open");
  if (detailChart) {
    detailChart.destroy();
    detailChart = null;
  }
}

let _notesContactId = null; // track which contact notes are displayed for

function renderContactNotes(contactId, notes) {
  const list = $("notes-list");
  if (!list) return;
  _notesContactId = contactId;

  if (!notes || notes.length === 0) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:11px;">No notes yet</div>';
    return;
  }

  list.innerHTML = notes.map(note => {
    const created = new Date(note.created_at + "Z");
    const updated = new Date(note.updated_at + "Z");
    const wasEdited = note.updated_at !== note.created_at;
    const dateStr = created.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const timeStr = created.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const editedStr = wasEdited ? ` <span class="note-edited">(edited ${updated.toLocaleDateString("en-US", { month: "short", day: "numeric" })})</span>` : "";

    return `<div class="note-item" data-note-id="${note.id}">
      <div class="note-timestamp">${dateStr} at ${timeStr}${editedStr}</div>
      <div class="note-content">${esc(note.content)}</div>
      <div class="note-edit-area">
        <textarea class="note-edit-text">${esc(note.content)}</textarea>
        <div class="note-edit-actions">
          <button class="save-edit" data-note-id="${note.id}">Save</button>
          <button class="cancel-edit" data-note-id="${note.id}">Cancel</button>
        </div>
      </div>
      <div class="note-actions">
        <button class="note-action-btn edit-btn" data-note-id="${note.id}">Edit</button>
        <button class="note-action-btn delete delete-btn" data-note-id="${note.id}">Delete</button>
      </div>
    </div>`;
  }).join("");

  // Attach event listeners via delegation
  list.querySelectorAll(".edit-btn").forEach(btn => {
    btn.addEventListener("click", () => startNoteEdit(parseInt(btn.dataset.noteId)));
  });
  list.querySelectorAll(".delete-btn").forEach(btn => {
    btn.addEventListener("click", () => deleteNote(parseInt(btn.dataset.noteId), _notesContactId));
  });
  list.querySelectorAll(".save-edit").forEach(btn => {
    btn.addEventListener("click", () => saveNoteEdit(parseInt(btn.dataset.noteId), _notesContactId));
  });
  list.querySelectorAll(".cancel-edit").forEach(btn => {
    btn.addEventListener("click", () => cancelNoteEdit(parseInt(btn.dataset.noteId)));
  });
}

function startNoteEdit(noteId) {
  const item = document.querySelector(`.note-item[data-note-id="${noteId}"]`);
  if (item) item.classList.add("editing");
}

function cancelNoteEdit(noteId) {
  const item = document.querySelector(`.note-item[data-note-id="${noteId}"]`);
  if (item) {
    item.classList.remove("editing");
    const textarea = item.querySelector(".note-edit-text");
    const content = item.querySelector(".note-content");
    if (textarea && content) textarea.value = content.textContent;
  }
}

async function saveNoteEdit(noteId, contactId) {
  const item = document.querySelector(`.note-item[data-note-id="${noteId}"]`);
  if (!item) return;
  const textarea = item.querySelector(".note-edit-text");
  const content = (textarea?.value || "").trim();
  if (!content) return;
  try {
    const res = await adminFetch(`/api/friends/contacts/${encodeURIComponent(contactId)}/notes/${noteId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error("Failed to update note");
    // Refresh notes list
    const notesRes = await adminFetch(`/api/friends/contacts/${encodeURIComponent(contactId)}/notes`);
    if (notesRes.ok) {
      const data = await notesRes.json();
      renderContactNotes(contactId, data.notes);
    }
  } catch (err) {
    alert("Failed to update note: " + err.message);
  }
}

async function deleteNote(noteId, contactId) {
  if (!confirm("Delete this note?")) return;
  try {
    const res = await adminFetch(`/api/friends/contacts/${encodeURIComponent(contactId)}/notes/${noteId}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error("Failed to delete note");
    // Refresh notes list
    const notesRes = await adminFetch(`/api/friends/contacts/${encodeURIComponent(contactId)}/notes`);
    if (notesRes.ok) {
      const data = await notesRes.json();
      renderContactNotes(contactId, data.notes);
    }
  } catch (err) {
    alert("Failed to delete note: " + err.message);
  }
}

// Global state for name editing — avoids cloning/listener issues
let _nameEditContactId = null;
let _nameEditOriginal = "";

function setupNameEditing(contactId, currentDisplayName) {
  _nameEditContactId = contactId;
  _nameEditOriginal = currentDisplayName;
}

function _initNameEditHandlers() {
  const nameEl = $("detail-name");
  const editDiv = $("detail-name-edit");
  const input = $("detail-name-input");

  if (!nameEl || !editDiv || !input) return;

  const showEdit = () => {
    if (!_nameEditContactId) return;
    nameEl.style.display = "none";
    editDiv.classList.remove("hidden");
    input.value = nameEl.textContent || _nameEditOriginal;
    input.focus();
    input.select();
  };

  const hideEdit = () => {
    editDiv.classList.add("hidden");
    nameEl.style.display = "";
  };

  const doSave = async (displayName) => {
    if (!_nameEditContactId) return;
    try {
      const res = await adminFetch("/api/friends/contacts/" + encodeURIComponent(_nameEditContactId) + "/display-name", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName }),
      });
      if (!res.ok) throw new Error("Failed");
      nameEl.textContent = displayName || _nameEditOriginal;
      hideEdit();
    } catch (err) {
      console.error("Failed to save display name:", err);
      alert("Failed to save name");
    }
  };

  nameEl.addEventListener("click", showEdit);
  $("detail-name-save")?.addEventListener("click", () => doSave(input.value.trim()));
  $("detail-name-reset")?.addEventListener("click", () => doSave(null));
  $("detail-name-cancel")?.addEventListener("click", hideEdit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doSave(input.value.trim()); }
    if (e.key === "Escape") hideEdit();
  });
}

// ── Contact Filters ──

function setupContactFilters() {
  const searchInput = $("contact-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => loadContacts(), 300);
    });
  }

  const groupFilter = $("filter-group");
  if (groupFilter) groupFilter.addEventListener("change", () => loadContacts());

  const qualityFilter = $("filter-quality");
  if (qualityFilter) qualityFilter.addEventListener("change", () => loadContacts());

  const tierFilter = $("filter-tier");
  if (tierFilter) tierFilter.addEventListener("change", () => loadContacts());
}

// ── Dashboard Tab ──

function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
  const tab = document.querySelector('[data-tab="' + tabName + '"]');
  if (tab) tab.classList.add("active");
  const content = $("tab-" + tabName);
  if (content) content.classList.add("active");
}

function setupAISearch() {
  const input = $("ai-search-input");
  const btn = $("ai-search-btn");
  const results = $("ai-search-results");
  if (!input || !btn || !results) return;

  const doSearch = async () => {
    const query = input.value.trim();
    if (!query) return;
    btn.disabled = true;
    btn.textContent = "Searching...";
    results.style.display = "block";
    results.innerHTML = '<div class="ai-search-explanation">Searching...</div>';
    try {
      const res = await adminFetch("/api/friends/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query })
      });
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      let html = '<button class="ai-search-close" id="ai-search-close">Close</button>';
      html += '<div class="ai-search-explanation">' + esc(data.parsed?.explanation || query) +
        ' (' + data.results.length + ' results)</div>';
      if (data.results.length === 0) {
        html += '<div style="color:var(--text-dim);font-size:12px;">No contacts found matching your query.</div>';
      }
      const searchPhrases = data.parsed?.phrases || [];
      html += data.results.map(r => {
        const tierBadge = r.tier_color && r.tier_name
          ? '<span class="ai-search-result-tier" style="background:' + esc(r.tier_color) + '22;color:' + esc(r.tier_color) + ';border:1px solid ' + esc(r.tier_color) + '44;">' + esc(r.tier_name) + '</span>'
          : '';
        let snippetHtml = '';
        if (r.snippet) {
          let s = esc(r.snippet.substring(0, 150));
          for (const p of searchPhrases) {
            const re = new RegExp('(' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
            s = s.replace(re, '<mark>$1</mark>');
          }
          snippetHtml = '<div class="ai-search-result-meta">"...' + s + '..."</div>';
        }
        const sourceIcon = r.match_source === 'message' ? '💬 ' : r.match_source === 'tag' ? '🏷 ' : '👤 ';
        return '<div class="ai-search-result" data-contact-id="' + esc(r.id) + '">' +
          '<div><span class="ai-search-result-name">' + esc(r.name || r.id) + '</span>' + tierBadge +
          snippetHtml + '</div>' +
          '<div class="ai-search-result-reason">' + sourceIcon + esc(r.match_reason || r.match_source || "") + '</div>' +
        '</div>';
      }).join("");
      results.innerHTML = html;
      // Click handlers
      results.querySelectorAll(".ai-search-result").forEach(row => {
        row.addEventListener("click", () => {
          const id = row.dataset.contactId;
          if (id) openContactDetail(id);
        });
      });
      const closeBtn = $("ai-search-close");
      if (closeBtn) closeBtn.addEventListener("click", () => { results.style.display = "none"; });
    } catch (err) {
      results.innerHTML = '<div class="ai-search-explanation" style="color:#f44;">Search failed: ' + esc(err.message) + '</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = "Search";
    }
  };

  btn.addEventListener("click", doSearch);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
}

function showDashboardSkeleton() {
  // Summary cards skeleton
  var cards = $("summary-cards");
  if (cards && !cards.children.length) {
    cards.innerHTML = Array(5).fill(0).map(function() {
      return '<div class="stat-card skeleton-card"><div class="skel-line skel-big"></div><div class="skel-line skel-sm"></div></div>';
    }).join("");
  }
  // Top friends skeleton
  var tf = $("top-friends-list");
  if (tf && tf.querySelector(".chart-empty")) {
    tf.innerHTML = Array(5).fill(0).map(function() {
      return '<div class="skeleton-card" style="height:36px;margin-bottom:4px;border-radius:6px;"></div>';
    }).join("");
  }
}

/** Render all dashboard sections from a data object */
function renderDashboardData(data) {
  renderSummaryCards(data.stats, data.voiceTotal);
  renderWeeklyChart(data.weeklyVolume);
  renderHourlyChart(data.hourly);
  renderFastResponders(data.fastResponders);
  renderInitiatorsList(data.topInitiators);
  renderTierPills(data.tierDistribution);
}

async function loadDashboard() {
  var tierParam = dashboardTierFilter !== null ? "?tier=" + encodeURIComponent(dashboardTierFilter) : "";
  var cacheKey = "_dash" + tierParam;

  // 1. Instant render from localStorage (stale data, shown immediately)
  try {
    var cached = localStorage.getItem(cacheKey);
    if (cached) {
      var stale = JSON.parse(cached);
      renderDashboardData(stale);
    }
  } catch (e) { /* ignore parse errors */ }

  // 2. Setup nav/handlers (idempotent, safe to call multiple times)
  setupTopFriendsNav();
  setupNeglectedNav();
  setupTagAllButton();

  // 3. Kick off ALL secondary sections immediately (don't wait for dashboard fetch)
  loadDashboardStatusBar();
  loadTopFriends();
  loadNeglected();
  loadDashboardTags();
  loadCalendar();
  loadImessageMonitor();

  // 4. Fetch fresh dashboard data in background, re-render when ready
  try {
    var res = await cachedFetch("/api/friends/dashboard" + tierParam);
    if (!res.ok) throw new Error("Server returned " + res.status);
    var data = await res.json();
    renderDashboardData(data);
    // Save to localStorage for next instant load
    try { localStorage.setItem(cacheKey, JSON.stringify(data)); } catch (e) { /* quota */ }
  } catch (err) {
    console.error("Failed to load dashboard:", err);
  }
}

// ── iMessage Sync Monitor ──

async function loadImessageMonitor() {
  try {
    const res = await adminFetch("/api/friends/imessage/status");
    if (!res.ok) return;
    const data = await res.json();

    // Status badge
    const badge = $("imsg-status-badge");
    if (badge) {
      if (!data.syncKeyConfigured) {
        badge.textContent = "Not configured";
        badge.style.background = "#f4433620";
        badge.style.color = "#f44336";
      } else if (data.syncLog.length === 0) {
        badge.textContent = "Awaiting first sync";
        badge.style.background = "#ff980020";
        badge.style.color = "#ff9800";
      } else {
        const lastEntry = data.syncLog[0];
        if (lastEntry.error) {
          badge.textContent = "Error";
          badge.style.background = "#f4433620";
          badge.style.color = "#f44336";
        } else {
          badge.textContent = "Active";
          badge.style.background = "#4caf5020";
          badge.style.color = "#4caf50";
        }
      }
    }

    // Stats cards
    const statsEl = $("imsg-stats");
    if (statsEl) {
      const lastSync = data.syncLog.length > 0 ? data.syncLog[0].time : null;
      const lastSyncLabel = lastSync ? timeAgo(Math.floor(new Date(lastSync).getTime() / 1000)) : "Never";
      statsEl.innerHTML =
        '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--accent);">' + (data.totalMessages || 0).toLocaleString() + '</div><div style="font-size:9px;color:var(--text-dim);text-transform:uppercase;">Messages</div></div>' +
        '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--accent);">' + (data.totalContacts || 0) + '</div><div style="font-size:9px;color:var(--text-dim);text-transform:uppercase;">Contacts</div></div>' +
        '<div style="text-align:center;"><div style="font-size:18px;font-weight:700;color:var(--accent);">' + lastSyncLabel + '</div><div style="font-size:9px;color:var(--text-dim);text-transform:uppercase;">Last Sync</div></div>';
    }

    // Sync log
    const logEl = $("imsg-log");
    if (logEl) {
      if (data.syncLog.length === 0) {
        logEl.innerHTML = '<span style="opacity:.5;">No sync events recorded yet. The sync log appears here once the iMessage sync script sends data to the server.</span>';
      } else {
        logEl.innerHTML = data.syncLog.map(function(entry) {
          const t = new Date(entry.time).toLocaleString();
          if (entry.error) {
            return '<div style="color:#f44336;">[' + esc(t) + '] ERROR: ' + esc(entry.error) + '</div>';
          }
          const parts = [];
          if (entry.imported > 0) parts.push(entry.imported + ' imported');
          if (entry.skipped > 0) parts.push(entry.skipped + ' skipped');
          if (entry.voiceImported > 0) parts.push(entry.voiceImported + ' voice');
          const summary = parts.length > 0 ? parts.join(', ') : 'no new messages';
          return '<div>[' + esc(t) + '] ' + esc(summary) + '</div>';
        }).join('');
      }
    }
  } catch (err) {
    console.error("Failed to load iMessage monitor:", err);
  }
}

// ── Dashboard Status Bar ──

async function loadDashboardStatusBar() {
  var serverDot = $("dash-server-dot");
  var serverLabel = $("dash-server-status");
  var imsgDot = $("dash-imsg-dot");
  var imsgLabel = $("dash-imsg-status");
  var imsgDetail = $("dash-imsg-detail");
  if (!serverDot) return;

  // 1. Server health check
  try {
    var res = await adminFetch("/api/friends/health");
    if (res.ok) {
      serverDot.style.background = "#4caf50";
      serverLabel.lastChild.textContent = " Server";
    } else {
      serverDot.style.background = "#f44336";
      serverLabel.lastChild.textContent = " Server offline";
    }
  } catch (e) {
    serverDot.style.background = "#f44336";
    serverLabel.lastChild.textContent = " Server offline";
    imsgDot.style.background = "#888";
    imsgLabel.lastChild.textContent = " iMessage unknown";
    if (imsgDetail) imsgDetail.textContent = "";
    return;
  }

  // 2. iMessage + Bridge status
  var bridgeDot = $("dash-bridge-dot");
  var bridgeLabel = $("dash-bridge-status");
  try {
    var imRes = await adminFetch("/api/friends/imessage/status");
    if (!imRes.ok) throw new Error("status " + imRes.status);
    var data = await imRes.json();
    if (!data.syncKeyConfigured) {
      imsgDot.style.background = "#888";
      imsgLabel.lastChild.textContent = " iMessage not configured";
      if (imsgDetail) imsgDetail.textContent = "";
    } else if (data.syncLog.length === 0) {
      imsgDot.style.background = "#ff9800";
      imsgLabel.lastChild.textContent = " iMessage awaiting sync";
      if (imsgDetail) imsgDetail.textContent = "";
    } else {
      var lastEntry = data.syncLog[0];
      if (lastEntry.error) {
        imsgDot.style.background = "#f44336";
        imsgLabel.lastChild.textContent = " iMessage error";
        if (imsgDetail) imsgDetail.textContent = lastEntry.error;
      } else {
        imsgDot.style.background = "#4caf50";
        imsgLabel.lastChild.textContent = " iMessage active";
        var lastSync = new Date(lastEntry.time);
        if (imsgDetail) imsgDetail.textContent = "Last sync: " + timeAgo(Math.floor(lastSync.getTime() / 1000));
      }
    }
    // Bridge status
    if (bridgeDot && bridgeLabel) {
      if (data.bridgeOnline) {
        bridgeDot.style.background = "#4caf50";
        bridgeLabel.lastChild.textContent = " Bridge";
      } else if (data.bridgeLastSeen) {
        bridgeDot.style.background = "#ff9800";
        bridgeLabel.lastChild.textContent = " Bridge offline";
      } else {
        bridgeDot.style.background = "#888";
        bridgeLabel.lastChild.textContent = " Bridge not seen";
      }
    }
  } catch (e) {
    imsgDot.style.background = "#888";
    imsgLabel.lastChild.textContent = " iMessage unknown";
    if (imsgDetail) imsgDetail.textContent = "";
    if (bridgeDot) bridgeDot.style.background = "#888";
    if (bridgeLabel) bridgeLabel.lastChild.textContent = " Bridge unknown";
  }
}

// ── Dashboard Tag Cloud ──

let dashTagFilter = null; // currently selected tag name or null

async function loadDashboardTags() {
  const tagTierParam = dashboardTierFilter !== null ? "?tier=" + encodeURIComponent(dashboardTierFilter) : "";
  const lsKey = "_dashTags" + tagTierParam;

  // 1. Instant render from localStorage (stale data, shown immediately)
  var hadCached = false;
  try {
    var cached = localStorage.getItem(lsKey);
    if (cached) {
      hadCached = true;
      renderDashboardTagCloud(JSON.parse(cached));
    }
  } catch (e) { /* ignore parse errors */ }

  // 2. Fetch fresh data in background, re-render when ready
  try {
    const res = await cachedFetch("/api/friends/tags" + tagTierParam);
    if (!res.ok) return;
    const tags = await res.json();
    renderDashboardTagCloud(tags);
    try { localStorage.setItem(lsKey, JSON.stringify(tags)); } catch (e) { /* quota */ }
  } catch (err) {
    if (!hadCached) console.error("Failed to load tags:", err);
  }
}

let dashTagsExpanded = false;
let dashTagSort = "popular"; // "popular" or "alpha"

function renderDashboardTagCloud(tags) {
  const container = $("dash-tag-cloud");
  if (!container) return;
  if (!tags || tags.length === 0) {
    container.innerHTML = '<span class="chart-empty">No tags yet. Use "AI Tag All" to auto-tag contacts from conversations.</span>';
    return;
  }

  // Group tags by category
  const CATEGORY_NAMES = { topic: "Topics", loc: "Location", ctx: "Context", tone: "Tone", emo: "Emotion" };
  const groups = {};
  for (const t of tags) {
    const p = parseTagCategory(t.name);
    if (!groups[p.category]) groups[p.category] = [];
    groups[p.category].push({ ...t, parsed: p });
  }

  // Sort within each group
  for (const cat of Object.keys(groups)) {
    if (dashTagSort === "alpha") {
      groups[cat].sort((a, b) => a.parsed.label.localeCompare(b.parsed.label));
    } else {
      groups[cat].sort((a, b) => b.contact_count - a.contact_count);
    }
  }

  const PREVIEW_COUNT = 20; // tags shown when collapsed
  const allTagsSorted = dashTagSort === "alpha"
    ? tags.slice().sort((a, b) => parseTagCategory(a.name).label.localeCompare(parseTagCategory(b.name).label))
    : tags.slice().sort((a, b) => b.contact_count - a.contact_count);

  let html = '';

  // Sort toggle + expand button
  html += '<div class="tag-cloud-controls">';
  html += '<select id="dash-tag-sort" class="tag-sort-select"><option value="popular"' + (dashTagSort === "popular" ? " selected" : "") + '>Most Popular</option><option value="alpha"' + (dashTagSort === "alpha" ? " selected" : "") + '>A-Z</option></select>';
  html += '<button id="dash-tag-expand" class="tag-expand-btn">' + (dashTagsExpanded ? 'Show Less' : 'Show All ' + tags.length) + '</button>';
  html += '</div>';

  if (dashTagsExpanded) {
    // Expanded: show all tags grouped by category
    const catOrder = ["topic", "emo", "tone", "ctx", "loc"];
    for (const cat of catOrder) {
      if (!groups[cat] || groups[cat].length === 0) continue;
      html += '<div class="tag-category-group">';
      html += '<div class="tag-category-label">' + (CATEGORY_NAMES[cat] || cat) + ' <span class="tag-count">' + groups[cat].length + '</span></div>';
      html += '<div class="tag-category-chips">';
      html += groups[cat].map(t => {
        const active = dashTagFilter === t.name ? ' active' : '';
        return '<span class="dash-tag' + active + '" data-tag="' + esc(t.name) + '" ' +
          'style="background:' + t.parsed.color + '18;color:' + t.parsed.color + ';border-color:' + (dashTagFilter === t.name ? t.parsed.color : 'transparent') + ';">' +
          esc(t.parsed.label) +
          ' <span class="tag-count">' + t.contact_count + '</span>' +
        '</span>';
      }).join("");
      html += '</div></div>';
    }
  } else {
    // Collapsed: show top N tags flat
    html += '<div class="tag-category-chips">';
    html += allTagsSorted.slice(0, PREVIEW_COUNT).map(t => {
      const p = parseTagCategory(t.name);
      const active = dashTagFilter === t.name ? ' active' : '';
      return '<span class="dash-tag' + active + '" data-tag="' + esc(t.name) + '" ' +
        'style="background:' + p.color + '18;color:' + p.color + ';border-color:' + (dashTagFilter === t.name ? p.color : 'transparent') + ';">' +
        esc(p.label) +
        ' <span class="tag-count">' + t.contact_count + '</span>' +
      '</span>';
    }).join("");
    if (tags.length > PREVIEW_COUNT) {
      html += '<span class="tag-more-hint">+' + (tags.length - PREVIEW_COUNT) + ' more</span>';
    }
    html += '</div>';
  }

  container.innerHTML = html;

  // Sort dropdown handler
  const sortSel = container.querySelector("#dash-tag-sort");
  if (sortSel) sortSel.addEventListener("change", () => { dashTagSort = sortSel.value; renderDashboardTagCloud(tags); });

  // Expand/collapse handler
  const expandBtn = container.querySelector("#dash-tag-expand");
  if (expandBtn) expandBtn.addEventListener("click", () => { dashTagsExpanded = !dashTagsExpanded; renderDashboardTagCloud(tags); });

  // Tag click handlers
  container.querySelectorAll(".dash-tag").forEach(chip => {
    chip.addEventListener("click", () => {
      const tag = chip.dataset.tag;
      if (dashTagFilter === tag) {
        dashTagFilter = null;
      } else {
        dashTagFilter = tag;
      }
      renderDashboardTagCloud(tags);
      if (dashTagFilter) {
        activeTagFilters.clear();
        activeTagFilters.add(dashTagFilter);
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
        const contactsTab = document.querySelector('[data-tab="contacts"]');
        if (contactsTab) contactsTab.classList.add("active");
        const contactsContent = $("tab-contacts");
        if (contactsContent) contactsContent.classList.add("active");
        loadContacts();
      }
    });
  });
}

function setupTagAllButton() {
  const btn = $("tag-all-btn");
  if (!btn || btn._bound) return;
  btn._bound = true;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Extracting tags...";
    try {
      const res = await adminFetch("/api/friends/tags/extract", { method: "POST" });
      if (!res.ok) throw new Error("Extraction failed");
      const data = await res.json();
      btn.textContent = "Tagged " + (data.contactsProcessed || 0) + " contacts!";
      loadDashboardTags(); // refresh tag cloud
      setTimeout(() => { btn.textContent = "AI Tag All"; btn.disabled = false; }, 3000);
    } catch (err) {
      console.error("Tag extraction failed:", err);
      btn.textContent = "Failed";
      setTimeout(() => { btn.textContent = "AI Tag All"; btn.disabled = false; }, 3000);
    }
  });
}

function renderTierPills(distribution) {
  const container = $("tier-pills");
  if (!container || !distribution) return;

  // "All" pill first
  let html = '<div class="tier-pill' + (dashboardTierFilter === null ? ' active' : '') + '" data-tier-filter="all">' +
    '<span>All</span>' +
  '</div>';

  html += distribution.map(function(d) {
    var filterId = d.tier_id === null ? "none" : String(d.tier_id);
    var isActive = String(dashboardTierFilter) === filterId;
    return '<div class="tier-pill' + (isActive ? ' active' : '') + '" data-tier-filter="' + esc(filterId) + '">' +
      '<span class="dot" style="background:' + esc(d.tier_color || '#666') + '"></span>' +
      '<span>' + esc(d.tier_name || 'Unassigned') + '</span>' +
      '<span class="count">' + d.count + '</span>' +
    '</div>';
  }).join("");

  container.innerHTML = html;

  // Click handlers
  container.querySelectorAll(".tier-pill").forEach(function(pill) {
    pill.addEventListener("click", function() {
      var filter = pill.dataset.tierFilter;
      if (filter === "all") {
        dashboardTierFilter = null;
      } else {
        // Toggle: clicking same tier resets to All
        dashboardTierFilter = String(dashboardTierFilter) === filter ? null : filter;
      }
      loadDashboard();
    });
  });
}

function renderSummaryCards(stats, voiceTotal) {
  const container = $("summary-cards");
  if (!container || !stats) return;
  container.innerHTML = [
    { label: "Total Contacts", value: stats.totalContacts ?? 0 },
    { label: "Active (30d)", value: stats.activeContacts30d ?? 0 },
    { label: "Total Messages", value: stats.totalMessages ?? 0 },
    { label: "This Week", value: stats.messagesThisWeek ?? 0 },
    { label: "Voice Minutes", value: voiceTotal?.total_minutes ?? 0 },
  ].map((card) =>
    '<div class="stat-card">' +
      '<div class="stat-value">' + esc(String(card.value)) + '</div>' +
      '<div class="stat-label">' + esc(card.label) + '</div>' +
    '</div>'
  ).join("");
}

function renderWeeklyChart(data) {
  const canvas = $("weekly-chart");
  if (!canvas || !data || data.length === 0) return;

  if (weeklyChart) {
    weeklyChart.destroy();
    weeklyChart = null;
  }

  const ctx = canvas.getContext("2d");
  weeklyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map((d) => d.week || d.period || d.label || ""),
      datasets: [
        {
          label: "Sent",
          data: data.map((d) => d.sent || 0),
          backgroundColor: "rgba(79, 195, 247, 0.7)",
          stack: "volume",
        },
        {
          label: "Received",
          data: data.map((d) => d.received || 0),
          backgroundColor: "rgba(129, 199, 132, 0.7)",
          stack: "volume",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: "#fff" },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: "#888" },
          grid: { color: "#333" },
        },
        y: {
          stacked: true,
          ticks: { color: "#888" },
          grid: { color: "#333" },
        },
      },
    },
  });
}

// ── Top 10 to Follow Up (mirrors Top Friends nav) ──

function setupNeglectedNav() {
  if (negNavBound) return;
  negNavBound = true;

  // Window buttons (same as Top Friends)
  document.querySelectorAll(".neg-window-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      negWindowDays = parseInt(btn.dataset.days);
      negOffsetPeriods = 0;
      document.querySelectorAll(".neg-window-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      loadNeglected();
    });
  });

  // Prev/Next arrows
  var prevBtn = $("neg-prev");
  var nextBtn = $("neg-next");
  if (prevBtn) prevBtn.addEventListener("click", () => { negOffsetPeriods += negWindowDays; loadNeglected(); });
  if (nextBtn) nextBtn.addEventListener("click", () => { negOffsetPeriods = Math.max(0, negOffsetPeriods - negWindowDays); loadNeglected(); });

  // Keyboard navigation (left/right arrows)
  var section = $("neglected-section");
  if (section) {
    section.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); negOffsetPeriods += negWindowDays; loadNeglected(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); negOffsetPeriods = Math.max(0, negOffsetPeriods - negWindowDays); loadNeglected(); }
    });
    section.addEventListener("mouseenter", () => section.focus());
  }

  // Bind filter dropdowns
  var sortSel = $("neg-sort");
  var groupSel = $("neg-group-filter");
  var tagSel = $("neg-tag-filter");
  if (sortSel) sortSel.addEventListener("change", () => renderNeglectedList());
  if (groupSel) groupSel.addEventListener("change", () => renderNeglectedList());
  if (tagSel) tagSel.addEventListener("change", () => renderNeglectedList());
}

async function loadNeglected() {
  try {
    var negTierParam = dashboardTierFilter !== null ? "&tier=" + encodeURIComponent(dashboardTierFilter) : "";
    var res = await adminFetch("/api/friends/neglected?days=" + negWindowDays + "&offset=" + negOffsetPeriods + negTierParam);
    if (!res.ok) throw new Error("Failed");
    var data = await res.json();
    neglectedData = data.contacts || [];

    // Update date range label (same format as Top Friends)
    var rangeEl = $("neg-date-range");
    if (rangeEl) {
      var now = Date.now();
      var end = new Date(now - negOffsetPeriods * 86400000);
      var start = new Date(now - (negOffsetPeriods + negWindowDays) * 86400000);
      var fmt = function(d) { return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
      rangeEl.textContent = fmt(start) + " \u2192 " + fmt(end);
    }

    // Disable next at current period
    var nextBtn = $("neg-next");
    if (nextBtn) nextBtn.disabled = negOffsetPeriods === 0;

    // Populate filter dropdowns
    var groupSel = $("neg-group-filter");
    var tagSel = $("neg-tag-filter");
    if (groupSel) {
      var groups = new Set();
      neglectedData.forEach(function(c) { (c.group_names || "").split(", ").filter(Boolean).forEach(function(g) { groups.add(g); }); });
      groupSel.innerHTML = '<option value="">All Groups</option>' +
        [...groups].sort().map(function(g) { return '<option value="' + esc(g) + '">' + esc(g) + '</option>'; }).join("");
    }
    if (tagSel) {
      var tags = new Set();
      neglectedData.forEach(function(c) { (c.tag_names || "").split(", ").filter(Boolean).forEach(function(t) { tags.add(t); }); });
      tagSel.innerHTML = '<option value="">All Tags</option>' +
        [...tags].sort().map(function(t) { var p = parseTagCategory(t); return '<option value="' + esc(t) + '">' + esc(p.label) + '</option>'; }).join("");
    }

    renderNeglectedList();
  } catch (err) {
    console.error("Failed to load neglected:", err);
  }
}

function renderNeglectedList() {
  var container = $("neglected-list");
  if (!container) return;

  var filtered = [].concat(neglectedData);
  var groupFilter = $("neg-group-filter")?.value;
  var tagFilter = $("neg-tag-filter")?.value;
  var sortMode = $("neg-sort")?.value || "msgs-per-day";

  if (groupFilter) filtered = filtered.filter(function(c) { return (c.group_names || "").split(", ").includes(groupFilter); });
  if (tagFilter) filtered = filtered.filter(function(c) { return (c.tag_names || "").split(", ").includes(tagFilter); });

  if (sortMode === "msgs-per-day") filtered.sort(function(a, b) { return (b.messages_per_active_day || 0) - (a.messages_per_active_day || 0); });
  else if (sortMode === "total-in-range") filtered.sort(function(a, b) { return (b.messages_in_range || 0) - (a.messages_in_range || 0); });
  else if (sortMode === "voice-in-range") filtered.sort(function(a, b) { return (b.voice_notes_in_range || 0) - (a.voice_notes_in_range || 0); });

  // Limit to 10
  filtered = filtered.slice(0, 10);

  if (filtered.length === 0) {
    container.innerHTML = '<div class="chart-empty">No contacts with activity in this period.</div>';
    return;
  }

  container.innerHTML = filtered.map(function(c) {
    var tierDot = c.tier_color
      ? '<span class="neglected-tier-dot" style="background:' + esc(c.tier_color) + '"></span>' + esc(c.tier_name || "")
      : "";
    var metricLabel = "";
    if (sortMode === "msgs-per-day") metricLabel = (c.messages_per_active_day || 0) + " msgs/day";
    else if (sortMode === "total-in-range") metricLabel = (c.messages_in_range || 0) + " msgs";
    else if (sortMode === "voice-in-range") metricLabel = (c.voice_notes_in_range || 0) + " VNs";
    return '<div class="neglected-card" data-contact-id="' + esc(c.id) + '" style="cursor:pointer;">' +
      '<div class="neglected-card-info">' +
        '<span class="neglected-name">' + esc(contactDisplayName(c)) + '</span>' +
        '<div class="neglected-meta">' +
          '<span class="neglected-time">' + esc(metricLabel) + '</span>' +
          (c.active_days ? '<span>' + c.active_days + ' active days</span>' : '') +
          (tierDot ? '<span>' + tierDot + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<button class="neglected-dismiss" title="Dismiss" data-dismiss-id="' + esc(c.id) + '">&times;</button>' +
    '</div>';
  }).join("");

  container.querySelectorAll("[data-contact-id]").forEach(function(el) {
    el.addEventListener("click", function(e) {
      if (e.target.classList.contains("neglected-dismiss")) return;
      if (el.dataset.contactId) openContactDetail(el.dataset.contactId);
    });
  });
  container.querySelectorAll(".neglected-dismiss").forEach(function(btn) {
    btn.addEventListener("click", async function(e) {
      e.stopPropagation();
      var id = btn.dataset.dismissId;
      if (!id) return;
      try {
        await adminFetch("/api/friends/contacts/" + encodeURIComponent(id) + "/dismiss-neglected", { method: "POST" });
        neglectedData = neglectedData.filter(function(c) { return c.id !== id; });
        renderNeglectedList();
      } catch (err) {
        console.error("Dismiss failed:", err);
      }
    });
  });
}

function renderInitiatorsList(data) {
  const container = $("initiators-list");
  if (!container) return;
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No initiation data yet</div>';
    return;
  }
  container.innerHTML = data.map((item) => {
    const myInit = item.my_initiations || 0;
    const theirInit = item.their_initiations || 0;
    const total = myInit + theirInit || 1;
    const myPct = Math.round((myInit / total) * 100);
    const theirPct = 100 - myPct;
    return '<div class="initiator-row" data-contact-id="' + esc(item.contact_id || '') + '" style="cursor:pointer;">' +
      '<div class="initiator-name">' + esc(contactDisplayName(item)) + '</div>' +
      '<div class="initiator-bar-bg">' +
        '<div class="initiator-bar-fill" style="width:' + myPct + '%"></div>' +
      '</div>' +
      '<div class="initiator-value">' + myPct + '%</div>' +
    '</div>';
  }).join("");
  container.querySelectorAll("[data-contact-id]").forEach(el => {
    el.addEventListener("click", () => { if (el.dataset.contactId) openContactDetail(el.dataset.contactId); });
  });
}

// ── Top Friends (time-browsable) ──

let tfWindowDays = 14;
let tfOffsetDays = 0;
let tfNavBound = false;

function setupTopFriendsNav() {
  if (tfNavBound) return;
  tfNavBound = true;

  const prevBtn = $("tf-prev");
  const nextBtn = $("tf-next");
  const section = $("tf-section");

  // Window buttons
  document.querySelectorAll(".tf-window-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      tfWindowDays = parseInt(btn.dataset.days);
      tfOffsetDays = 0;
      document.querySelectorAll(".tf-window-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      loadTopFriends();
    });
  });

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      tfOffsetDays += tfWindowDays;
      loadTopFriends();
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      tfOffsetDays = Math.max(0, tfOffsetDays - tfWindowDays);
      loadTopFriends();
    });
  }

  // Keyboard navigation (left/right arrows)
  if (section) {
    section.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        tfOffsetDays += tfWindowDays;
        loadTopFriends();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        tfOffsetDays = Math.max(0, tfOffsetDays - tfWindowDays);
        loadTopFriends();
      }
    });
    // Auto-focus when scrolled into view
    section.addEventListener("mouseenter", () => section.focus());
  }
}

async function loadTopFriends() {
  const container = $("top-friends-list");
  const rangeEl = $("tf-date-range");
  const nextBtn = $("tf-next");
  const tfTierParam = dashboardTierFilter !== null ? "&tier=" + encodeURIComponent(dashboardTierFilter) : "";
  const lsKey = "_topFriends:" + tfWindowDays + ":" + tfOffsetDays + tfTierParam;

  // 1. Instant render from localStorage (stale data, shown immediately)
  try {
    var cached = localStorage.getItem(lsKey);
    if (cached) {
      var stale = JSON.parse(cached);
      if (rangeEl && stale.dateRange) rangeEl.textContent = stale.dateRange.start + " \u2192 " + stale.dateRange.end;
      if (nextBtn) nextBtn.disabled = tfOffsetDays <= 0;
      renderTopFriends(stale.friends);
    }
  } catch (e) { /* ignore parse errors */ }

  // 2. Fetch fresh data in background, re-render when ready
  try {
    const res = await cachedFetch("/api/friends/top-friends?days=" + tfWindowDays + "&offset=" + tfOffsetDays + "&limit=10" + tfTierParam);
    if (!res.ok) throw new Error("Failed");
    const data = await res.json();

    // Update date range label
    if (rangeEl && data.dateRange) {
      rangeEl.textContent = data.dateRange.start + " \u2192 " + data.dateRange.end;
    }

    // Disable "next" if at current period
    if (nextBtn) nextBtn.disabled = tfOffsetDays <= 0;

    renderTopFriends(data.friends);
    try { localStorage.setItem(lsKey, JSON.stringify(data)); } catch (e) { /* quota */ }
  } catch (err) {
    if (!cached && container) container.innerHTML = '<div class="chart-empty">Failed to load.</div>';
  }
}

function renderTopFriends(data) {
  const container = $("top-friends-list");
  if (!container) return;
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="chart-empty">No data for this period.</div>';
    return;
  }
  container.innerHTML = data.map((f, i) => {
    const rankClass = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
    const diff = (f.messages || 0) - (f.messages_prev || 0);
    const trendClass = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
    const trendIcon = diff > 0 ? "\u25B2" : diff < 0 ? "\u25BC" : "\u2022";
    const trendLabel = diff !== 0 ? " " + Math.abs(diff) : "";
    // Build tag chips HTML
    let tagsHtml = '';
    if (f.tag_names) {
      const tags = f.tag_names.split(', ').slice(0, 3);
      tagsHtml = '<div class="top-friend-tags">' + tags.map(t => {
        const p = parseTagCategory(t);
        return '<span class="top-friend-tag" data-tag="' + esc(t) + '" style="background:' + p.color + '18;color:' + p.color + ';">' + esc(p.label) + '</span>';
      }).join('') + '</div>';
    }
    const tierBadge = f.tier_color && f.tier_name
      ? '<span class="top-friend-tier" style="background:' + esc(f.tier_color) + '22;color:' + esc(f.tier_color) + ';border:1px solid ' + esc(f.tier_color) + '44;font-size:9px;padding:1px 6px;border-radius:3px;margin-left:6px;">' + esc(f.tier_name) + '</span>'
      : '';
    return '<div class="top-friend-row" data-contact-id="' + esc(String(f.id)) + '" style="cursor:pointer;">' +
      '<div class="top-friend-rank ' + rankClass + '">' + (i + 1) + '</div>' +
      '<div class="top-friend-name">' + esc(contactDisplayName(f)) + tierBadge + '</div>' +
      tagsHtml +
      '<div class="top-friend-score">' +
        '<span class="top-friend-count">' + (f.messages || 0) + '</span>' +
        '<span class="top-friend-trend ' + trendClass + '">' + trendIcon + trendLabel + '</span>' +
      '</div>' +
    '</div>';
  }).join("");

  container.querySelectorAll(".top-friend-row").forEach(row => {
    row.addEventListener("click", (e) => {
      // Don't open contact detail if clicking a tag chip
      if (e.target.closest(".top-friend-tag")) return;
      const id = row.dataset.contactId;
      if (id) openContactDetail(id);
    });
  });

  // Tag chip clicks: filter contacts by that tag
  container.querySelectorAll(".top-friend-tag").forEach(chip => {
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      const tag = chip.dataset.tag;
      if (!tag) return;
      activeTagFilters.clear();
      activeTagFilters.add(tag);
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      const contactsTab = document.querySelector('[data-tab="contacts"]');
      if (contactsTab) contactsTab.classList.add("active");
      const contactsContent = $("tab-contacts");
      if (contactsContent) contactsContent.classList.add("active");
      loadContacts();
    });
  });
}


// ── Fastest Responders ──

function renderFastResponders(data) {
  const container = $("fast-responders-list");
  if (!container) return;
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="chart-empty">No data yet.</div>';
    return;
  }
  container.innerHTML = data.map((f, i) => {
    return '<div class="fast-row" data-contact-id="' + esc(f.id) + '" style="cursor:pointer;">' +
      '<div class="fast-rank">' + (i + 1) + '</div>' +
      '<div class="fast-name">' + esc(contactDisplayName(f)) + '</div>' +
      '<div class="fast-time">' + formatDuration(f.avg_response_sec) + '</div>' +
    '</div>';
  }).join("");
  container.querySelectorAll("[data-contact-id]").forEach(el => {
    el.addEventListener("click", () => { if (el.dataset.contactId) openContactDetail(el.dataset.contactId); });
  });
}

// ── Hourly Activity Chart ──

function renderHourlyChart(data) {
  const canvas = $("hourly-chart");
  if (!canvas || !data || data.length === 0) return;

  if (hourlyChart) {
    hourlyChart.destroy();
    hourlyChart = null;
  }

  // Fill in missing hours
  const hourData = Array.from({ length: 24 }, (_, i) => {
    const found = data.find(d => d.hour === i);
    return found ? found.count : 0;
  });

  const labels = Array.from({ length: 24 }, (_, i) => {
    if (i === 0) return "12a";
    if (i < 12) return i + "a";
    if (i === 12) return "12p";
    return (i - 12) + "p";
  });

  const ctx = canvas.getContext("2d");
  hourlyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [{
        label: "Messages",
        data: hourData,
        backgroundColor: hourData.map((_, i) =>
          i >= 6 && i < 12 ? "rgba(253,203,110,0.6)" :
          i >= 12 && i < 18 ? "rgba(79,195,247,0.6)" :
          i >= 18 && i < 22 ? "rgba(129,199,132,0.6)" :
          "rgba(149,117,205,0.4)"
        ),
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#888", font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { color: "#888" }, grid: { color: "#333" } },
      },
    },
  });
}

// ── Contacts Tab ──

async function loadContacts() {
  try {
    // Load groups, tiers, and tags for filter dropdowns (cached)
    const [groupsRes, tiersRes, tagsRes] = await Promise.all([
      cachedFetch("/api/friends/groups"),
      cachedFetch("/api/friends/tiers"),
      cachedFetch("/api/friends/tags"),
    ]);
    if (groupsRes.ok) {
      groups = await groupsRes.json();
      populateGroupFilter();
    }
    if (tiersRes.ok) {
      const tiers = await tiersRes.json();
      populateTierFilter(tiers);
    }
    if (tagsRes.ok) {
      const tags = await tagsRes.json();
      renderTagFilters(tags);
    }

    const params = new URLSearchParams();
    params.set("sort", currentSort.field);
    params.set("dir", currentSort.dir);

    const groupFilter = $("filter-group");
    if (groupFilter && groupFilter.value) params.set("group", groupFilter.value);

    const tierFilter = $("filter-tier");
    if (tierFilter && tierFilter.value) params.set("tier", tierFilter.value);

    const qualityFilter = $("filter-quality");
    if (qualityFilter && qualityFilter.value) params.set("minScore", qualityFilter.value);

    const searchInput = $("contact-search");
    if (searchInput && searchInput.value.trim()) params.set("search", searchInput.value.trim());

    // Tag filters
    if (activeTagFilters.size > 0) {
      params.set("tags", [...activeTagFilters].join(","));
      params.set("tagMode", tagFilterMode);
    }

    const res = await adminFetch("/api/friends/contacts?" + params.toString());
    if (!res.ok) throw new Error("Server returned " + res.status);
    contacts = await res.json();
    renderContactsTable(contacts);
  } catch (err) {
    console.error("Failed to load contacts:", err);
  }
}

function populateGroupFilter() {
  const select = $("filter-group");
  if (!select) return;
  const currentVal = select.value;
  select.innerHTML = '<option value="">All Groups</option>' +
    groups.map((g) =>
      '<option value="' + esc(String(g.id)) + '">' + esc(g.name) + '</option>'
    ).join("");
  select.value = currentVal;
}

function populateTierFilter(tiers) {
  const select = $("filter-tier");
  if (!select) return;
  const currentVal = select.value;
  select.innerHTML = '<option value="">All Tiers</option>' +
    '<option value="none">Unassigned</option>' +
    tiers.map((t) =>
      '<option value="' + esc(String(t.id)) + '">' + esc(t.name) + '</option>'
    ).join("");
  select.value = currentVal;
}

function renderTagFilters(tags) {
  const container = $("tag-filters");
  if (!container || !tags || tags.length === 0) {
    if (container) container.innerHTML = '';
    return;
  }
  let html = tags.slice(0, 30).map(t => {
    const active = activeTagFilters.has(t.name) ? ' active' : '';
    const p = parseTagCategory(t.name);
    return '<span class="tag-chip' + active + '" data-tag="' + esc(t.name) + '" style="' + (active ? '' : 'border-color:' + p.color + '40;color:' + p.color + ';') + '">' +
      esc(p.label) + ' <span class="tag-count">' + t.contact_count + '</span>' +
    '</span>';
  }).join("");

  if (activeTagFilters.size >= 2) {
    html += '<span class="tag-mode-toggle" title="Toggle AND/OR">' + tagFilterMode + '</span>';
  }

  container.innerHTML = html;

  container.querySelectorAll(".tag-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const tag = chip.dataset.tag;
      if (activeTagFilters.has(tag)) activeTagFilters.delete(tag);
      else activeTagFilters.add(tag);
      loadContacts();
    });
  });

  const modeToggle = container.querySelector(".tag-mode-toggle");
  if (modeToggle) {
    modeToggle.addEventListener("click", () => {
      tagFilterMode = tagFilterMode === "OR" ? "AND" : "OR";
      loadContacts();
    });
  }
}

function renderContactsTable(data) {
  const tbody = $("contacts-tbody");
  if (!tbody) return;
  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No contacts found</td></tr>';
    return;
  }
  tbody.innerHTML = data.map((c) => {
    const ratio = c.initiation_ratio != null ? Math.round(c.initiation_ratio) : null;
    let ratioClass = "ratio-red";
    if (ratio !== null) {
      if (ratio >= 40 && ratio <= 60) ratioClass = "ratio-green";
      else if (ratio >= 25 && ratio <= 75) ratioClass = "ratio-yellow";
    }
    const qClass = qualityClass(c.quality_score);
    const qScore = c.quality_score != null ? Math.round(c.quality_score) : "--";
    const tierDot = c.tier_color
      ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + esc(c.tier_color) + ';margin-right:4px;"></span>'
      : '';
    const tagChips = c.tag_names
      ? c.tag_names.split(', ').slice(0, 3).map(t => { const p = parseTagCategory(t); return '<span class="detail-tag" style="font-size:9px;padding:1px 5px;background:' + p.color + '20;color:' + p.color + ';border:1px solid ' + p.color + '40;">' + esc(p.label) + '</span>'; }).join('')
      : '';
    const displayName = contactDisplayName(c);
    return '<tr class="contact-row" data-id="' + esc(String(c.id)) + '">' +
      '<td class="contact-name-cell"><strong>' + esc(displayName) + '</strong>' + (tagChips ? '<div style="margin-top:2px;">' + tagChips + '</div>' : '') + '</td>' +
      '<td>' + tierDot + esc(c.tier_name || "") + '</td>' +
      '<td>' + (c.last_seen ? timeAgo(c.last_seen) : "--") + '</td>' +
      '<td>' + (c.messages_30d ?? 0) + '</td>' +
      '<td class="' + ratioClass + '">' + (ratio !== null ? ratio + "%" : "--") + '</td>' +
      '<td>' + (c.their_avg_response_sec ? formatDuration(c.their_avg_response_sec) : "--") + '</td>' +
      '<td><span class="quality-badge ' + qClass + '">' + qScore + '</span></td>' +
    '</tr>';
  }).join("");

  // Click handlers
  tbody.querySelectorAll(".contact-row").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.id;
      if (id) openContactDetail(id);
    });
  });

  // Setup sortable headers
  setupSortableHeaders();
}

function setupSortableHeaders() {
  document.querySelectorAll("[data-sort]").forEach((header) => {
    // Remove old listeners by cloning
    const newHeader = header.cloneNode(true);
    header.parentNode.replaceChild(newHeader, header);
    newHeader.addEventListener("click", () => {
      const field = newHeader.dataset.sort;
      if (currentSort.field === field) {
        currentSort.dir = currentSort.dir === "asc" ? "desc" : "asc";
      } else {
        currentSort.field = field;
        currentSort.dir = "desc";
      }
      // Update sort indicators
      document.querySelectorAll("[data-sort]").forEach((h) => {
        h.classList.remove("sort-asc", "sort-desc");
      });
      newHeader.classList.add(currentSort.dir === "asc" ? "sort-asc" : "sort-desc");
      loadContacts();
    });
  });
  // Apply initial sort indicator
  const initialHeader = document.querySelector('[data-sort="' + currentSort.field + '"]');
  if (initialHeader) initialHeader.classList.add(currentSort.dir === "asc" ? "sort-asc" : "sort-desc");
}

let currentDetailContactId = null;
let currentDetailRange = "all";

function renderDetailStats(stats) {
  const detailStats = $("detail-stats");
  if (!detailStats) return;
  const myResp = stats.my_avg_response_sec ? formatDuration(stats.my_avg_response_sec) : "--";
  const theirResp = stats.their_avg_response_sec ? formatDuration(stats.their_avg_response_sec) : "--";
  detailStats.innerHTML =
    '<div class="detail-stat">' +
      '<div class="value">' + (stats.total_messages ?? 0) + '</div>' +
      '<div class="label">Messages</div>' +
    '</div>' +
    '<div class="detail-stat">' +
      '<div class="value">' + (stats.sent_messages ?? 0) + '</div>' +
      '<div class="label">Sent</div>' +
    '</div>' +
    '<div class="detail-stat">' +
      '<div class="value">' + (stats.received_messages ?? 0) + '</div>' +
      '<div class="label">Received</div>' +
    '</div>' +
    '<div class="detail-stat">' +
      '<div class="value">' + (stats.initiation_ratio != null ? Math.round(stats.initiation_ratio) + "%" : "--") + '</div>' +
      '<div class="label">My Initiation %</div>' +
    '</div>' +
    '<div class="detail-stat">' +
      '<div class="value">' + myResp + '</div>' +
      '<div class="label">My Avg Response</div>' +
    '</div>' +
    '<div class="detail-stat">' +
      '<div class="value">' + theirResp + '</div>' +
      '<div class="label">Their Avg Response</div>' +
    '</div>';
}

function renderDetailVoice(voiceStats) {
  const detailVoice = $("detail-voice-stats");
  if (!detailVoice) return;
  if (voiceStats && voiceStats.total_notes > 0) {
    detailVoice.innerHTML =
      '<div class="voice-stat-item"><div class="val">' + voiceStats.total_notes + '</div><div class="lbl">Voice Notes</div></div>' +
      '<div class="voice-stat-item"><div class="val">' + voiceStats.total_minutes + '</div><div class="lbl">Minutes</div></div>' +
      '<div class="voice-stat-item"><div class="val">' + voiceStats.sent_notes + '</div><div class="lbl">Sent</div></div>' +
      '<div class="voice-stat-item"><div class="val">' + voiceStats.received_notes + '</div><div class="lbl">Received</div></div>';
  } else {
    detailVoice.innerHTML = '';
  }
}

function rangeLabel(range) {
  if (range === "7d") return "7 Days";
  if (range === "30d") return "30 Days";
  if (range === "90d") return "90 Days";
  if (range === "1y") return "1 Year";
  return "All Time";
}

async function refreshDetailRange(contactId, range) {
  currentDetailRange = range;
  // Update pill UI
  document.querySelectorAll(".detail-range-pill").forEach(p =>
    p.classList.toggle("active", p.dataset.range === range)
  );
  // Update chart title
  const chartTitle = $("detail-chart-title");
  if (chartTitle) chartTitle.textContent = "Activity — " + rangeLabel(range);

  try {
    const rangeParam = range === "all" ? "" : "?range=" + range;
    const [detailRes, activityRes] = await Promise.all([
      adminFetch("/api/friends/contacts/" + encodeURIComponent(contactId) + rangeParam),
      adminFetch("/api/friends/contacts/" + encodeURIComponent(contactId) + "/activity?granularity=week" + (range === "all" ? "" : "&range=" + range)),
    ]);
    if (detailRes.ok) {
      const data = await detailRes.json();
      renderDetailStats(data.stats);
      renderDetailVoice(data.voiceStats);
    }
    if (activityRes.ok) {
      const activityData = await activityRes.json();
      renderDetailChart(activityData);
    }
  } catch (err) {
    console.error("Failed to refresh range:", err);
  }
}

async function openContactDetail(contactId) {
  const panel = $("detail-panel");
  const overlay = $("detail-overlay");
  if (!panel || !overlay) return;

  panel.classList.add("open");
  overlay.classList.add("open");
  currentDetailContactId = contactId;
  currentDetailRange = "all";

  // Reset range pills to "All Time"
  document.querySelectorAll(".detail-range-pill").forEach(p =>
    p.classList.toggle("active", p.dataset.range === "all")
  );

  // Clear all panel sections to prevent stale data from previous contact
  const nameEl = $("detail-name");
  if (nameEl) nameEl.textContent = "Loading...";
  const phoneEl = $("detail-phone");
  if (phoneEl) phoneEl.style.display = "none";
  const detailGroups = $("detail-groups");
  if (detailGroups) detailGroups.innerHTML = "";
  const detailTags = $("detail-tags");
  if (detailTags) detailTags.innerHTML = "";
  const detailNotes = $("detail-notes-list");
  if (detailNotes) detailNotes.innerHTML = "";
  const detailStats = $("detail-stats");
  if (detailStats) detailStats.innerHTML = "";
  const detailVoice = $("detail-voice");
  if (detailVoice) detailVoice.innerHTML = "";
  const detailMessages = $("detail-messages");
  if (detailMessages) detailMessages.innerHTML = "";
  const tierSelect = $("detail-tier-select");
  if (tierSelect) tierSelect.innerHTML = "";

  try {
    // Fetch contact detail, activity, and messages in parallel
    const [detailRes, activityRes, messagesRes] = await Promise.all([
      adminFetch("/api/friends/contacts/" + encodeURIComponent(contactId)),
      adminFetch("/api/friends/contacts/" + encodeURIComponent(contactId) + "/activity?granularity=week"),
      adminFetch("/api/friends/contacts/" + encodeURIComponent(contactId) + "/messages?limit=50&offset=0"),
    ]);

    if (!detailRes.ok) throw new Error("Failed to load contact");
    const detailData = await detailRes.json();
    const contact = detailData.contact;

    // Populate detail panel with editable name
    const displayName = contactDisplayName(contact);
    const nameDisplay = $("detail-name");
    if (nameDisplay) {
      nameDisplay.textContent = displayName;
      nameDisplay.style.display = "";
    }
    const nameEdit = $("detail-name-edit");
    if (nameEdit) nameEdit.classList.add("hidden");

    // Phone number (extracted from contact ID — only for @c.us or @s.whatsapp.net, not @lid)
    const phoneEl = $("detail-phone");
    if (phoneEl) {
      const isPhoneId = contactId.endsWith("@c.us") || contactId.endsWith("@s.whatsapp.net");
      const phone = isPhoneId ? contactId.split("@")[0] : "";
      if (phone && /^\d{7,15}$/.test(phone)) {
        phoneEl.textContent = "+" + phone;
        phoneEl.href = "tel:+" + phone;
        phoneEl.style.display = "";
      } else {
        phoneEl.style.display = "none";
      }
    }

    setupNameEditing(contactId, displayName);

    // Hide/ignore button
    const hideBtn = $("detail-hide-btn");
    if (hideBtn) {
      hideBtn.textContent = "Hide";
      hideBtn.onclick = async () => {
        if (!confirm("Hide this contact from all views? You can unhide from Settings.")) return;
        try {
          await adminFetch("/api/friends/contacts/" + encodeURIComponent(contactId) + "/hide", { method: "POST" });
          closeDetailPanel();
          loadContacts();
        } catch (err) { console.error("Failed to hide contact:", err); }
      };
    }

    // Stats + Voice (via extracted functions)
    renderDetailStats(detailData.stats);
    renderDetailVoice(detailData.voiceStats);

    // Groups list
    const detailGroups = $("detail-groups");
    if (detailGroups && detailData.groups) {
      detailGroups.innerHTML = detailData.groups.length > 0
        ? detailData.groups.map((g) =>
            '<span class="group-chip" style="background:' + esc(g.color || "#555") + '">' + esc(g.name) + '</span>'
          ).join("")
        : '<span class="empty-state">No groups</span>';
    }

    // Tier selector
    renderDetailTierSelect(contactId, contact.tier_id);

    // Tags (editable)
    renderDetailTags(contactId, detailData.tags || []);

    // Timestamped Notes
    renderContactNotes(contactId, detailData.notes || []);

    // Chart title
    const chartTitle = $("detail-chart-title");
    if (chartTitle) chartTitle.textContent = "Activity — All Time";

    // Activity chart
    if (activityRes.ok) {
      const activityData = await activityRes.json();
      renderDetailChart(activityData);
    }

    // Conversation log — show cached messages first, then fetch fresh from WhatsApp
    if (messagesRes.ok) {
      const msgData = await messagesRes.json();
      var cachedMessages = msgData.messages || [];
      renderConversationLog(contactId, cachedMessages, false);

      // Check if many messages lack body text — fetch fresh history from WhatsApp (only for WA contacts)
      var isWhatsApp = contactId.endsWith("@c.us") || contactId.endsWith("@s.whatsapp.net") || contactId.endsWith("@lid");
      var emptyCount = cachedMessages.filter(function(m) {
        return (!m.body || !m.body.trim()) && m.message_type === "chat" && m.source === "whatsapp";
      }).length;

      if (isWhatsApp && (emptyCount > 0 || cachedMessages.length === 0)) {
        // Show loading indicator
        var container = $("detail-messages");
        if (container && cachedMessages.length === 0) {
          container.innerHTML = '<div class="chart-empty">Fetching chat history from WhatsApp...</div>';
        }
        // Fetch fresh history in background
        adminFetch("/api/friends/contacts/" + encodeURIComponent(contactId) + "/fetch-history", {
          method: "POST"
        }).then(function(fetchRes) {
          if (!fetchRes.ok) return;
          return fetchRes.json();
        }).then(function(data) {
          if (data && data.messages && data.messages.length > 0) {
            renderConversationLog(contactId, data.messages, false);
          }
        }).catch(function(err) {
          console.log("Background history fetch failed:", err);
        });
      }
    }

    // Reply box — show for WhatsApp contacts only (iMessage is receive-only)
    setupDetailReplyBox(contactId, cachedMessages || []);
  } catch (err) {
    console.error("Failed to load contact detail:", err, "ID:", contactId);
    const nameDisplay = $("detail-name");
    if (nameDisplay) nameDisplay.textContent = "Error loading contact";
  }
}

// ── Detail Reply Box ──

function setupDetailReplyBox(contactId, messages) {
  const replyBox = $("detail-reply-box");
  const replyInput = $("detail-reply-input");
  const replyBtn = $("detail-reply-send");
  const replyPlatform = $("detail-reply-platform");
  const replyStatus = $("detail-reply-status");
  if (!replyBox) return;

  // Determine platform from contact ID and message history
  var isWhatsApp = contactId.endsWith("@c.us") || contactId.endsWith("@s.whatsapp.net") || contactId.endsWith("@lid");
  var isIMessage = contactId.endsWith("@imessage");

  // Check most recent message source as fallback
  if (!isWhatsApp && !isIMessage && messages.length > 0) {
    var lastMsg = messages[0]; // messages are newest-first
    if (lastMsg.source === "whatsapp") isWhatsApp = true;
    else if (lastMsg.source === "imessage") isIMessage = true;
  }

  if (!isWhatsApp && !isIMessage) {
    replyBox.style.display = "none";
    return;
  }

  // Determine phone number for iMessage
  var imessagePhone = "";
  if (isIMessage) {
    imessagePhone = contactId.split("@")[0];
    if (/^\d{7,15}$/.test(imessagePhone)) imessagePhone = "+" + imessagePhone;
  }

  // Show reply box for both platforms
  replyBox.style.display = "";
  replyInput.style.display = "";
  replyBtn.style.display = "";
  replyInput.value = "";
  replyStatus.style.display = "none";
  replyPlatform.innerHTML = isWhatsApp
    ? 'Reply via <span style="color:#25D366;">WhatsApp</span>'
    : 'Reply via <span style="color:#3478F6;">iMessage</span>';

  // Auto-resize textarea
  replyInput.oninput = function() {
    replyInput.style.height = "auto";
    replyInput.style.height = Math.min(replyInput.scrollHeight, 80) + "px";
  };

  // Send on Enter (Shift+Enter for newline)
  replyInput.onkeydown = function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      replyBtn.click();
    }
  };

  // Clone to remove old listeners
  var newBtn = replyBtn.cloneNode(true);
  replyBtn.parentNode.replaceChild(newBtn, replyBtn);

  newBtn.addEventListener("click", async function() {
    var msg = replyInput.value.trim();
    if (!msg) return;

    newBtn.disabled = true;
    newBtn.textContent = "Sending...";
    replyStatus.style.display = "";
    replyStatus.style.color = "var(--text-dim)";
    replyStatus.textContent = "Sending message...";

    try {
      var res;
      if (isIMessage) {
        // iMessage: queue via bridge, then poll for result
        res = await adminFetch("/api/friends/send-imessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: imessagePhone, message: msg }),
        });
        if (!res.ok) {
          var errData = await res.json().catch(function() { return {}; });
          throw new Error(errData.error || "Send failed");
        }
        var queueData = await res.json();
        if (!queueData.queued || !queueData.taskId) {
          throw new Error("Failed to queue message");
        }
        // Poll bridge status until done/error (max 45 seconds — bridge polls every 15s)
        replyStatus.textContent = "Sending via iMessage bridge...";
        var taskDone = false;
        for (var attempt = 0; attempt < 45; attempt++) {
          await new Promise(function(r) { setTimeout(r, 1000); });
          try {
            var statusRes = await adminFetch("/api/friends/imessage/bridge/status/" + queueData.taskId);
            if (statusRes.ok) {
              var bridgeStatus = await statusRes.json();
              if (!bridgeStatus.bridgeOnline && attempt === 0) {
                replyStatus.textContent = "Waiting for iMessage bridge (is your Mac online?)...";
              }
              if (bridgeStatus.status === "done") {
                taskDone = true;
                break;
              } else if (bridgeStatus.status === "error") {
                throw new Error(bridgeStatus.error || "iMessage send failed");
              } else if (bridgeStatus.status === "expired") {
                throw new Error("Message expired before bridge could process it");
              } else if (bridgeStatus.status === "claimed") {
                replyStatus.textContent = "Bridge is sending...";
              }
            }
          } catch (pollErr) {
            if (pollErr.message && !pollErr.message.includes("Failed to fetch")) throw pollErr;
          }
        }
        if (!taskDone) throw new Error("Bridge timed out (45s) \u2014 is your Mac running the iMessage bridge?");
      } else {
        // WhatsApp: async — API returns immediately, poll for actual delivery
        res = await adminFetch("/api/friends/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactIds: [contactId], message: msg }),
        });
        if (!res.ok) {
          var errData2 = await res.json().catch(function() { return {}; });
          throw new Error(errData2.error || "Send failed");
        }
        // Poll send-status until done/error (max 15 seconds)
        replyStatus.textContent = "Delivering via WhatsApp...";
        var delivered = false;
        for (var attempt = 0; attempt < 8; attempt++) {
          await new Promise(function(r) { setTimeout(r, 2000); });
          try {
            var statusRes = await adminFetch("/api/friends/send-status");
            if (statusRes.ok) {
              var status = await statusRes.json();
              if (status.phase === "done" || status.phase === "idle") {
                if (status.failed > 0) throw new Error(status.errorMessage || "WhatsApp delivery failed");
                delivered = true;
                break;
              } else if (status.phase === "error") {
                throw new Error(status.errorMessage || "WhatsApp delivery failed");
              }
            }
          } catch (pollErr) {
            if (pollErr.message && pollErr.message !== "Failed") throw pollErr;
          }
        }
        if (!delivered) throw new Error("Delivery timed out — check WhatsApp connection");
      }

      // Success — clear input and show sent message in conversation
      replyInput.value = "";
      replyInput.style.height = "auto";
      var successColor = isIMessage ? "#3478F6" : "#25D366";
      replyStatus.style.color = successColor;
      replyStatus.textContent = "Sent!";
      setTimeout(function() { replyStatus.style.display = "none"; }, 3000);

      // Append the sent message to conversation log
      var container = $("detail-messages");
      if (container) {
        var now = new Date();
        var timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        var sourceBadge = isIMessage
          ? '<span class="msg-source imessage">iM</span>'
          : '<span class="msg-source whatsapp">WA</span>';
        var bubbleClass = isIMessage ? "msg-bubble sent imessage" : "msg-bubble sent";
        var bubble = '<div class="msg-row sent">' +
          '<div class="' + bubbleClass + '">' +
            esc(msg) +
            '<span class="msg-time">' + sourceBadge + esc(timeStr) + '</span>' +
          '</div></div>';
        container.insertAdjacentHTML("beforeend", bubble);
        container.scrollTop = container.scrollHeight;
      }
    } catch (err) {
      replyStatus.style.color = "#f44";
      replyStatus.textContent = "Failed: " + err.message;
    } finally {
      newBtn.disabled = false;
      newBtn.textContent = "Send";
    }
  });
}

// ── Conversation Log ──

let msgOffset = 0;
let msgContactId = null;

function renderConversationLog(contactId, messages, append) {
  const container = $("detail-messages");
  const loadMoreBtn = $("load-more-messages");
  if (!container) return;

  msgContactId = contactId;

  if (!append) {
    msgOffset = 0;
    container.innerHTML = "";
  }

  if (messages.length === 0 && !append) {
    container.innerHTML = '<div class="chart-empty">No messages stored yet. New messages will appear here after a server restart.</div>';
    if (loadMoreBtn) loadMoreBtn.style.display = "none";
    return;
  }

  // Messages come in DESC order (newest first) — reverse for chronological display
  // Filter out text/chat messages with no body (body was not captured during sync)
  const chronological = [...messages].reverse().filter(m => {
    if ((!m.body || !m.body.trim()) && (m.message_type === "chat" || m.message_type === "text" || !m.message_type)) return false;
    return true;
  });

  let lastDate = "";
  const html = chronological.map(m => {
    const dir = m.is_from_me ? "sent" : "received";
    const dt = new Date(m.timestamp * 1000);
    const dateStr = dt.toLocaleDateString();
    const timeStr = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    let dateDivider = "";
    if (dateStr !== lastDate) {
      lastDate = dateStr;
      dateDivider = '<div class="msg-date-divider">' + esc(dateStr) + '</div>';
    }

    let bodyHtml = "";
    if (m.message_type === "ptt") {
      // Voice note — show transcript if available
      if (m.voice_transcript && m.voice_transcript.trim() && m.voice_transcript !== "[transcription failed]") {
        bodyHtml = '<span class="msg-voice-transcript">' + esc(m.voice_transcript) + '</span>';
      } else {
        bodyHtml = '<span class="msg-type-label">Voice note</span>';
      }
    } else if (m.body && m.body.trim()) {
      bodyHtml = esc(m.body);
    } else if (m.message_type === "image") {
      bodyHtml = '<span class="msg-type-label">Image</span>';
    } else if (m.message_type === "video") {
      bodyHtml = '<span class="msg-type-label">Video</span>';
    } else if (m.message_type === "sticker") {
      bodyHtml = '<span class="msg-type-label">Sticker</span>';
    } else if (m.message_type === "document") {
      bodyHtml = '<span class="msg-type-label">Document</span>';
    } else {
      bodyHtml = '<span class="msg-type-label">' + esc(m.message_type || "message") + '</span>';
    }

    var sourceBadge = "";
    if (m.source === "imessage") {
      sourceBadge = '<span class="msg-source imessage">iM</span>';
    } else if (m.source === "whatsapp") {
      sourceBadge = '<span class="msg-source whatsapp">WA</span>';
    }

    return dateDivider +
      '<div class="msg-row ' + dir + '">' +
        '<div class="msg-bubble ' + dir + (m.source === "imessage" ? " imessage" : "") + '">' +
          bodyHtml +
          '<span class="msg-time">' + sourceBadge + esc(timeStr) + '</span>' +
        '</div>' +
      '</div>';
  }).join("");

  if (append) {
    // Prepend older messages at the top, preserving scroll position
    const prevHeight = container.scrollHeight;
    container.insertAdjacentHTML("afterbegin", html);
    container.scrollTop = container.scrollHeight - prevHeight;
  } else {
    container.innerHTML = html;
    // Scroll to bottom for initial load
    container.scrollTop = container.scrollHeight;
  }

  msgOffset += messages.length;

  // Show/hide load more
  if (loadMoreBtn) {
    loadMoreBtn.style.display = messages.length >= 50 ? "" : "none";
    loadMoreBtn.onclick = async () => {
      try {
        const res = await adminFetch("/api/friends/contacts/" + encodeURIComponent(msgContactId) + "/messages?limit=50&offset=" + msgOffset);
        if (!res.ok) return;
        const data = await res.json();
        if (data.messages && data.messages.length > 0) {
          renderConversationLog(msgContactId, data.messages, true);
        }
        if (!data.messages || data.messages.length < 50) {
          loadMoreBtn.style.display = "none";
        }
      } catch (err) {
        console.error("Failed to load more messages:", err);
      }
    };
  }
}

function renderDetailChart(data) {
  const canvas = $("detail-chart");
  if (!canvas) return;

  if (detailChart) {
    detailChart.destroy();
    detailChart = null;
  }

  if (!data || data.length === 0) return;

  const ctx = canvas.getContext("2d");
  detailChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map((d) => d.period || ""),
      datasets: [
        {
          label: "Sent",
          data: data.map((d) => d.sent || 0),
          backgroundColor: "rgba(79, 195, 247, 0.7)",
          order: 2,
        },
        {
          label: "Received",
          data: data.map((d) => d.received || 0),
          backgroundColor: "rgba(129, 199, 132, 0.7)",
          order: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: "#fff" },
        },
      },
      scales: {
        x: {
          ticks: { color: "#888" },
          grid: { color: "#333" },
        },
        y: {
          ticks: { color: "#888" },
          grid: { color: "#333" },
        },
      },
    },
  });
}

// ── Detail Tags (editable) ──

const TAG_COLORS = {
  "loc:": "#4fc3f7",    // location - blue
  "ctx:": "#81c784",    // context - green
  "tone:": "#ffb74d",   // tone - orange
  "emo:": "#f06292",    // emotion - pink
  "": "#b39ddb",        // topics (no prefix) - purple
};

function parseTagCategory(name) {
  for (const [prefix, color] of Object.entries(TAG_COLORS)) {
    if (prefix && name.startsWith(prefix)) {
      return { label: name.slice(prefix.length), color, category: prefix.slice(0, -1) };
    }
  }
  return { label: name, color: TAG_COLORS[""], category: "topic" };
}

async function renderDetailTierSelect(contactId, currentTierId) {
  const container = $("detail-tier-select");
  if (!container) return;
  try {
    const res = await adminFetch("/api/friends/tiers");
    if (!res.ok) { container.innerHTML = ""; return; }
    const tiers = await res.json();
    let html = '<label>Tier:</label><select id="detail-tier-dropdown">';
    html += '<option value="">Unassigned</option>';
    for (const t of tiers) {
      const sel = t.id === currentTierId ? " selected" : "";
      html += '<option value="' + t.id + '"' + sel + '>' + esc(t.name) + '</option>';
    }
    html += '</select>';
    container.innerHTML = html;
    const dropdown = $("detail-tier-dropdown");
    if (dropdown) {
      dropdown.addEventListener("change", async () => {
        const tierId = dropdown.value ? parseInt(dropdown.value) : null;
        try {
          await adminFetch("/api/friends/contacts/" + encodeURIComponent(contactId) + "/tier", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tier_id: tierId }),
          });
        } catch (err) {
          console.error("Failed to update tier:", err);
        }
      });
    }
  } catch (err) {
    console.error("Failed to load tiers for select:", err);
    container.innerHTML = "";
  }
}

function renderDetailTags(contactId, tags) {
  const container = $("detail-tags");
  if (!container) return;

  let html = tags.map((t) => {
    const { label, color } = parseTagCategory(t.name);
    return '<span class="detail-tag" data-tag-name="' + esc(t.name) + '" data-tag-id="' + t.tag_id + '" style="background:' + color + '20;color:' + color + ';border:1px solid ' + color + '40;" title="Click to find contacts with this tag">' +
      esc(label) +
      (t.contact_count > 1 ? ' <span class="tag-count">' + t.contact_count + '</span>' : '') +
      ' <span class="tag-remove" data-contact="' + esc(contactId) + '" data-tag-id="' + t.tag_id + '">&times;</span>' +
    '</span>';
  }).join("");

  html += '<span class="tag-add-form">' +
    '<input type="text" id="tag-add-input" placeholder="+ add tag" maxlength="40">' +
    '<button id="tag-add-btn" type="button">+</button>' +
    '</span>';

  html += ' <button class="tag-extract-btn" id="tag-extract-btn" title="AI-generate tags from conversation">AI Tags</button>';

  container.innerHTML = html;

  // Remove tag handlers
  container.querySelectorAll(".tag-remove").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const cId = btn.dataset.contact;
      const tId = btn.dataset.tagId;
      try {
        const res = await adminFetch("/api/friends/contacts/" + encodeURIComponent(cId) + "/tags/" + tId, { method: "DELETE" });
        if (!res.ok) throw new Error("Failed");
        const updated = await res.json();
        renderDetailTags(cId, updated);
      } catch (err) {
        console.error("Failed to remove tag:", err);
      }
    });
  });

  // Clickable tags — navigate to contacts list filtered by tag
  container.querySelectorAll(".detail-tag[data-tag-name]").forEach(chip => {
    chip.addEventListener("click", (e) => {
      if (e.target.closest(".tag-remove")) return; // don't trigger on X button
      const tagName = chip.dataset.tagName;
      if (!tagName) return;
      // Close detail panel and switch to contacts tab filtered by this tag
      $("detail-panel")?.classList.remove("open");
      $("detail-overlay")?.classList.remove("open");
      activeTagFilters.clear();
      activeTagFilters.add(tagName);
      switchTab("contacts");
      loadContacts();
    });
  });

  // Add tag handler
  const addBtn = $("tag-add-btn");
  const addInput = $("tag-add-input");
  if (addBtn && addInput) {
    const doAdd = async () => {
      const name = addInput.value.trim();
      if (!name) return;
      addInput.value = "";
      try {
        const res = await adminFetch("/api/friends/contacts/" + encodeURIComponent(contactId) + "/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error("Failed");
        const updated = await res.json();
        renderDetailTags(contactId, updated);
      } catch (err) {
        console.error("Failed to add tag:", err);
      }
    };
    addBtn.addEventListener("click", doAdd);
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doAdd(); }
    });
  }

  // AI extract handler
  const extractBtn = $("tag-extract-btn");
  if (extractBtn) {
    extractBtn.addEventListener("click", async () => {
      extractBtn.disabled = true;
      extractBtn.textContent = "Extracting...";
      try {
        const res = await adminFetch("/api/friends/tags/extract", { method: "POST" });
        if (!res.ok) throw new Error("Extraction failed");
        // Refresh tags for this contact
        const tagRes = await adminFetch("/api/friends/contacts/" + encodeURIComponent(contactId) + "/tags");
        if (tagRes.ok) {
          const updated = await tagRes.json();
          renderDetailTags(contactId, updated);
        }
      } catch (err) {
        console.error("Tag extraction failed:", err);
        extractBtn.textContent = "Failed";
        setTimeout(() => { extractBtn.textContent = "AI Tags"; extractBtn.disabled = false; }, 2000);
      }
    });
  }
}

// ── Groups Tab ──

function setupGroupHandlers() {
  const createBtn = $("create-group-btn");
  if (createBtn) createBtn.addEventListener("click", () => createGroupModal());
}

async function loadGroups() {
  try {
    const [groupsRes, contactsRes] = await Promise.all([
      adminFetch("/api/friends/groups"),
      adminFetch("/api/friends/contacts?sort=name&dir=asc"),
    ]);
    if (!groupsRes.ok) throw new Error("Failed to load groups");
    if (!contactsRes.ok) throw new Error("Failed to load contacts");
    groups = await groupsRes.json();
    const allContacts = await contactsRes.json();
    renderGroupLanes(groups, allContacts);
  } catch (err) {
    console.error("Failed to load groups:", err);
  }
}

function renderGroupLanes(groupsList, allContacts) {
  const container = $("group-lanes");
  if (!container) return;

  // Determine which contacts are in at least one group
  const assignedIds = new Set();
  groupsList.forEach((g) => {
    if (g.members) g.members.forEach((m) => assignedIds.add(m.id));
  });
  const ungrouped = allContacts.filter((c) => !assignedIds.has(c.id));

  let html = '';

  // Render each group lane
  groupsList.forEach((g) => {
    const colorDot = g.color ? 'style="background:' + esc(g.color) + '"' : '';
    const members = g.members || [];
    html += '<div class="group-lane" data-group-id="' + esc(String(g.id)) + '">' +
      '<div class="group-lane-header">' +
        '<span class="group-color-dot" ' + colorDot + '></span>' +
        '<span class="group-lane-title">' + esc(g.name) + '</span>' +
        '<span class="group-lane-count">(' + members.length + ')</span>' +
        '<button class="group-edit-btn" data-group-id="' + esc(String(g.id)) + '" title="Edit group">&#9998;</button>' +
        '<button class="group-delete-btn" data-group-id="' + esc(String(g.id)) + '" title="Delete group">&#128465;</button>' +
      '</div>' +
      '<div class="group-lane-body" data-group-id="' + esc(String(g.id)) + '">' +
        members.map((m) =>
          '<div class="contact-chip" draggable="true" data-contact-id="' + esc(String(m.id)) + '" data-source-group="' + esc(String(g.id)) + '">' +
            esc(m.name) +
          '</div>'
        ).join("") +
      '</div>' +
    '</div>';
  });

  // Ungrouped lane
  html += '<div class="group-lane ungrouped-lane">' +
    '<div class="group-lane-header">' +
      '<span class="group-color-dot" style="background:#666"></span>' +
      '<span class="group-lane-title">Ungrouped</span>' +
      '<span class="group-lane-count">(' + ungrouped.length + ')</span>' +
    '</div>' +
    '<div class="group-lane-body" data-group-id="ungrouped">' +
      ungrouped.map((c) =>
        '<div class="contact-chip" draggable="true" data-contact-id="' + esc(String(c.id)) + '" data-source-group="ungrouped">' +
          esc(contactDisplayName(c)) +
        '</div>'
      ).join("") +
    '</div>' +
  '</div>';

  container.innerHTML = html;

  container.querySelectorAll(".group-edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const groupId = btn.dataset.groupId;
      const group = groupsList.find((g) => String(g.id) === groupId);
      if (group) createGroupModal(group);
    });
  });

  container.querySelectorAll(".group-delete-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteGroup(btn.dataset.groupId);
    });
  });

  setupDragAndDrop();
}

function setupDragAndDrop() {
  const chips = document.querySelectorAll(".contact-chip[draggable]");
  const lanes = document.querySelectorAll(".group-lane-body");

  chips.forEach((chip) => {
    chip.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", JSON.stringify({
        contactId: chip.dataset.contactId,
        sourceGroup: chip.dataset.sourceGroup,
      }));
      chip.classList.add("dragging");
    });
    chip.addEventListener("dragend", () => {
      chip.classList.remove("dragging");
    });
  });

  lanes.forEach((lane) => {
    lane.addEventListener("dragover", (e) => {
      e.preventDefault();
      lane.classList.add("drag-over");
    });
    lane.addEventListener("dragleave", () => {
      lane.classList.remove("drag-over");
    });
    lane.addEventListener("drop", async (e) => {
      e.preventDefault();
      lane.classList.remove("drag-over");
      try {
        const payload = JSON.parse(e.dataTransfer.getData("text/plain"));
        const targetGroupId = lane.dataset.groupId;
        const sourceGroupId = payload.sourceGroup;
        const contactId = payload.contactId;

        if (targetGroupId === sourceGroupId) return;

        // Remove from old group (if it was in one)
        if (sourceGroupId && sourceGroupId !== "ungrouped") {
          await adminFetch("/api/friends/groups/" + encodeURIComponent(sourceGroupId) + "/members/" + encodeURIComponent(contactId), {
            method: "DELETE",
          });
        }

        // Add to new group (if not ungrouped)
        if (targetGroupId && targetGroupId !== "ungrouped") {
          await adminFetch("/api/friends/groups/" + encodeURIComponent(targetGroupId) + "/members", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contactIds: [contactId] }),
          });
        }

        // Reload groups
        loadGroups();
      } catch (err) {
        console.error("Drop failed:", err);
      }
    });
  });
}

function createGroupModal(existingGroup) {
  // Remove any existing modal
  const oldModal = $("group-modal");
  if (oldModal) oldModal.remove();

  const isEdit = !!existingGroup;
  const modal = document.createElement("div");
  modal.id = "group-modal";
  modal.className = "modal-overlay";
  modal.innerHTML =
    '<div class="modal-content">' +
      '<h3>' + (isEdit ? "Edit Group" : "New Group") + '</h3>' +
      '<label>Name</label>' +
      '<input type="text" id="group-name-input" value="' + esc(isEdit ? existingGroup.name : "") + '" placeholder="Group name" />' +
      '<label>Color</label>' +
      '<input type="color" id="group-color-input" value="' + (isEdit && existingGroup.color ? esc(existingGroup.color) : "#4fc3f7") + '" />' +
      (isEdit ? '<label>Sort Order</label><input type="number" id="group-sort-input" value="' + (existingGroup.sort_order ?? 0) + '" />' : '') +
      '<div class="modal-buttons">' +
        '<button id="group-modal-cancel" class="btn btn-secondary">Cancel</button>' +
        '<button id="group-modal-save" class="btn btn-primary">' + (isEdit ? "Update" : "Create") + '</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);

  $("group-modal-cancel").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

  $("group-modal-save").addEventListener("click", async () => {
    const name = $("group-name-input").value.trim();
    const color = $("group-color-input").value;
    if (!name) { alert("Name is required"); return; }

    try {
      if (isEdit) {
        const sortInput = $("group-sort-input");
        const body = { name, color };
        if (sortInput) body.sort_order = parseInt(sortInput.value) || 0;
        const res = await adminFetch("/api/friends/groups/" + encodeURIComponent(existingGroup.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error("Failed to update group");
      } else {
        const res = await adminFetch("/api/friends/groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, color }),
        });
        if (!res.ok) throw new Error("Failed to create group");
      }
      modal.remove();
      loadGroups();
    } catch (err) {
      alert(err.message);
    }
  });
}

async function deleteGroup(id) {
  if (!confirm("Delete this group? Members will be moved to Ungrouped.")) return;
  try {
    const res = await adminFetch("/api/friends/groups/" + encodeURIComponent(id), { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to delete group");
    loadGroups();
  } catch (err) {
    alert("Delete failed: " + err.message);
  }
}

// ── Tiers Tab ──

let editingTierId = null;

async function loadTiers() {
  try {
    const [tiersRes, contactsRes] = await Promise.all([
      adminFetch("/api/friends/tiers"),
      adminFetch("/api/friends/contacts?sort=name&dir=asc"),
    ]);
    if (!tiersRes.ok) throw new Error("Failed to load tiers");
    if (!contactsRes.ok) throw new Error("Failed to load contacts");
    const tiers = await tiersRes.json();
    const allContacts = await contactsRes.json();
    renderTierLanes(tiers, allContacts);
  } catch (err) {
    console.error("Failed to load tiers:", err);
  }
}

// Tier pagination & search state
var tierPages = {};
var tierSearch = "";
var tierAllContacts = [];
var tierCurrentList = [];
var TIER_PAGE_SIZE = 50;
var tierSortMode = "default";
var chipDragOccurred = false;

function renderContactChip(c, sourceTier) {
  return '<div class="contact-chip" draggable="true" data-contact-id="' + esc(String(c.id)) + '" data-source-tier="' + esc(String(sourceTier)) + '">' +
    '<div class="chip-name">' + esc(contactDisplayName(c)) + '</div>' +
    '<div class="chip-meta">' + (c.messages_30d || 0) + ' msgs / 30d</div>' +
  '</div>';
}

function renderPagination(tierId, page, totalItems) {
  var totalPages = Math.ceil(totalItems / TIER_PAGE_SIZE);
  if (totalPages <= 1) return '';
  return '<div class="tier-pagination">' +
    '<button data-tier-page="' + esc(String(tierId)) + '" data-dir="prev"' + (page <= 0 ? ' disabled' : '') + '>&laquo; Prev</button>' +
    '<span>' + (page + 1) + ' / ' + totalPages + '</span>' +
    '<button data-tier-page="' + esc(String(tierId)) + '" data-dir="next"' + (page >= totalPages - 1 ? ' disabled' : '') + '>Next &raquo;</button>' +
  '</div>';
}

function renderTierLanes(tiersList, allContacts) {
  var container = $("tier-lanes");
  if (!container) return;

  // Store for later use by search/pagination
  tierAllContacts = allContacts;
  tierCurrentList = tiersList;

  var byTier = {};
  var unassigned = [];
  allContacts.forEach(function(c) {
    if (c.tier_id) {
      if (!byTier[c.tier_id]) byTier[c.tier_id] = [];
      byTier[c.tier_id].push(c);
    } else {
      unassigned.push(c);
    }
  });

  // Render unassigned section (horizontal, above tiers)
  var unassignedChips = $("tier-unassigned-chips");
  var unassignedCount = $("tier-unassigned-count");
  if (unassignedChips) {
    unassignedChips.innerHTML = unassigned.length === 0
      ? '<span style="color:var(--text-dim);font-size:11px;padding:4px;">No unassigned contacts</span>'
      : unassigned.map(function(c) { return renderContactChip(c, "unassigned"); }).join("");
  }
  if (unassignedCount) unassignedCount.textContent = unassigned.length;

  // Render search results if searching
  var searchSection = $("tier-search-results");
  var searchChips = $("tier-search-chips");
  if (searchSection && searchChips) {
    if (tierSearch.trim()) {
      var query = tierSearch.toLowerCase();
      var matches = allContacts.filter(function(c) {
        return c.name && c.name.toLowerCase().indexOf(query) !== -1;
      });
      searchSection.style.display = "block";
      searchChips.innerHTML = matches.length === 0
        ? '<span style="color:var(--text-dim);font-size:11px;padding:4px;">No matches</span>'
        : matches.map(function(c) {
            return renderContactChip(c, c.tier_id ? String(c.tier_id) : "unassigned");
          }).join("");
    } else {
      searchSection.style.display = "none";
      searchChips.innerHTML = "";
    }
  }

  // Sort tiers before rendering
  var sortedTiers = tiersList.slice();
  if (tierSortMode === "name-asc") {
    sortedTiers.sort(function(a, b) { return (a.name || "").localeCompare(b.name || ""); });
  } else if (tierSortMode === "name-desc") {
    sortedTiers.sort(function(a, b) { return (b.name || "").localeCompare(a.name || ""); });
  } else if (tierSortMode === "count-desc") {
    sortedTiers.sort(function(a, b) { return (byTier[b.id] || []).length - (byTier[a.id] || []).length; });
  } else if (tierSortMode === "count-asc") {
    sortedTiers.sort(function(a, b) { return (byTier[a.id] || []).length - (byTier[b.id] || []).length; });
  }

  // Render tier columns with pagination
  var html = '';
  sortedTiers.forEach(function(t) {
    var members = byTier[t.id] || [];
    var page = tierPages[t.id] || 0;
    var totalPages = Math.ceil(members.length / TIER_PAGE_SIZE);
    if (page >= totalPages && totalPages > 0) { page = totalPages - 1; tierPages[t.id] = page; }
    var pageMembers = members.slice(page * TIER_PAGE_SIZE, (page + 1) * TIER_PAGE_SIZE);

    html += '<div class="group-lane" draggable="true" data-tier-id="' + esc(String(t.id)) + '">' +
      '<div class="group-lane-header">' +
        '<button class="lane-btn tier-collapse-btn" data-action="toggle-tier" title="Collapse/Expand">&#9660;</button>' +
        '<span class="color-dot" style="background:' + esc(t.color || '#4fc3f7') + '"></span>' +
        '<span class="lane-title">' + esc(t.name) + '</span>' +
        '<span class="lane-count">' + members.length + '</span>' +
        '<button class="lane-btn" data-action="edit-tier" data-tier-id="' + esc(String(t.id)) + '" title="Edit">&#9998;</button>' +
        '<button class="lane-btn delete" data-action="delete-tier" data-tier-id="' + esc(String(t.id)) + '" title="Delete">&#128465;</button>' +
      '</div>' +
      '<div class="group-lane-body tier-drop-zone" data-tier-id="' + esc(String(t.id)) + '">' +
        pageMembers.map(function(c) { return renderContactChip(c, String(t.id)); }).join("") +
      '</div>' +
      renderPagination(t.id, page, members.length) +
    '</div>';
  });

  container.innerHTML = html;

  // Wire up edit/delete buttons
  container.querySelectorAll('[data-action="edit-tier"]').forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      var tid = parseInt(btn.dataset.tierId);
      var tier = tiersList.find(function(t) { return t.id === tid; });
      if (tier) openTierModal(tier);
    });
  });

  container.querySelectorAll('[data-action="delete-tier"]').forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      deleteTier(btn.dataset.tierId);
    });
  });

  // Wire up pagination buttons
  container.querySelectorAll('[data-tier-page]').forEach(function(btn) {
    btn.addEventListener("click", function() {
      var tierId = btn.dataset.tierPage;
      var dir = btn.dataset.dir;
      if (!tierPages[tierId]) tierPages[tierId] = 0;
      if (dir === "prev") tierPages[tierId]--;
      else tierPages[tierId]++;
      renderTierLanes(tierCurrentList, tierAllContacts);
    });
  });

  // Wire up collapse toggle buttons
  container.querySelectorAll('[data-action="toggle-tier"]').forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      var lane = btn.closest(".group-lane");
      if (lane) {
        lane.classList.toggle("collapsed");
        btn.innerHTML = lane.classList.contains("collapsed") ? "&#9654;" : "&#9660;";
      }
    });
  });

  setupTierDragAndDrop();
  setupBoardDragAndDrop(container);
}

function setupBoardDragAndDrop(container) {
  var boards = container.querySelectorAll(".group-lane[draggable]");
  var draggedBoard = null;

  boards.forEach(function(board) {
    // Drag starts from header only — prevent from body/buttons
    board.addEventListener("dragstart", function(e) {
      // Only allow drag if it started from the header area (not contact chips or buttons)
      var target = e.target;
      if (target.classList.contains("contact-chip") || target.closest(".contact-chip")) {
        return; // Let chip drag handle it
      }
      draggedBoard = board;
      board.classList.add("board-dragging");
      e.dataTransfer.setData("text/board", board.dataset.tierId);
      e.dataTransfer.effectAllowed = "move";
    });

    board.addEventListener("dragend", function() {
      board.classList.remove("board-dragging");
      draggedBoard = null;
      container.querySelectorAll(".board-drag-over").forEach(function(el) {
        el.classList.remove("board-drag-over");
      });
    });

    board.addEventListener("dragover", function(e) {
      if (!draggedBoard || draggedBoard === board) return;
      // Only highlight if this is a board drag (not a chip drag)
      if (!e.dataTransfer.types.includes("text/board")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      board.classList.add("board-drag-over");
    });

    board.addEventListener("dragleave", function() {
      board.classList.remove("board-drag-over");
    });

    board.addEventListener("drop", async function(e) {
      board.classList.remove("board-drag-over");
      if (!draggedBoard || draggedBoard === board) return;
      if (!e.dataTransfer.types.includes("text/board")) return;
      e.preventDefault();
      e.stopPropagation();

      // Reorder: move draggedBoard before or after this board in DOM
      var allLanes = Array.from(container.querySelectorAll(".group-lane[draggable]"));
      var fromIdx = allLanes.indexOf(draggedBoard);
      var toIdx = allLanes.indexOf(board);
      if (fromIdx < 0 || toIdx < 0) return;

      // Move in DOM
      if (fromIdx < toIdx) {
        container.insertBefore(draggedBoard, board.nextSibling);
      } else {
        container.insertBefore(draggedBoard, board);
      }

      // Save new order to backend
      var reorderedLanes = Array.from(container.querySelectorAll(".group-lane[draggable]"));
      var order = reorderedLanes.map(function(lane, i) {
        return { id: parseInt(lane.dataset.tierId), sort_order: i };
      });

      try {
        await adminFetch("/api/friends/tiers/reorder", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: order }),
        });
      } catch (err) {
        console.error("Tier reorder failed:", err);
      }
    });
  });
}

function setupTierDragAndDrop() {
  // Select chips from ALL tier-related sections (lanes, unassigned, search results)
  var tabTiers = document.getElementById("tab-tiers");
  if (!tabTiers) return;
  var chips = tabTiers.querySelectorAll(".contact-chip[draggable]");
  var zones = tabTiers.querySelectorAll(".tier-drop-zone");

  chips.forEach(function(chip) {
    var startX = 0, startY = 0, didDrag = false;
    chip.addEventListener("mousedown", function(e) {
      startX = e.clientX;
      startY = e.clientY;
      didDrag = false;
    });
    chip.addEventListener("dragstart", function(e) {
      didDrag = true;
      e.dataTransfer.setData("text/plain", JSON.stringify({
        contactId: chip.dataset.contactId,
        sourceTier: chip.dataset.sourceTier,
      }));
      chip.classList.add("dragging");
    });
    chip.addEventListener("dragend", function() {
      chip.classList.remove("dragging");
    });
    chip.addEventListener("click", function(e) {
      // Only open detail if no real drag occurred (< 5px movement)
      var dx = Math.abs(e.clientX - startX);
      var dy = Math.abs(e.clientY - startY);
      if (didDrag || dx > 5 || dy > 5) {
        didDrag = false;
        return;
      }
      e.stopPropagation();
      var contactId = chip.dataset.contactId;
      if (contactId) openContactDetail(contactId);
    });
  });

  zones.forEach(function(zone) {
    zone.addEventListener("dragover", function(e) {
      e.preventDefault();
      // Highlight the drop target (could be .group-lane or .tier-unassigned-section)
      var highlight = zone.closest(".group-lane") || zone.closest(".tier-unassigned-section");
      if (highlight) highlight.classList.add("drag-over");
    });
    zone.addEventListener("dragleave", function() {
      var highlight = zone.closest(".group-lane") || zone.closest(".tier-unassigned-section");
      if (highlight) highlight.classList.remove("drag-over");
    });
    zone.addEventListener("drop", async function(e) {
      e.preventDefault();
      var highlight = zone.closest(".group-lane") || zone.closest(".tier-unassigned-section");
      if (highlight) highlight.classList.remove("drag-over");
      try {
        var payload = JSON.parse(e.dataTransfer.getData("text/plain"));
        var targetTier = zone.dataset.tierId;
        if (targetTier === payload.sourceTier) return;
        var tierId = targetTier === "unassigned" ? null : parseInt(targetTier);
        await adminFetch("/api/friends/contacts/" + encodeURIComponent(payload.contactId) + "/tier", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier_id: tierId }),
        });
        loadTiers();
      } catch (err) {
        console.error("Tier drop failed:", err);
      }
    });
  });
}

function setupTierHandlers() {
  var createBtn = $("create-tier-btn");
  if (createBtn) createBtn.addEventListener("click", function() { openTierModal(); });

  var saveBtn = $("tier-modal-save");
  if (saveBtn) saveBtn.addEventListener("click", saveTier);

  var cancelBtn = $("tier-modal-cancel");
  if (cancelBtn) cancelBtn.addEventListener("click", closeTierModal);

  var modal = $("tier-modal");
  if (modal) modal.addEventListener("click", function(e) { if (e.target === modal) closeTierModal(); });

  // Tier search with debounce
  var searchInput = $("tier-search-input");
  var searchTimeout = null;
  if (searchInput) {
    searchInput.addEventListener("input", function() {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(function() {
        tierSearch = searchInput.value;
        if (tierCurrentList.length > 0 || tierAllContacts.length > 0) {
          renderTierLanes(tierCurrentList, tierAllContacts);
        }
      }, 250);
    });
  }

  // Tier sort dropdown
  var sortSelect = $("tier-sort-select");
  if (sortSelect) {
    sortSelect.addEventListener("change", function() {
      tierSortMode = sortSelect.value;
      if (tierCurrentList.length > 0 || tierAllContacts.length > 0) {
        renderTierLanes(tierCurrentList, tierAllContacts);
      }
    });
  }
}

function openTierModal(existingTier) {
  const modal = $("tier-modal");
  if (!modal) return;

  editingTierId = existingTier ? existingTier.id : null;
  const title = modal.querySelector(".modal-title");
  if (title) title.textContent = existingTier ? "Edit Tier" : "New Tier";

  const nameInput = $("tier-modal-name");
  const colorInput = $("tier-modal-color");
  if (nameInput) nameInput.value = existingTier ? existingTier.name : "";
  if (colorInput) colorInput.value = existingTier ? (existingTier.color || "#4fc3f7") : "#4fc3f7";

  modal.classList.add("open");
}

function closeTierModal() {
  const modal = $("tier-modal");
  if (modal) modal.classList.remove("open");
  editingTierId = null;
}

async function saveTier() {
  const name = $("tier-modal-name")?.value?.trim();
  const color = $("tier-modal-color")?.value || "#4fc3f7";
  if (!name) { alert("Tier name is required"); return; }

  try {
    if (editingTierId) {
      const res = await adminFetch("/api/friends/tiers/" + encodeURIComponent(editingTierId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color }),
      });
      if (!res.ok) throw new Error("Failed to update tier");
    } else {
      const res = await adminFetch("/api/friends/tiers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color }),
      });
      if (!res.ok) throw new Error("Failed to create tier");
    }
    closeTierModal();
    loadTiers();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteTier(id) {
  if (!confirm("Delete this tier? Contacts will become unassigned.")) return;
  try {
    const res = await adminFetch("/api/friends/tiers/" + encodeURIComponent(id), { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to delete tier");
    loadTiers();
  } catch (err) {
    alert("Delete failed: " + err.message);
  }
}

// ── Calendar Tab ──

function setupCalendarHandlers() {
  const prevBtn = $("cal-prev");
  if (prevBtn) prevBtn.addEventListener("click", () => {
    calMonth--;
    if (calMonth < 1) { calMonth = 12; calYear--; }
    loadCalendar();
  });

  const nextBtn = $("cal-next");
  if (nextBtn) nextBtn.addEventListener("click", () => {
    calMonth++;
    if (calMonth > 12) { calMonth = 1; calYear++; }
    loadCalendar();
  });
}

async function loadCalendar() {
  const titleEl = $("cal-month-title");
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  if (titleEl) titleEl.textContent = monthNames[calMonth - 1] + " " + calYear;

  try {
    const calTierParam = dashboardTierFilter !== null ? "&tier=" + encodeURIComponent(dashboardTierFilter) : "";
    const res = await adminFetch("/api/friends/calendar?year=" + calYear + "&month=" + calMonth + calTierParam);
    if (!res.ok) throw new Error("Failed to load calendar");
    const data = await res.json();
    renderCalendar(data.year, data.month, data.days);
  } catch (err) {
    console.error("Failed to load calendar:", err);
    const grid = $("calendar-days");
    if (grid) grid.innerHTML = '<div class="chart-empty" style="grid-column:1/-1;">Failed to load calendar data.</div>';
  }
}

function renderCalendar(year, month, days) {
  const container = $("calendar-days");
  if (!container) return;

  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const daysInPrev = new Date(year, month - 1, 0).getDate();
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
  const todayDate = today.getDate();

  const dayMap = {};
  if (days) {
    days.forEach(d => { dayMap[d.day] = d.contacts || []; });
  }

  container.innerHTML = "";

  // Previous month padding (greyed out)
  for (let i = firstDay - 1; i >= 0; i--) {
    container.appendChild(createCalDay(daysInPrev - i, [], false, true));
  }

  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = isCurrentMonth && d === todayDate;
    container.appendChild(createCalDay(d, dayMap[d] || [], isToday, false));
  }

  // Next month padding to complete the grid
  const totalCells = container.children.length;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let d = 1; d <= remaining; d++) {
    container.appendChild(createCalDay(d, [], false, true));
  }
}

function createCalDay(dayNum, contacts, isToday, otherMonth) {
  const el = document.createElement("div");
  el.className = "cal-day" + (isToday ? " today" : "") + (otherMonth ? " other-month" : "");

  const num = document.createElement("div");
  num.className = "day-number";
  num.textContent = dayNum;
  el.appendChild(num);

  if (contacts.length > 0 && !otherMonth) {
    const list = document.createElement("div");
    list.className = "day-contacts";

    const maxVisible = 5;
    contacts.slice(0, maxVisible).forEach(c => {
      const item = document.createElement("div");
      item.className = "day-contact-item";
      item.style.borderLeftColor = c.tier_color || "#666";
      item.textContent = (c.name || "Unknown") + " " + (c.count || 0);
      item.title = (c.name || "Unknown") + " — " + (c.count || 0) + " messages";
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        if (c.id) openContactDetail(c.id);
      });
      list.appendChild(item);
    });

    if (contacts.length > maxVisible) {
      const more = document.createElement("div");
      more.className = "day-contact-more";
      more.textContent = "+" + (contacts.length - maxVisible) + " more";
      list.appendChild(more);
    }

    el.appendChild(list);
  }

  return el;
}

// ── Messaging Tab ──

function setupMessagingHandlers() {
  const sendBtn = $("send-btn");
  if (sendBtn) sendBtn.addEventListener("click", sendMessages);

  // Media upload area
  const mediaArea = $("media-upload");
  const fileInput = $("media-file-input");
  if (mediaArea && fileInput) {
    mediaArea.addEventListener("click", () => fileInput.click());
    mediaArea.addEventListener("dragover", (e) => {
      e.preventDefault();
      mediaArea.classList.add("drag-over");
    });
    mediaArea.addEventListener("dragleave", () => {
      mediaArea.classList.remove("drag-over");
    });
    mediaArea.addEventListener("drop", (e) => {
      e.preventDefault();
      mediaArea.classList.remove("drag-over");
      if (e.dataTransfer.files.length > 0) {
        handleMediaFile(e.dataTransfer.files[0]);
      }
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files.length > 0) {
        handleMediaFile(fileInput.files[0]);
      }
    });
  }
}

let mediaBase64 = null;
let mediaMimetype = null;
let mediaFilename = null;

async function handleMediaFile(file) {
  try {
    mediaBase64 = await fileToBase64(file);
    mediaMimetype = file.type;
    mediaFilename = file.name;

    const preview = $("media-preview");
    if (preview) {
      if (file.type.startsWith("image/")) {
        preview.innerHTML = '<img src="data:' + esc(file.type) + ';base64,' + mediaBase64 + '" class="media-preview-img" />' +
          '<button id="media-remove" class="btn btn-secondary btn-small">Remove</button>';
      } else {
        preview.innerHTML = '<div class="media-preview-file">' + esc(file.name) + '</div>' +
          '<button id="media-remove" class="btn btn-secondary btn-small">Remove</button>';
      }
      preview.classList.remove("hidden");
      const removeBtn = $("media-remove");
      if (removeBtn) removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        clearMedia();
      });
    }
  } catch (err) {
    console.error("Failed to read file:", err);
  }
}

function clearMedia() {
  mediaBase64 = null;
  mediaMimetype = null;
  mediaFilename = null;
  const preview = $("media-preview");
  if (preview) { preview.innerHTML = ""; preview.classList.add("hidden"); }
  const fileInput = $("media-file-input");
  if (fileInput) fileInput.value = "";
}

async function loadMessagingRecipients() {
  try {
    const [groupsRes, contactsRes] = await Promise.all([
      adminFetch("/api/friends/groups"),
      adminFetch("/api/friends/contacts?sort=name&dir=asc"),
    ]);
    if (groupsRes.ok) groups = await groupsRes.json();
    if (contactsRes.ok) contacts = await contactsRes.json();

    renderGroupButtons();
    renderContactPills();
    updateRecipientCount();
  } catch (err) {
    console.error("Failed to load messaging recipients:", err);
  }
}

function renderGroupButtons() {
  const container = $("msg-group-buttons");
  if (!container) return;
  container.innerHTML = groups.map((g) =>
    '<button class="msg-group-btn" data-group-id="' + esc(String(g.id)) + '">' +
      '<span class="group-color-dot" style="background:' + esc(g.color || "#555") + '"></span>' +
      esc(g.name) + ' (' + (g.memberCount || (g.members ? g.members.length : 0)) + ')' +
    '</button>'
  ).join("");

  container.querySelectorAll(".msg-group-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const groupId = btn.dataset.groupId;
      const group = groups.find((g) => String(g.id) === groupId);
      if (!group || !group.members) return;
      const memberIds = group.members.map((m) => String(m.id));

      // Check if all members are already selected
      const allSelected = memberIds.every((id) => selectedRecipients.has(id));
      if (allSelected) {
        memberIds.forEach((id) => selectedRecipients.delete(id));
        btn.classList.remove("selected");
      } else {
        memberIds.forEach((id) => selectedRecipients.add(id));
        btn.classList.add("selected");
      }

      // Update contact pills to reflect selection
      document.querySelectorAll(".contact-pill").forEach((pill) => {
        pill.classList.toggle("selected", selectedRecipients.has(pill.dataset.contactId));
      });
      updateRecipientCount();
    });
  });
}

function renderContactPills() {
  const container = $("msg-contact-pills");
  if (!container) return;
  container.innerHTML = contacts.map((c) => {
    const isSelected = selectedRecipients.has(String(c.id));
    return '<span class="contact-pill' + (isSelected ? " selected" : "") + '" data-contact-id="' + esc(String(c.id)) + '">' +
      esc(contactDisplayName(c)) +
    '</span>';
  }).join("");

  container.querySelectorAll(".contact-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      const contactId = pill.dataset.contactId;
      if (selectedRecipients.has(contactId)) {
        selectedRecipients.delete(contactId);
        pill.classList.remove("selected");
      } else {
        selectedRecipients.add(contactId);
        pill.classList.add("selected");
      }
      updateRecipientCount();
    });
  });
}

function updateRecipientCount() {
  const el = $("recipient-count");
  if (el) el.textContent = selectedRecipients.size + " recipient" + (selectedRecipients.size !== 1 ? "s" : "") + " selected";
}

async function sendMessages() {
  const message = $("msg-text")?.value?.trim();
  if (!message && !mediaBase64) {
    alert("Please enter a message or attach media.");
    return;
  }
  if (selectedRecipients.size === 0) {
    alert("Please select at least one recipient.");
    return;
  }

  const sendBtn = $("send-btn");
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = "Sending..."; }

  // Determine which group IDs have all members selected (to send as group messages)
  const groupIds = [];
  const contactIds = Array.from(selectedRecipients);

  const body = {
    contactIds,
    groupIds,
    message: message || "",
  };

  if (mediaBase64) {
    body.mediaBase64 = mediaBase64;
    body.mediaMimetype = mediaMimetype;
    body.mediaFilename = mediaFilename;
  }

  try {
    const res = await adminFetch("/api/friends/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Send failed");
    }
    // Start polling for progress
    startSendProgressPoll();
  } catch (err) {
    alert("Send failed: " + err.message);
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = "Send"; }
  }
}

function startSendProgressPoll() {
  const progressBar = $("send-progress");
  const progressFill = $("send-progress-fill");
  const progressLabel = $("send-progress-label");
  if (progressBar) progressBar.classList.remove("hidden");

  if (sendPollTimer) clearInterval(sendPollTimer);
  sendPollTimer = setInterval(async () => {
    try {
      const res = await adminFetch("/api/friends/send-status");
      if (!res.ok) return;
      const status = await res.json();

      const total = status.total || 1;
      const sent = status.sent || 0;
      const failed = status.failed || 0;
      const pct = Math.round(((sent + failed) / total) * 100);

      if (progressFill) progressFill.style.width = pct + "%";
      if (progressLabel) {
        progressLabel.textContent = status.phase === "done" || status.phase === "idle"
          ? "Done! Sent " + sent + " of " + total + (failed > 0 ? " (" + failed + " failed)" : "")
          : "Sending... " + sent + "/" + total;
      }

      if (status.phase === "done" || status.phase === "idle") {
        clearInterval(sendPollTimer);
        sendPollTimer = null;
        const sendBtn = $("send-btn");
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = "Send"; }
        // Hide progress after a delay
        setTimeout(() => {
          if (progressBar) progressBar.classList.add("hidden");
          if (progressFill) progressFill.style.width = "0%";
        }, 5000);
        // Clear message and media after send
        const msgText = $("msg-text");
        if (msgText) msgText.value = "";
        clearMedia();
      }
    } catch (err) {
      console.error("Send poll error:", err);
    }
  }, 2000);
}

// ── Manage Chats Tab ──

async function loadChats() {
  try {
    const res = await adminFetch("/api/friends/chats");
    if (!res.ok) throw new Error("Server returned " + res.status);
    chats = await res.json();
    renderChatsList(chats);
  } catch (err) {
    console.error("Failed to load chats:", err);
  }
}

function renderChatsList(chatsList) {
  const container = $("chats-list");
  if (!container) return;
  if (!chatsList || chatsList.length === 0) {
    container.innerHTML = '<div class="empty-state">No chats found. Click "Scan Chats" to discover WhatsApp chats.</div>';
    return;
  }
  container.innerHTML = chatsList.map((chat) => {
    const label = chat.is_group
      ? esc(chat.chat_name) + ' <span class="chat-meta">(' + (chat.participant_count || 0) + ' members)</span>'
      : esc(chat.chat_name) + ' <span class="chat-meta">(DM)</span>';
    return '<li>' +
      '<label>' +
        '<input type="checkbox" class="chat-monitor-toggle" data-chat-id="' + esc(chat.chat_id) + '"' + (chat.monitored ? " checked" : "") + ' />' +
        '<span>' + label + '</span>' +
      '</label>' +
    '</li>';
  }).join("");

  container.querySelectorAll(".chat-monitor-toggle").forEach((toggle) => {
    toggle.addEventListener("change", () => {
      toggleMonitor(toggle.dataset.chatId, toggle.checked);
    });
  });
}

async function toggleMonitor(chatId, enabled) {
  try {
    const res = await adminFetch("/api/friends/chats/" + encodeURIComponent(chatId) + "/monitor", {
      method: enabled ? "POST" : "DELETE",
    });
    if (!res.ok) throw new Error("Failed to update monitoring");
  } catch (err) {
    alert("Failed to toggle monitor: " + err.message);
    // Reload to reset state
    loadChats();
  }
}

// ── Calls Tab ──

let _callsTabRecorder = null;
let _callsTabOffset = 0;
const _CALLS_TAB_PAGE = 20;

function setupCallsTab() {
  const btn = $("calls-tab-record");
  if (!btn) return;

  _callsTabRecorder = new CallRecorder({
    onStateChange: (state) => {
      if (state === "recording") {
        btn.textContent = "Stop";
        btn.style.background = "var(--red)";
      } else {
        btn.textContent = "Record";
        btn.style.background = "var(--accent)";
        $("calls-tab-timer").textContent = "00:00";
        $("calls-tab-level").style.width = "0%";
      }
    },
    onTimer: (formatted) => { $("calls-tab-timer").textContent = formatted; },
    onLevel: (level) => { $("calls-tab-level").style.width = (level * 100) + "%"; },
  });

  btn.addEventListener("click", async () => {
    if (_callsTabRecorder.state === "recording") {
      btn.disabled = true;
      btn.textContent = "Processing...";
      const blob = await _callsTabRecorder.stop();
      if (blob) {
        await _callsTabTranscribe(blob);
      }
      btn.disabled = false;
    } else {
      const source = $("calls-tab-source")?.value || "mic";
      try {
        await _callsTabRecorder.start(source);
      } catch (err) {
        alert("Failed to start: " + err.message);
      }
    }
  });

  const moreBtn = $("calls-tab-more");
  if (moreBtn) moreBtn.addEventListener("click", () => _loadCallsTabList(true));
}

async function _callsTabTranscribe(blob) {
  const btn = $("calls-tab-record");
  btn.textContent = "Transcribing...";
  btn.disabled = true;

  try {
    const formData = new FormData();
    formData.append("audio", blob, "call." + (blob.type.includes("webm") ? "webm" : "mp4"));
    const res = await adminFetch("/api/calls/transcribe", { method: "POST", body: formData });
    if (!res.ok) throw new Error("Transcription failed");
    const data = await res.json();

    const callId = "call_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
    const callType = $("calls-tab-type")?.value || "phone";

    // Save immediately
    await adminFetch("/api/calls/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: callId,
        call_type: callType,
        duration_seconds: _callsTabRecorder.durationSeconds || Math.round(data.duration || 0),
        transcript_text: data.text || "",
        utterances_json: JSON.stringify(data.utterances || []),
        assemblyai_id: data.assemblyai_id || "",
        audio_captured: _callsTabRecorder.audioSource,
        status: "done",
        recorded_at: Math.floor(Date.now() / 1000),
      }),
    });

    _callsTabRecorder.reset();
    _loadCallsTabList();
  } catch (err) {
    alert("Transcription error: " + err.message);
    _callsTabRecorder.reset();
  } finally {
    btn.disabled = false;
  }
}

async function loadCallsTab() {
  _callsTabOffset = 0;
  _loadCallsTabList();
}

async function _loadCallsTabList(more = false) {
  if (!more) _callsTabOffset = 0;
  try {
    const res = await cachedFetch(`/api/calls?limit=${_CALLS_TAB_PAGE}&offset=${_callsTabOffset}`);
    if (!res.ok) return;
    const data = await res.json();
    const calls = data.calls || [];

    const list = $("calls-tab-list");
    if (!list) return;
    if (!more) list.innerHTML = "";

    if (calls.length === 0 && !more) {
      list.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:12px;">No recordings yet</div>';
      $("calls-tab-more").style.display = "none";
      return;
    }

    for (const call of calls) {
      const div = document.createElement("div");
      div.style.cssText = "background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:6px;cursor:pointer;";
      div.addEventListener("mouseenter", () => div.style.borderColor = "var(--accent)");
      div.addEventListener("mouseleave", () => div.style.borderColor = "var(--border)");

      const date = new Date(call.recorded_at * 1000);
      const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const mins = Math.floor(call.duration_seconds / 60);
      const secs = call.duration_seconds % 60;
      const durStr = `${mins}:${String(secs).padStart(2, "0")}`;
      const title = call.title || (call.call_type ? call.call_type.charAt(0).toUpperCase() + call.call_type.slice(1) + " call" : "Call");
      const preview = (call.transcript_text || "").substring(0, 100);

      div.innerHTML = `<div style="display:flex;align-items:center;gap:8px;">
        <div style="flex:1;font-size:12px;font-weight:600;">${esc(title)}</div>
        <div style="font-size:10px;color:var(--text-dim);">${durStr} · ${dateStr}</div>
      </div>
      ${call.contact_name ? `<div style="font-size:10px;color:var(--accent);margin-top:2px;">${esc(call.contact_name)}</div>` : ""}
      ${preview ? `<div style="font-size:10px;color:var(--text-dim);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(preview)}</div>` : ""}`;

      div.addEventListener("click", () => window.open(`/calls.html`, "_blank"));
      list.appendChild(div);
    }

    _callsTabOffset += calls.length;
    const moreBtn = $("calls-tab-more");
    if (moreBtn) moreBtn.style.display = calls.length >= _CALLS_TAB_PAGE ? "" : "none";
  } catch (err) {
    console.error("Failed to load calls:", err);
  }
}

// ── Contact Explorer (D3 Scatter Plot) ──

const GX = {
  data: null, nodes: [], edges: [], tagEdges: [],
  svg: null, g: null, zoom: null,
  xScale: null, yScale: null,
  selected: null,
  showLabels: true, showGroupLines: false, showTagLines: false,
  tierFilter: "all",
  searchQ: "",
  xAxis: "lastContactDate", // locked to time axis
  yAxis: "messages",
  colorMode: "tier", sizeMode: "messages",
  zoomMode: "dynamic",
  logScale: false, // logarithmic Y axis
  currentTransform: d3.zoomIdentity,
  filtersOpen: false,
  filters: {},
  // Time window: controls the X-axis date range
  timeWindow: "3m", // "1m" | "3m" | "6m" | "1y"
  timeOffset: 0, // how many windows back from "now" (0 = most recent)
  yAxes: [
    { key: "messages", label: "Total Messages", short: "Total", type: "num" },
    { key: "msgsPerDay", label: "Avg Msgs/Day", short: "Msgs/Day", type: "num" },
    { key: "recentPerDay", label: "Recent Msgs/Day (30d)", short: "Recent/Day", type: "num" },
    { key: "wordsPerActiveDay", label: "Words/Active Day", short: "Words/Day", type: "num" },
    { key: "voiceNotes", label: "Voice Notes", short: "Voice", type: "num" },
    { key: "messages30d", label: "Recent (30d)", short: "30d", type: "num" },
    { key: "daysSince", label: "Days Since Contact", short: "Days", type: "num" },
    { key: "quality", label: "Quality Score", short: "Quality", type: "num" },
    { key: "ratio", label: "Sent/Recv Ratio", short: "Ratio", type: "num" },
    { key: "daysKnown", label: "Relationship Age", short: "Age", type: "num" },
    { key: "sent", label: "Sent", short: "Sent", type: "num" },
    { key: "received", label: "Received", short: "Recv", type: "num" },
    { key: "groupCount", label: "Groups", short: "Groups", type: "num" },
    { key: "tagCount", label: "Tags", short: "Tags", type: "num" },
  ],
  // X axis is always lastContactDate (kept for scale building)
  xDef: { key: "lastContactDate", label: "Last Contact", short: "Last Contact", type: "time" },
  colors: [
    { key: "tier", label: "Tier" },
    { key: "recency", label: "Recency" },
    { key: "activity", label: "Activity" }
  ],
  sizes: [
    { key: "messages", label: "Msgs" },
    { key: "quality", label: "Quality" },
    { key: "messages30d", label: "30d" },
    { key: "equal", label: "Equal" }
  ],
  minMessages: 50,
  tiers: []
};

// Prefetch graph data in background so tab switch is instant
let _graphPrefetchPromise = null;
function _prefetchGraphData() {
  if (!_graphPrefetchPromise) {
    _graphPrefetchPromise = cachedFetch("/api/friends/graph?minMessages=" + GX.minMessages)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) _applyGraphData(data);
        return data;
      })
      .catch(() => null);
  }
  return _graphPrefetchPromise;
}

function _applyGraphData(data) {
  for (const n of data.nodes) {
    n.lastContactDate = n.lastSeen ? new Date(n.lastSeen * 1000) : new Date(0);
    n.firstSeenDate = n.firstSeen ? new Date(n.firstSeen * 1000) : new Date(0);
  }
  GX.data = data;
  GX.tiers = data.tiers || [];
}

async function loadGraph() {
  const loading = $("gx-loading");

  // If data already loaded (from prefetch), render immediately
  if (GX.data) {
    if (loading) loading.style.display = "none";
    gxBuildToolbar();
    gxBuildFilters();
    gxRender(true); // fast = true: skip transitions on first paint
    return;
  }

  // If prefetch in flight, wait for it
  if (loading) loading.style.display = "flex";
  try {
    const data = await _prefetchGraphData();
    if (!data) {
      // Prefetch failed; try direct fetch
      const res = await adminFetch("/api/friends/graph?minMessages=" + GX.minMessages);
      if (!res.ok) throw new Error("Failed");
      _applyGraphData(await res.json());
    }
    if (loading) loading.style.display = "none";
    gxBuildToolbar();
    gxBuildFilters();
    gxRender(true);
  } catch (err) {
    console.error("Graph load error:", err);
    if (loading) loading.textContent = "Failed to load: " + err.message;
  }
}

// Compute time window start/end dates based on window size and offset
function gxTimeWindow() {
  const windowDays = { "1m": 30, "3m": 90, "6m": 180, "1y": 365 };
  const days = windowDays[GX.timeWindow] || 90;
  const now = new Date();
  const endMs = now.getTime() - GX.timeOffset * days * 86400000;
  const startMs = endMs - days * 86400000;
  return { start: new Date(startMs), end: new Date(endMs), days };
}

function gxTimeWindowLabel() {
  const { start, end } = gxTimeWindow();
  const fmt = d => d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  return `${fmt(start)} — ${fmt(end)}`;
}

function gxBuildToolbar() {
  // X axis is locked to "Last Contact" — show time window controls instead
  const xC = $("gx-x-pills");
  if (xC) {
    const wins = ["1m", "3m", "6m", "1y"];
    const labels = { "1m": "1 Mo", "3m": "3 Mo", "6m": "6 Mo", "1y": "1 Yr" };
    xC.innerHTML =
      `<button class="gx-pill gx-nav-btn" data-nav="left" data-tip="Scroll earlier ( [ )">&larr;</button>` +
      wins.map(w =>
        `<span class="gx-pill${w === GX.timeWindow ? ' active' : ''}" data-window="${w}" data-tip="Show last ${labels[w].toLowerCase()}">${labels[w]}</span>`
      ).join("") +
      `<button class="gx-pill gx-nav-btn" data-nav="right" data-tip="Scroll later ( ] )">&rarr;</button>` +
      `<span style="font-size:10px;color:var(--text-dim);margin-left:4px;" id="gx-window-label">${gxTimeWindowLabel()}</span>`;
  }

  // Y axis pills (only numeric axes now)
  const yC = $("gx-y-pills");
  if (yC) yC.innerHTML = GX.yAxes.map(a =>
    `<span class="gx-pill${a.key === GX.yAxis ? ' active' : ''}" data-axis="y" data-key="${a.key}" data-tip="${a.label}">${a.short}</span>`
  ).join("");
  const colorTips = { tier: "Color by tier assignment", recency: "Color by last contact date", activity: "Color by 30-day message count" };
  const cC = $("gx-color-pills");
  if (cC) cC.innerHTML = GX.colors.map(c =>
    `<span class="gx-pill${c.key === GX.colorMode ? ' active' : ''}" data-mode="color" data-key="${c.key}" data-tip="${colorTips[c.key] || c.label}">${c.label}</span>`
  ).join("");
  const sizeTips = { messages: "Size by total messages", quality: "Size by quality score", messages30d: "Size by last 30 days", equal: "All dots same size" };
  const sC = $("gx-size-pills");
  if (sC) sC.innerHTML = GX.sizes.map(s =>
    `<span class="gx-pill${s.key === GX.sizeMode ? ' active' : ''}" data-mode="size" data-key="${s.key}" data-tip="${sizeTips[s.key] || s.label}">${s.label}</span>`
  ).join("");
  const tC = $("gx-tier-pills");
  if (tC && GX.tiers.length > 0) {
    let html = `<span class="gx-tier-pill active" data-tier="all" style="background:#888;" data-tip="Show all tiers"></span>`;
    for (const t of GX.tiers) {
      html += `<span class="gx-tier-pill" data-tier="${t.id}" style="background:${t.color};" data-tip="Filter: ${esc(t.name)}"></span>`;
    }
    html += `<span class="gx-tier-pill" data-tier="none" style="background:#444;" data-tip="Filter: Unassigned"></span>`;
    tC.innerHTML = html;
  }
}

function gxGetColor(n) {
  if (GX.colorMode === "activity") {
    const m = Math.min(n.messages30d || 0, 80);
    return d3.interpolateViridis(m / 80);
  }
  if (GX.colorMode === "recency") {
    const d = n.daysSince || 0;
    if (d < 7) return "#4fc3f7";
    if (d < 30) return "#81c784";
    if (d < 90) return "#ffb74d";
    if (d < 365) return "#f06292";
    return "#636e72";
  }
  return n.tierColor || "#636e72";
}

function gxGetRadius(n) {
  const m = GX.sizeMode;
  if (m === "equal") return 5;
  if (m === "quality") return Math.max(3, Math.min(16, (n.quality || 0) / 7));
  if (m === "messages30d") return Math.max(3, Math.min(16, Math.sqrt(n.messages30d || 0) * 1.2));
  return Math.max(3, Math.min(16, Math.sqrt(n.messages || 0) / 2.5));
}

function gxFilteredNodes() {
  if (!GX.data) return [];
  let nodes = GX.data.nodes;

  // Filter by time window (X axis = lastContactDate)
  const tw = gxTimeWindow();
  nodes = nodes.filter(n => {
    const d = n.lastContactDate;
    return d && d >= tw.start && d <= tw.end;
  });

  if (GX.tierFilter !== "all") {
    nodes = nodes.filter(n => GX.tierFilter === "none" ? !n.tierId : String(n.tierId) === GX.tierFilter);
  }
  // Apply range filters
  for (const [key, range] of Object.entries(GX.filters)) {
    const axisDef = GX.yAxes.find(a => a.key === key) || (key === "lastContactDate" ? GX.xDef : null);
    if (!axisDef) continue;
    nodes = nodes.filter(n => {
      let val;
      if (axisDef.type === "time") {
        val = n[key] ? n[key].getTime() : 0;
        if (range.min !== undefined && val < range.min) return false;
        if (range.max !== undefined && val > range.max) return false;
      } else {
        val = n[key] || 0;
        if (range.min !== undefined && val < range.min) return false;
        if (range.max !== undefined && val > range.max) return false;
      }
      return true;
    });
  }
  return nodes;
}

function gxMakeScale(axisDef, nodes, key, rangeArr) {
  if (axisDef && axisDef.type === "time") {
    const ext = d3.extent(nodes, d => d[key] || new Date(0));
    const pad = ((ext[1] || 0) - (ext[0] || 0)) * 0.05 || 86400000;
    return d3.scaleTime()
      .domain([new Date(ext[0].getTime() - pad), new Date(ext[1].getTime() + pad)])
      .range(rangeArr);
  }
  const ext = d3.extent(nodes, d => d[key] || 0);
  if (GX.logScale) {
    // Log scale: clamp domain minimum to 1 (log(0) is undefined)
    const lo = Math.max(1, ext[0] || 1);
    const hi = Math.max(lo + 1, ext[1] || 2);
    return d3.scaleLog().domain([lo, hi]).range(rangeArr).clamp(true);
  }
  const pad = (ext[1] - ext[0]) * 0.05 || 1;
  return d3.scaleLinear().domain([ext[0] - pad, ext[1] + pad]).range(rangeArr);
}

function gxDeoverlapLabels(nodes, xs, ys, xv, yv) {
  // Greedy label de-overlap: assign each label a position that avoids previous labels.
  // Each label starts below its dot; if that collides, try right, left, above, then shift down.
  const CHAR_W = 5.4; // approx width per char at 9px
  const LBL_H = 12;   // label height
  const placed = []; // { x, y, w, h }
  const result = {}; // { id: { x, y, anchor } }

  function overlaps(rect) {
    for (const p of placed) {
      if (rect.x < p.x + p.w && rect.x + rect.w > p.x &&
          rect.y < p.y + p.h && rect.y + rect.h > p.y) return true;
    }
    return false;
  }

  for (const n of nodes) {
    const cx = xs(xv(n));
    const cy = ys(yv(n));
    const r = gxGetRadius(n);
    const text = n.name.length > 16 ? n.name.substring(0, 14) + ".." : n.name;
    const tw = text.length * CHAR_W;

    // Try positions: below, right, left, above
    const candidates = [
      { x: cx - tw / 2, y: cy + r + 3, anchor: "middle" },         // below
      { x: cx + r + 4, y: cy + LBL_H / 3, anchor: "start" },       // right
      { x: cx - r - 4 - tw, y: cy + LBL_H / 3, anchor: "end" },    // left
      { x: cx - tw / 2, y: cy - r - 4, anchor: "middle" },          // above
    ];

    let chosen = null;
    for (const c of candidates) {
      const rect = { x: c.x, y: c.y - LBL_H + 2, w: tw, h: LBL_H };
      if (!overlaps(rect)) { chosen = { ...c, rect }; break; }
    }

    // Fallback: below with increasing vertical offset
    if (!chosen) {
      for (let dy = LBL_H; dy < LBL_H * 6; dy += LBL_H) {
        const c = { x: cx - tw / 2, y: cy + r + 3 + dy, anchor: "middle" };
        const rect = { x: c.x, y: c.y - LBL_H + 2, w: tw, h: LBL_H };
        if (!overlaps(rect)) { chosen = { ...c, rect }; break; }
      }
    }

    if (!chosen) {
      const c = candidates[0];
      chosen = { ...c, rect: { x: c.x, y: c.y - LBL_H + 2, w: tw, h: LBL_H } };
    }

    placed.push(chosen.rect);
    // SVG text x: for "start" anchor = left edge, "end" = right edge, "middle" = center
    let labelX;
    if (chosen.anchor === "start") labelX = chosen.x;
    else if (chosen.anchor === "end") labelX = chosen.x + tw;
    else labelX = chosen.x + tw / 2;
    result[n.id] = { x: labelX, y: chosen.y, anchor: chosen.anchor };
  }
  return result;
}

function gxRender(fast) {
  const wrap = $("gx-canvas-wrap");
  if (!wrap || !GX.data) return;

  const nodes = gxFilteredNodes();
  GX.nodes = nodes;
  const nodeIds = new Set(nodes.map(n => n.id));
  GX.edges = (GX.data.edges || []).filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
  GX.tagEdges = (GX.data.tagEdges || []).filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));

  const W = wrap.clientWidth;
  const H = wrap.clientHeight;

  const xKey = GX.xAxis;
  const yKey = GX.yAxis;
  const xDef = GX.xDef; // locked time axis
  const yDef = GX.yAxes.find(a => a.key === yKey);

  // Dynamic margins: wider bottom for time X-axis labels
  const margin = { top: 20, right: 20, bottom: 44, left: 60 };

  // X scale: use time window bounds as domain
  const tw = gxTimeWindow();
  GX.xScale = d3.scaleTime().domain([tw.start, tw.end]).range([margin.left, W - margin.right]);
  GX.yScale = gxMakeScale(yDef, nodes, yKey, [H - margin.bottom, margin.top]);

  const svg = d3.select("#gx-svg");
  svg.attr("width", W).attr("height", H);

  if (!GX.g) {
    svg.selectAll("*").remove();
    GX.g = svg.append("g").attr("class", "gx-main");
    GX.g.append("rect").attr("class", "gx-bg").attr("width", W * 3).attr("height", H * 3)
      .attr("x", -W).attr("y", -H).attr("fill", "transparent");
    GX.g.append("g").attr("class", "gx-edges-layer");
    GX.g.append("g").attr("class", "gx-tag-edges-layer");
    GX.g.append("g").attr("class", "gx-dots-layer");
    GX.g.append("g").attr("class", "gx-labels-layer");
    svg.append("g").attr("class", "gx-axis gx-x-axis");
    svg.append("g").attr("class", "gx-axis gx-y-axis");
    svg.append("text").attr("class", "gx-axis-label gx-x-label");
    svg.append("text").attr("class", "gx-axis-label gx-y-label")
      .attr("transform", "rotate(-90)");

    // Y-axis drag zoom: drag up/down to zoom Y, centered on selected point
    GX.zoom = d3.zoom().scaleExtent([0.1, 100])
      .filter(e => e.type === "wheel" || e.type === "mousedown" || e.type === "touchstart")
      .on("zoom", (e) => {
        // Only apply Y scaling — X is locked to time window
        const yOnly = d3.zoomIdentity.translate(0, e.transform.y).scale(e.transform.k);
        GX.currentTransform = yOnly;
        GX.g.attr("transform", d3.zoomIdentity);
        gxDynamicRescale(yOnly);
      });
    svg.call(GX.zoom);
    svg.on("click", (e) => {
      if (e.target.classList.contains("gx-bg") || e.target.tagName === "svg") gxSelect(null);
    });
  }

  const dur = fast ? 0 : 500;
  const t = d3.transition().duration(dur).ease(d3.easeCubicOut);
  let xs = GX.xScale; // X stays fixed to time window
  let ys = GX.yScale;

  // Apply Y-axis zoom if active
  if (GX.currentTransform.k !== 1 || GX.currentTransform.y !== 0) {
    ys = GX.currentTransform.rescaleY(ys);
    GX.g.attr("transform", d3.zoomIdentity);
  }
  // Store the working scales for navigation etc
  GX._xs = xs;
  GX._ys = ys;

  // X axis is always time; Y is always numeric
  const xAxisGen = d3.axisBottom(xs).ticks(8).tickFormat(d3.timeFormat("%b '%y"));
  const yAxisGen = d3.axisLeft(ys).ticks(6);

  // Update axis positions
  svg.select(".gx-x-axis").attr("transform", `translate(0,${H - margin.bottom})`).transition(t).call(xAxisGen.tickSize(-H + margin.top + margin.bottom));
  svg.select(".gx-y-axis").attr("transform", `translate(${margin.left},0)`).transition(t).call(yAxisGen.tickSize(-W + margin.left + margin.right));
  svg.selectAll(".gx-axis line").attr("stroke", "rgba(255,255,255,0.04)");
  svg.selectAll(".gx-axis path").attr("stroke", "rgba(255,255,255,0.08)");
  // Rotate X-axis tick labels to prevent overlap
  svg.select(".gx-x-axis").selectAll("text").attr("transform", "rotate(-35)").attr("text-anchor", "end").attr("dx", "-4px").attr("dy", "4px");
  const xLabel = xDef.label;
  const yLabel = (yDef?.label || yKey) + (GX.logScale ? " (log)" : "");
  svg.select(".gx-x-label").attr("x", W / 2).attr("y", H - 4).text(xLabel);
  svg.select(".gx-y-label").attr("x", -H / 2).attr("y", 12).text(yLabel);

  // Helper to get value for scale
  const xv = d => {
    const v = d[xKey];
    return v instanceof Date ? v : (v || 0);
  };
  const yv = d => {
    const v = d[yKey];
    // Log scale: clamp to 1 minimum (log(0) undefined)
    if (GX.logScale) return Math.max(1, v || 0);
    return v instanceof Date ? v : (v || 0);
  };

  // Edges (group connections)
  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.id] = n; });
  const edgeData = GX.showGroupLines ? GX.edges : [];
  const edgeSel = GX.g.select(".gx-edges-layer").selectAll("line.gx-edge").data(edgeData, d => d.source + "|" + d.target);
  edgeSel.exit().transition(t).attr("stroke-opacity", 0).remove();
  const edgeEnter = edgeSel.enter().append("line").attr("class", "gx-edge")
    .attr("stroke", "rgba(79,195,247,0.15)").attr("stroke-opacity", 0);
  edgeSel.merge(edgeEnter).transition(t)
    .attr("x1", d => xs(xv(nodeMap[d.source] || {}))).attr("y1", d => ys(yv(nodeMap[d.source] || {})))
    .attr("x2", d => xs(xv(nodeMap[d.target] || {}))).attr("y2", d => ys(yv(nodeMap[d.target] || {})))
    .attr("stroke-width", d => Math.min(2, d.weight * 0.6)).attr("stroke-opacity", 0.15);

  // Tag edges
  const tagEdgeData = GX.showTagLines ? GX.tagEdges : [];
  const tagSel = GX.g.select(".gx-tag-edges-layer").selectAll("line.gx-tag-edge").data(tagEdgeData, d => d.source + "|" + d.target);
  tagSel.exit().transition(t).attr("stroke-opacity", 0).remove();
  const tagEnter = tagSel.enter().append("line").attr("class", "gx-tag-edge")
    .attr("stroke", "rgba(253,203,110,0.15)").attr("stroke-opacity", 0).attr("stroke-dasharray", "3,3");
  tagSel.merge(tagEnter).transition(t)
    .attr("x1", d => xs(xv(nodeMap[d.source] || {}))).attr("y1", d => ys(yv(nodeMap[d.source] || {})))
    .attr("x2", d => xs(xv(nodeMap[d.target] || {}))).attr("y2", d => ys(yv(nodeMap[d.target] || {})))
    .attr("stroke-opacity", 0.2);

  // Dots
  const dotSel = GX.g.select(".gx-dots-layer").selectAll("circle.gx-dot").data(nodes, d => d.id);
  dotSel.exit().transition(t).attr("r", 0).attr("opacity", 0).remove();
  const dotEnter = dotSel.enter().append("circle").attr("class", "gx-dot")
    .attr("cx", d => xs(xv(d))).attr("cy", d => ys(yv(d)))
    .attr("r", 0).attr("opacity", 0).attr("cursor", "pointer")
    .on("click", (e, d) => { e.stopPropagation(); gxSelect(d); })
    .on("dblclick", (e, d) => { e.stopPropagation(); openContactDetail(d.id); })
    .on("mouseenter", (e, d) => gxShowTooltip(d, e))
    .on("mouseleave", () => gxHideTooltip());
  const dotMerge = dotSel.merge(dotEnter);
  dotMerge.transition(t)
    .attr("cx", d => xs(xv(d))).attr("cy", d => ys(yv(d)))
    .attr("r", d => gxGetRadius(d)).attr("fill", d => gxGetColor(d))
    .attr("opacity", d => (GX.searchQ && !d.name.toLowerCase().includes(GX.searchQ)) ? 0.08 : 0.85);
  dotMerge.classed("selected", d => GX.selected && d.id === GX.selected.id)
    .classed("dimmed", d => GX.searchQ && !d.name.toLowerCase().includes(GX.searchQ));

  // Labels (clickable, with de-overlap)
  if (GX.showLabels) {
    const lblSel = GX.g.select(".gx-labels-layer").selectAll("text.gx-label").data(nodes, d => d.id);
    lblSel.exit().transition(t).attr("opacity", 0).remove();
    const lblEnter = lblSel.enter().append("text").attr("class", "gx-label")
      .attr("text-anchor", "middle").attr("font-size", "9px").attr("fill", "rgba(220,220,230,0.6)")
      .attr("pointer-events", "auto").attr("cursor", "pointer")
      .on("click", (e, d) => { e.stopPropagation(); gxSelect(d); })
      .on("dblclick", (e, d) => { e.stopPropagation(); openContactDetail(d.id); });
    const lblMerge = lblSel.merge(lblEnter);
    lblMerge.text(d => d.name.length > 16 ? d.name.substring(0, 14) + ".." : d.name);

    if (fast) {
      // Fast mode: place labels naively first, de-overlap in background
      lblMerge
        .attr("x", d => xs(xv(d)))
        .attr("y", d => ys(yv(d)) + gxGetRadius(d) + 12)
        .attr("text-anchor", "middle")
        .attr("opacity", d => (GX.searchQ && !d.name.toLowerCase().includes(GX.searchQ)) ? 0.05 : 0.6);
      // Defer de-overlap to idle time
      const _xs = xs, _ys = ys, _xv = xv, _yv = yv;
      (window.requestIdleCallback || requestAnimationFrame)(() => {
        const labelPositions = gxDeoverlapLabels(nodes, _xs, _ys, _xv, _yv);
        lblMerge.transition().duration(300).ease(d3.easeCubicOut)
          .attr("x", d => labelPositions[d.id]?.x ?? _xs(_xv(d)))
          .attr("y", d => labelPositions[d.id]?.y ?? _ys(_yv(d)))
          .attr("dy", 0)
          .attr("text-anchor", d => labelPositions[d.id]?.anchor ?? "middle");
      });
    } else {
      // Normal mode: compute de-overlap synchronously
      const labelPositions = gxDeoverlapLabels(nodes, xs, ys, xv, yv);
      lblMerge.transition(t)
        .attr("x", d => labelPositions[d.id]?.x ?? xs(xv(d)))
        .attr("y", d => labelPositions[d.id]?.y ?? ys(yv(d)))
        .attr("dy", 0)
        .attr("text-anchor", d => labelPositions[d.id]?.anchor ?? "middle")
        .attr("opacity", d => (GX.searchQ && !d.name.toLowerCase().includes(GX.searchQ)) ? 0.05 : 0.6);
    }
  } else {
    GX.g.select(".gx-labels-layer").selectAll("text.gx-label").transition(t).attr("opacity", 0).remove();
  }

  if (GX.selected) dotMerge.filter(d => d.id === GX.selected.id).raise();

  // Active filters count
  const filterCount = Object.keys(GX.filters).length;
  const filterLabel = filterCount > 0 ? ` · ${filterCount} filter${filterCount > 1 ? 's' : ''} active` : "";

  const status = $("gx-status");
  if (status) {
    status.textContent = `${nodes.length} contacts · Last Contact · ${yLabel}` + filterLabel +
      (GX.selected ? ` · Selected: ${GX.selected.name}` : "") +
      ` · Press ? for shortcuts`;
  }
}

function gxSelect(node) {
  GX.selected = node;
  d3.selectAll(".gx-dot").classed("selected", d => node && d.id === node.id);
  // Highlight only — double-click opens profile
  const status = $("gx-status");
  if (status) {
    const yL = GX.yAxes.find(a => a.key === GX.yAxis)?.label || GX.yAxis;
    status.textContent = `${GX.nodes.length} contacts · Last Contact · ${yL}` +
      (node ? ` · Selected: ${node.name} (dbl-click to open)` : "") + ` · Press ? for shortcuts`;
  }
}

function gxRenderDetail(n) {
  const nameEl = $("gx-detail-name");
  const body = $("gx-detail-body");
  if (!nameEl || !body) return;
  const tierBadge = n.tierName
    ? `<span style="background:${n.tierColor || '#555'}22;color:${n.tierColor || '#555'};font-size:10px;padding:2px 8px;border-radius:10px;margin-left:6px;">${esc(n.tierName)}</span>` : "";
  nameEl.innerHTML = esc(n.name) + tierBadge;
  const daysAgo = n.daysSince || 0;
  const recency = daysAgo === 0 ? "Today" : daysAgo === 1 ? "Yesterday" : daysAgo + "d ago";
  body.innerHTML = `
    <div class="gxd-section"><div class="gxd-stat-grid">
      <div class="gxd-stat"><div class="gxd-stat-val">${n.messages}</div><div class="gxd-stat-lbl">Messages</div></div>
      <div class="gxd-stat"><div class="gxd-stat-val">${n.messages30d}</div><div class="gxd-stat-lbl">Last 30d</div></div>
      <div class="gxd-stat"><div class="gxd-stat-val">${n.sent}</div><div class="gxd-stat-lbl">Sent</div></div>
      <div class="gxd-stat"><div class="gxd-stat-val">${n.received}</div><div class="gxd-stat-lbl">Received</div></div>
      <div class="gxd-stat"><div class="gxd-stat-val">${n.quality}</div><div class="gxd-stat-lbl">Quality</div></div>
      <div class="gxd-stat"><div class="gxd-stat-val">${recency}</div><div class="gxd-stat-lbl">Last Contact</div></div>
    </div></div>
    ${n.tags.length > 0 ? `<div class="gxd-section"><div class="gxd-label">Tags (${n.tags.length})</div>
      <div class="gxd-tags">${n.tags.map(t => `<span class="gxd-tag">${esc(t)}</span>`).join("")}</div></div>` : ""}
    ${n.groups.length > 0 ? `<div class="gxd-section"><div class="gxd-label">Groups (${n.groups.length})</div>
      ${n.groups.map(g => `<div class="gxd-group">· ${esc(g)}</div>`).join("")}</div>` : ""}
    <div class="gxd-section"><button class="gxd-btn" onclick="openContactDetail('${esc(n.id)}')">Open Full Profile</button></div>`;
}

function gxShowTooltip(n, event) {
  const tip = $("gx-tooltip");
  if (!tip) return;
  const tierBadge = n.tierName
    ? ` <span style="background:${n.tierColor || '#555'}22;color:${n.tierColor || '#555'};font-size:9px;padding:1px 6px;border-radius:3px;">${esc(n.tierName)}</span>` : "";
  tip.innerHTML = `<strong>${esc(n.name)}</strong>${tierBadge}<br>` +
    `<span style="color:var(--text-dim);">${n.messages} msgs · ${n.messages30d} last 30d · Q:${n.quality}</span>` +
    (n.tags.length > 0 ? `<br><span style="color:var(--accent);font-size:10px;">${n.tags.slice(0, 5).join(", ")}</span>` : "") +
    (n.groups.length > 0 ? `<br><span style="color:var(--text-dim);font-size:10px;">${n.groups.slice(0, 3).join(", ")}</span>` : "");
  tip.style.display = "block";
  const wrap = $("gx-canvas-wrap");
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  let tx = event.clientX - rect.left + 14;
  let ty = event.clientY - rect.top + 14;
  if (tx + 260 > rect.width) tx -= 280;
  if (ty + 120 > rect.height) ty -= 130;
  tip.style.left = tx + "px";
  tip.style.top = ty + "px";
}

function gxHideTooltip() {
  const tip = $("gx-tooltip");
  if (tip) tip.style.display = "none";
}

function gxDynamicRescale(transform) {
  // Y-axis only zoom: X stays at time window, Y rescales
  if (!GX.xScale || !GX.yScale || !GX.data) return;
  const xs = GX.xScale; // X stays fixed to time window
  const ys = transform.rescaleY(GX.yScale);
  GX._xs = xs;
  GX._ys = ys;

  const xKey = GX.xAxis, yKey = GX.yAxis;
  const xv = d => { const v = d[xKey]; return v instanceof Date ? v : (v || 0); };
  const yv = d => { const v = d[yKey]; if (GX.logScale) return Math.max(1, v || 0); return v instanceof Date ? v : (v || 0); };

  const wrap = $("gx-canvas-wrap");
  const W = wrap ? wrap.clientWidth : 800;
  const H = wrap ? wrap.clientHeight : 600;
  const margin = { top: 20, right: 20, bottom: 44, left: 60 };

  // X is always time, Y is always numeric
  const xAxisGen = d3.axisBottom(xs).ticks(8).tickFormat(d3.timeFormat("%b '%y"));
  const yAxisGen = d3.axisLeft(ys).ticks(6);

  const svg = d3.select("#gx-svg");
  svg.select(".gx-x-axis").call(xAxisGen.tickSize(-H + margin.top + margin.bottom));
  svg.select(".gx-y-axis").call(yAxisGen.tickSize(-W + margin.left + margin.right));
  svg.selectAll(".gx-axis line").attr("stroke", "rgba(255,255,255,0.04)");
  svg.selectAll(".gx-axis path").attr("stroke", "rgba(255,255,255,0.08)");
  svg.select(".gx-x-axis").selectAll("text").attr("transform", "rotate(-35)").attr("text-anchor", "end").attr("dx", "-4px").attr("dy", "4px");

  // Reposition dots
  GX.g.select(".gx-dots-layer").selectAll("circle.gx-dot")
    .attr("cx", d => xs(xv(d))).attr("cy", d => ys(yv(d)));

  // Reposition labels with de-overlap
  if (GX.showLabels) {
    const labelPositions = gxDeoverlapLabels(GX.nodes, xs, ys, xv, yv);
    GX.g.select(".gx-labels-layer").selectAll("text.gx-label")
      .attr("x", d => labelPositions[d.id]?.x ?? xs(xv(d)))
      .attr("y", d => labelPositions[d.id]?.y ?? ys(yv(d)))
      .attr("dy", 0)
      .attr("text-anchor", d => labelPositions[d.id]?.anchor ?? "middle");
  }

  // Reposition edges
  const nodeMap = {};
  GX.nodes.forEach(n => { nodeMap[n.id] = n; });
  GX.g.select(".gx-edges-layer").selectAll("line.gx-edge")
    .attr("x1", d => xs(xv(nodeMap[d.source] || {}))).attr("y1", d => ys(yv(nodeMap[d.source] || {})))
    .attr("x2", d => xs(xv(nodeMap[d.target] || {}))).attr("y2", d => ys(yv(nodeMap[d.target] || {})));
  GX.g.select(".gx-tag-edges-layer").selectAll("line.gx-tag-edge")
    .attr("x1", d => xs(xv(nodeMap[d.source] || {}))).attr("y1", d => ys(yv(nodeMap[d.source] || {})))
    .attr("x2", d => xs(xv(nodeMap[d.target] || {}))).attr("y2", d => ys(yv(nodeMap[d.target] || {})));
}

function gxBuildFilters() {
  const panel = $("gx-filter-panel");
  if (!panel || !GX.data) return;

  // Compute min/max for each numeric Y-axis
  const allNodes = GX.data.nodes;
  const rows = GX.yAxes.filter(a => a.type === "num").map(a => {
    const vals = allNodes.map(n => n[a.key] || 0);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return { key: a.key, label: a.label, short: a.short, min, max };
  });
  // No time filter rows needed — X axis is controlled by time window
  const timeRows = [];

  let html = "";
  for (const r of [...rows, ...timeRows]) {
    const active = GX.filters[r.key];
    const fmtMin = r.isTime ? new Date(r.min).toISOString().split("T")[0] : Math.floor(r.min);
    const fmtMax = r.isTime ? new Date(r.max).toISOString().split("T")[0] : Math.ceil(r.max);
    const curMin = active ? (r.isTime ? new Date(active.min).toISOString().split("T")[0] : active.min) : fmtMin;
    const curMax = active ? (r.isTime ? new Date(active.max).toISOString().split("T")[0] : active.max) : fmtMax;
    html += `<div class="gx-filter-row${active ? ' active' : ''}" data-key="${r.key}" data-type="${r.isTime ? 'time' : 'num'}">
      <div class="gx-filter-label">${r.label}</div>
      <div class="gx-filter-inputs">
        ${r.isTime
          ? `<input type="date" class="gx-filter-input gx-fmin" value="${curMin}" min="${fmtMin}" max="${fmtMax}">
             <span class="gx-filter-sep">to</span>
             <input type="date" class="gx-filter-input gx-fmax" value="${curMax}" min="${fmtMin}" max="${fmtMax}">`
          : `<input type="number" class="gx-filter-input gx-fmin" value="${curMin}" min="${r.min}" max="${r.max}" step="1" placeholder="min">
             <span class="gx-filter-sep">to</span>
             <input type="number" class="gx-filter-input gx-fmax" value="${curMax}" min="${r.min}" max="${r.max}" step="1" placeholder="max">`
        }
        <button class="gx-filter-apply" title="Apply filter">&#10003;</button>
        ${active ? `<button class="gx-filter-clear" title="Clear filter">&times;</button>` : ""}
      </div>
    </div>`;
  }
  panel.innerHTML = html;
}

function gxNavigate(dir) {
  if (!GX.nodes.length) return;
  if (!GX.selected) { gxSelect(GX.nodes[0]); return; }
  const xs = GX._xs || GX.xScale;
  const ys = GX._ys || GX.yScale;
  const xKey = GX.xAxis, yKey = GX.yAxis;
  const xv = d => { const v = d[xKey]; return v instanceof Date ? v : (v || 0); };
  const yv = d => { const v = d[yKey]; if (GX.logScale) return Math.max(1, v || 0); return v instanceof Date ? v : (v || 0); };
  const cx = xs(xv(GX.selected)), cy = ys(yv(GX.selected));
  let best = null, bestDist = Infinity;
  for (const n of GX.nodes) {
    if (n.id === GX.selected.id) continue;
    if (GX.searchQ && !n.name.toLowerCase().includes(GX.searchQ)) continue;
    const nx = xs(xv(n)), ny = ys(yv(n));
    const dx = nx - cx, dy = ny - cy;
    let ok = false;
    if (dir === "right" && dx > 5) ok = true;
    if (dir === "left" && dx < -5) ok = true;
    if (dir === "up" && dy < -5) ok = true;
    if (dir === "down" && dy > 5) ok = true;
    if (!ok) continue;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestDist) { bestDist = dist; best = n; }
  }
  if (best) gxSelect(best);
}

function gxCyclePill(current, options) {
  const idx = options.findIndex(o => o.key === current);
  return options[(idx + 1) % options.length].key;
}

function setupGraphHandlers() {
  document.addEventListener("click", (e) => {
    // Time window pills
    const winPill = e.target.closest("[data-window]");
    if (winPill) {
      GX.timeWindow = winPill.dataset.window;
      GX.timeOffset = 0; // reset to most recent
      GX.currentTransform = d3.zoomIdentity;
      if (GX.zoom) d3.select("#gx-svg").call(GX.zoom.transform, d3.zoomIdentity);
      GX.g = null; // force rebuild for new domain
      gxBuildToolbar(); gxRender(); return;
    }
    // Time window nav buttons (left/right)
    const navBtn = e.target.closest(".gx-nav-btn");
    if (navBtn) {
      const dir = navBtn.dataset.nav;
      if (dir === "left") GX.timeOffset++;
      else if (dir === "right" && GX.timeOffset > 0) GX.timeOffset--;
      GX.currentTransform = d3.zoomIdentity;
      if (GX.zoom) d3.select("#gx-svg").call(GX.zoom.transform, d3.zoomIdentity);
      GX.g = null;
      gxBuildToolbar(); gxRender(); return;
    }
    const pill = e.target.closest(".gx-pill");
    if (pill) {
      const axis = pill.dataset.axis, mode = pill.dataset.mode, key = pill.dataset.key;
      if (axis === "y") GX.yAxis = key;
      else if (mode === "color") GX.colorMode = key;
      else if (mode === "size") GX.sizeMode = key;
      // Reset zoom when axes change
      GX.currentTransform = d3.zoomIdentity;
      if (GX.zoom) d3.select("#gx-svg").call(GX.zoom.transform, d3.zoomIdentity);
      gxBuildToolbar(); gxRender(); return;
    }
    const tierPill = e.target.closest(".gx-tier-pill");
    if (tierPill) {
      GX.tierFilter = tierPill.dataset.tier;
      document.querySelectorAll(".gx-tier-pill").forEach(p => p.classList.toggle("active", p.dataset.tier === GX.tierFilter));
      gxRender(); return;
    }
    // Filter apply/clear buttons
    const applyBtn = e.target.closest(".gx-filter-apply");
    if (applyBtn) {
      const row = applyBtn.closest(".gx-filter-row");
      if (row) gxApplyFilter(row);
      return;
    }
    const clearBtn = e.target.closest(".gx-filter-clear");
    if (clearBtn) {
      const row = clearBtn.closest(".gx-filter-row");
      if (row) { delete GX.filters[row.dataset.key]; gxBuildFilters(); gxRender(); }
      return;
    }
  });

  const btnG = $("gx-btn-lines");
  if (btnG) btnG.addEventListener("click", () => { GX.showGroupLines = !GX.showGroupLines; btnG.classList.toggle("active"); gxRender(); });
  const btnT = $("gx-btn-tags");
  if (btnT) btnT.addEventListener("click", () => { GX.showTagLines = !GX.showTagLines; btnT.classList.toggle("active"); gxRender(); });
  const btnL = $("gx-btn-labels");
  if (btnL) btnL.addEventListener("click", () => { GX.showLabels = !GX.showLabels; btnL.classList.toggle("active"); gxRender(); });
  const btnH = $("gx-btn-help");
  if (btnH) btnH.addEventListener("click", () => $("gx-help-overlay")?.classList.toggle("open"));
  const helpOv = $("gx-help-overlay");
  if (helpOv) helpOv.addEventListener("click", (e) => { if (e.target === helpOv) helpOv.classList.remove("open"); });
  const closeBtn = $("gx-detail-close");
  if (closeBtn) closeBtn.addEventListener("click", () => gxSelect(null));

  // Log scale toggle
  const btnLog = $("gx-btn-log");
  if (btnLog) btnLog.addEventListener("click", () => {
    gxToggleLogScale();
  });

  // Filter toggle
  const btnFilter = $("gx-btn-filter");
  if (btnFilter) btnFilter.addEventListener("click", () => {
    GX.filtersOpen = !GX.filtersOpen;
    $("gx-filter-panel")?.classList.toggle("open", GX.filtersOpen);
    btnFilter.classList.toggle("active", GX.filtersOpen);
  });

  const searchInput = $("gx-search");
  if (searchInput) searchInput.addEventListener("input", () => { GX.searchQ = searchInput.value.toLowerCase().trim(); gxRender(); });

  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { GX.g = null; gxRender(); }, 200); });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const graphTab = $("tab-graph");
    if (!graphTab || !graphTab.classList.contains("active")) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
      if (e.key === "Escape") { e.target.blur(); e.target.value = ""; GX.searchQ = ""; gxRender(); }
      if (e.key === "Enter" && e.target.closest(".gx-filter-row")) {
        gxApplyFilter(e.target.closest(".gx-filter-row"));
      }
      return;
    }
    switch (e.key) {
      case "ArrowRight": e.preventDefault(); gxNavigate("right"); break;
      case "ArrowLeft": e.preventDefault(); gxNavigate("left"); break;
      case "ArrowUp": e.preventDefault(); gxNavigate("up"); break;
      case "ArrowDown": e.preventDefault(); gxNavigate("down"); break;
      case "Enter": if (GX.selected) openContactDetail(GX.selected.id); break;
      case "Escape":
        gxSelect(null);
        $("gx-help-overlay")?.classList.remove("open");
        if (GX.filtersOpen) { GX.filtersOpen = false; $("gx-filter-panel")?.classList.remove("open"); $("gx-btn-filter")?.classList.remove("active"); }
        break;
      case "y": case "Y":
        GX.yAxis = gxCyclePill(GX.yAxis, GX.yAxes);
        GX.currentTransform = d3.zoomIdentity;
        if (GX.zoom) d3.select("#gx-svg").call(GX.zoom.transform, d3.zoomIdentity);
        gxBuildToolbar(); gxRender(); break;
      case "[":
        GX.timeOffset++;
        GX.currentTransform = d3.zoomIdentity;
        if (GX.zoom) d3.select("#gx-svg").call(GX.zoom.transform, d3.zoomIdentity);
        GX.g = null; gxBuildToolbar(); gxRender(); break;
      case "]":
        if (GX.timeOffset > 0) GX.timeOffset--;
        GX.currentTransform = d3.zoomIdentity;
        if (GX.zoom) d3.select("#gx-svg").call(GX.zoom.transform, d3.zoomIdentity);
        GX.g = null; gxBuildToolbar(); gxRender(); break;
      case "c": case "C": GX.colorMode = gxCyclePill(GX.colorMode, GX.colors); gxBuildToolbar(); gxRender(); break;
      case "s": case "S": GX.sizeMode = gxCyclePill(GX.sizeMode, GX.sizes); gxBuildToolbar(); gxRender(); break;
      case "g": GX.showGroupLines = !GX.showGroupLines; $("gx-btn-lines")?.classList.toggle("active"); gxRender(); break;
      case "t": GX.showTagLines = !GX.showTagLines; $("gx-btn-tags")?.classList.toggle("active"); gxRender(); break;
      case "l": case "L": GX.showLabels = !GX.showLabels; $("gx-btn-labels")?.classList.toggle("active"); gxRender(); break;
      case "f": case "F": e.preventDefault(); $("gx-search")?.focus(); break;
      case "w": case "W": gxToggleLogScale(); break;
      case "/": e.preventDefault();
        GX.filtersOpen = !GX.filtersOpen;
        $("gx-filter-panel")?.classList.toggle("open", GX.filtersOpen);
        $("gx-btn-filter")?.classList.toggle("active", GX.filtersOpen);
        break;
      case "?": $("gx-help-overlay")?.classList.toggle("open"); break;
      case "r": case "R":
        GX.currentTransform = d3.zoomIdentity;
        if (GX.zoom) d3.select("#gx-svg").transition().duration(500).call(GX.zoom.transform, d3.zoomIdentity);
        gxRender();
        break;
      case "+": case "=":
        if (GX.zoom) d3.select("#gx-svg").transition().duration(300).call(GX.zoom.scaleBy, 1.5); break;
      case "-": case "_":
        if (GX.zoom) d3.select("#gx-svg").transition().duration(300).call(GX.zoom.scaleBy, 0.67); break;
      case "0":
        GX.tierFilter = "all";
        document.querySelectorAll(".gx-tier-pill").forEach(p => p.classList.toggle("active", p.dataset.tier === "all"));
        gxRender(); break;
      case "1": case "2": case "3": case "4": case "5": {
        const idx = parseInt(e.key) - 1;
        if (idx < GX.tiers.length) {
          GX.tierFilter = String(GX.tiers[idx].id);
          document.querySelectorAll(".gx-tier-pill").forEach(p => p.classList.toggle("active", p.dataset.tier === GX.tierFilter));
          gxRender();
        }
        break;
      }
    }
  });
}

function gxToggleLogScale() {
  GX.logScale = !GX.logScale;
  const btn = $("gx-btn-log");
  if (btn) {
    btn.classList.toggle("active", GX.logScale);
    btn.title = GX.logScale ? "Linear Y scale (W)" : "Logarithmic Y scale (W)";
  }
  GX.currentTransform = d3.zoomIdentity;
  if (GX.zoom) d3.select("#gx-svg").call(GX.zoom.transform, d3.zoomIdentity);
  GX.g = null;
  gxRender();
}

function gxApplyFilter(row) {
  const key = row.dataset.key;
  const type = row.dataset.type;
  const minInput = row.querySelector(".gx-fmin");
  const maxInput = row.querySelector(".gx-fmax");
  if (!minInput || !maxInput) return;

  if (type === "time") {
    const minVal = minInput.value ? new Date(minInput.value).getTime() : undefined;
    const maxVal = maxInput.value ? new Date(maxInput.value + "T23:59:59").getTime() : undefined;
    if (minVal !== undefined || maxVal !== undefined) {
      GX.filters[key] = { min: minVal, max: maxVal };
    }
  } else {
    const minVal = minInput.value !== "" ? parseFloat(minInput.value) : undefined;
    const maxVal = maxInput.value !== "" ? parseFloat(maxInput.value) : undefined;
    if (minVal !== undefined || maxVal !== undefined) {
      GX.filters[key] = { min: minVal, max: maxVal };
    }
  }
  gxBuildFilters();
  gxRender();
}

// ── Utility Functions ──

function esc(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/** Display name for a contact — falls back to formatted phone number if no name */
function contactDisplayName(c) {
  if (c.name && c.name.trim() && c.name !== "Unknown") return c.name;
  // Extract phone from contact ID (format: "15551234567@c.us" or "+1234@imessage")
  const id = c.id || c.contact_id || "";
  const phonePart = id.split("@")[0];
  if (phonePart && /^\d{7,15}$/.test(phonePart)) {
    return "+" + phonePart;
  }
  return c.name || c.id || "Unknown";
}

function timeAgo(unixTs) {
  if (!unixTs) return "--";
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixTs;
  if (diff < 0) return "just now";
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  if (diff < 2592000) return Math.floor(diff / 86400) + "d ago";
  if (diff < 31536000) return Math.floor(diff / 2592000) + "mo ago";
  return Math.floor(diff / 31536000) + "y ago";
}

function formatDuration(seconds) {
  if (seconds == null || seconds === 0) return "--";
  if (seconds < 60) return Math.round(seconds) + "s";
  if (seconds < 3600) return Math.round(seconds / 60) + "m";
  if (seconds < 86400) return (seconds / 3600).toFixed(1) + "h";
  return (seconds / 86400).toFixed(1) + "d";
}

function qualityClass(score) {
  if (score == null) return "low";
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is "data:mime;base64,XXXXX" — extract just the base64 part
      const result = reader.result;
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

// ── Bot Detection ──

function setupBotDetection() {
  const detectBtn = $("detect-bots-btn");
  if (!detectBtn) return;

  detectBtn.addEventListener("click", async () => {
    detectBtn.disabled = true;
    detectBtn.textContent = "Scanning...";
    try {
      const res = await adminFetch("/api/friends/contacts/detect-bots");
      if (!res.ok) throw new Error("Detection failed");
      const data = await res.json();
      renderBotResults(data.candidates);
    } catch (err) {
      alert("Bot detection failed: " + err.message);
    } finally {
      detectBtn.disabled = false;
      detectBtn.textContent = "Scan for Bots";
    }
  });

  $("bot-select-all")?.addEventListener("click", () => {
    document.querySelectorAll(".bot-checkbox").forEach(cb => cb.checked = true);
  });

  $("bot-hide-selected")?.addEventListener("click", async () => {
    const selected = [];
    document.querySelectorAll(".bot-checkbox:checked").forEach(cb => {
      selected.push(cb.dataset.contactId);
    });
    if (selected.length === 0) { alert("No contacts selected."); return; }
    if (!confirm("Hide " + selected.length + " contacts? You can unhide them later from this page.")) return;

    try {
      const res = await adminFetch("/api/friends/contacts/auto-hide-bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds: selected }),
      });
      if (!res.ok) throw new Error("Hide failed");
      const data = await res.json();
      alert("Hidden " + data.hidden + " contacts.");
      // Re-scan to refresh list
      $("detect-bots-btn")?.click();
      invalidateCache("/api/friends");
    } catch (err) {
      alert("Failed to hide: " + err.message);
    }
  });

  $("load-hidden-btn")?.addEventListener("click", loadHiddenContacts);
}

function renderBotResults(candidates) {
  const container = $("bot-results");
  const list = $("bot-list");
  const countEl = $("bot-count");
  if (!container || !list) return;

  container.style.display = "";
  countEl.textContent = candidates.length === 0
    ? "No bots detected."
    : "Found " + candidates.length + " likely bot/automated contacts:";

  if (candidates.length === 0) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:12px;">All clear! No automated contacts detected.</div>';
    return;
  }

  list.innerHTML = candidates.map(function(c) {
    return '<div style="display:flex;align-items:flex-start;gap:10px;padding:8px;background:var(--surface2);border-radius:6px;margin-bottom:4px;">' +
      '<input type="checkbox" class="bot-checkbox" data-contact-id="' + esc(c.id) + '" checked style="margin-top:3px;">' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(c.name || c.id) + '</div>' +
        '<div style="font-size:10px;color:var(--text-dim);">' +
          c.total_messages + ' msgs (' + c.sent_messages + ' sent, ' + c.received_messages + ' received) · Score: ' + c.bot_score +
        '</div>' +
        '<div style="font-size:10px;color:#FFD54F;margin-top:2px;">' +
          c.reasons.map(function(r) { return esc(r); }).join(" · ") +
        '</div>' +
      '</div>' +
    '</div>';
  }).join("");
}

async function loadHiddenContacts() {
  const list = $("hidden-list");
  if (!list) return;
  list.style.display = "";
  list.innerHTML = '<div style="color:var(--text-dim);font-size:12px;">Loading...</div>';

  try {
    const res = await adminFetch("/api/friends/contacts/hidden");
    if (!res.ok) throw new Error("Failed to load");
    const contacts = await res.json();
    if (contacts.length === 0) {
      list.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:8px;">No hidden contacts.</div>';
      return;
    }
    list.innerHTML = contacts.map(function(c) {
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;background:var(--surface2);border-radius:4px;margin-bottom:3px;">' +
        '<span style="font-size:12px;">' + esc(c.name || c.id) + '</span>' +
        '<button class="unhide-btn" data-contact-id="' + esc(c.id) + '" style="font-size:10px;padding:2px 8px;background:none;border:1px solid var(--border);color:var(--text-dim);border-radius:4px;cursor:pointer;">Unhide</button>' +
      '</div>';
    }).join("");

    list.querySelectorAll(".unhide-btn").forEach(function(btn) {
      btn.addEventListener("click", async function() {
        const contactId = btn.dataset.contactId;
        try {
          await adminFetch("/api/friends/contacts/" + encodeURIComponent(contactId) + "/unhide", { method: "POST" });
          loadHiddenContacts();
          invalidateCache("/api/friends");
        } catch (err) {
          alert("Failed to unhide: " + err.message);
        }
      });
    });
  } catch (err) {
    list.innerHTML = '<div style="color:#f44;font-size:12px;">Failed to load hidden contacts.</div>';
  }
}
