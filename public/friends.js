// ── State ──

let contacts = [];
let groups = [];
let chats = [];
let selectedRecipients = new Set();
let currentSort = { field: "last_seen", dir: "desc" };

// ── Data cache for faster tab switching ──
const _cache = {};
const CACHE_TTL = 60000; // 1 minute
function cachedFetch(url, opts) {
  const key = url + (opts ? JSON.stringify(opts) : "");
  const cached = _cache[key];
  if (cached && Date.now() - cached.time < CACHE_TTL) return Promise.resolve(cached.response.clone());
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
  _initNameEditHandlers();

  // Load initial tab
  loadDashboard();

  // Prefetch other tabs' data in background after initial load
  setTimeout(() => {
    cachedFetch("/api/friends/contacts?sort=last_seen&dir=desc");
    cachedFetch("/api/friends/tiers");
    cachedFetch("/api/friends/groups");
  }, 2000);
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

  const saveNotesBtn = $("save-notes-btn");
  if (saveNotesBtn) {
    saveNotesBtn.addEventListener("click", async () => {
      const contactId = saveNotesBtn.dataset.contactId;
      const notes = $("contact-notes")?.value || "";
      if (!contactId) return;
      try {
        const res = await adminFetch("/api/friends/contacts/" + encodeURIComponent(contactId) + "/notes", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes }),
        });
        if (!res.ok) throw new Error("Failed to save notes");
        saveNotesBtn.textContent = "Saved!";
        setTimeout(() => { saveNotesBtn.textContent = "Save Notes"; }, 2000);
      } catch (err) {
        alert("Failed to save notes: " + err.message);
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
      html += data.results.map(r => {
        const tierBadge = r.tier_color && r.tier_name
          ? '<span class="ai-search-result-tier" style="background:' + esc(r.tier_color) + '22;color:' + esc(r.tier_color) + ';border:1px solid ' + esc(r.tier_color) + '44;">' + esc(r.tier_name) + '</span>'
          : '';
        return '<div class="ai-search-result" data-contact-id="' + esc(r.id) + '">' +
          '<div><span class="ai-search-result-name">' + esc(r.name || r.id) + '</span>' + tierBadge +
          (r.snippet ? '<div class="ai-search-result-meta">"...' + esc(r.snippet.substring(0, 100)) + '..."</div>' : '') +
          '</div>' +
          '<div class="ai-search-result-reason">' + esc(r.match_reason || r.match_source || "") + '</div>' +
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

async function loadDashboard() {
  try {
    const tierParam = dashboardTierFilter !== null ? "?tier=" + encodeURIComponent(dashboardTierFilter) : "";
    const res = await cachedFetch("/api/friends/dashboard" + tierParam);
    if (!res.ok) throw new Error("Server returned " + res.status);
    const data = await res.json();
    renderSummaryCards(data.stats, data.voiceTotal);
    renderWeeklyChart(data.weeklyVolume);
    renderHourlyChart(data.hourly);
    setupTopFriendsNav();
    loadTopFriends();
    renderReciprocity(data.reciprocity);
    renderStreaks(data.streaks);
    renderFastResponders(data.fastResponders);
    neglectedData = data.neglected || [];
    setupNeglectedNav();
    populateNeglectedFilters(neglectedData);
    filterAndRenderNeglected();
    renderInitiatorsList(data.topInitiators);
    renderTierPills(data.tierDistribution);
    loadDashboardTags();
    setupTagAllButton();
    // Calendar is now part of dashboard
    loadCalendar();
  } catch (err) {
    console.error("Failed to load dashboard:", err);
  }
}

// ── Dashboard Tag Cloud ──

let dashTagFilter = null; // currently selected tag name or null

async function loadDashboardTags() {
  try {
    const tagTierParam = dashboardTierFilter !== null ? "?tier=" + encodeURIComponent(dashboardTierFilter) : "";
    const res = await cachedFetch("/api/friends/tags" + tagTierParam);
    if (!res.ok) return;
    const tags = await res.json();
    renderDashboardTagCloud(tags);
  } catch (err) {
    console.error("Failed to load tags:", err);
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

// ── Neglected Friends (browsable + sortable) ──

function setupNeglectedNav() {
  if (negNavBound) return;
  negNavBound = true;
  document.querySelectorAll(".neg-window-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      negWindowDays = parseInt(btn.dataset.days);
      document.querySelectorAll(".neg-window-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      loadNeglected();
    });
  });
}

async function loadNeglected() {
  try {
    const res = await adminFetch("/api/friends/neglected?days=" + negWindowDays);
    if (!res.ok) throw new Error("Failed");
    const data = await res.json();
    neglectedData = data.contacts || [];
    populateNeglectedFilters(neglectedData);
    filterAndRenderNeglected();
  } catch (err) {
    console.error("Failed to load neglected:", err);
  }
}

function populateNeglectedFilters(data) {
  const groupSel = $("neg-group-filter");
  const tagSel = $("neg-tag-filter");
  if (groupSel) {
    const groups = new Set();
    data.forEach(c => (c.group_names || "").split(", ").filter(Boolean).forEach(g => groups.add(g)));
    groupSel.innerHTML = '<option value="">All Groups</option>' +
      [...groups].sort().map(g => '<option value="' + esc(g) + '">' + esc(g) + '</option>').join("");
  }
  if (tagSel) {
    const tags = new Set();
    data.forEach(c => (c.tag_names || "").split(", ").filter(Boolean).forEach(t => tags.add(t)));
    tagSel.innerHTML = '<option value="">All Tags</option>' +
      [...tags].sort().map(t => {
        const p = parseTagCategory(t);
        return '<option value="' + esc(t) + '">' + esc(p.label) + '</option>';
      }).join("");
  }
  if (groupSel && !groupSel.dataset.bound) {
    groupSel.addEventListener("change", filterAndRenderNeglected);
    groupSel.dataset.bound = "1";
  }
  if (tagSel && !tagSel.dataset.bound) {
    tagSel.addEventListener("change", filterAndRenderNeglected);
    tagSel.dataset.bound = "1";
  }
  const sortSel = $("neg-sort");
  if (sortSel && !sortSel.dataset.bound) {
    sortSel.addEventListener("change", filterAndRenderNeglected);
    sortSel.dataset.bound = "1";
  }
}

function filterAndRenderNeglected() {
  const container = $("neglected-list");
  if (!container) return;

  let filtered = [...neglectedData];
  const groupFilter = $("neg-group-filter")?.value;
  const tagFilter = $("neg-tag-filter")?.value;
  const sortMode = $("neg-sort")?.value || "days-silent";

  if (groupFilter) filtered = filtered.filter(c => (c.group_names || "").split(", ").includes(groupFilter));
  if (tagFilter) filtered = filtered.filter(c => (c.tag_names || "").split(", ").includes(tagFilter));

  if (sortMode === "days-silent") filtered.sort((a, b) => a.last_seen - b.last_seen);
  else if (sortMode === "days-silent-asc") filtered.sort((a, b) => b.last_seen - a.last_seen);
  else if (sortMode === "name") filtered.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  else if (sortMode === "total-messages") filtered.sort((a, b) => (b.total_messages || 0) - (a.total_messages || 0));
  else if (sortMode === "tier") filtered.sort((a, b) => {
    if (!a.tier_name && !b.tier_name) return 0;
    if (!a.tier_name) return 1;
    if (!b.tier_name) return -1;
    return a.tier_name.localeCompare(b.tier_name);
  });

  const countEl = $("neg-count");
  if (countEl) {
    const total = neglectedData.length;
    const shown = Math.min(filtered.length, 30);
    countEl.textContent = filtered.length === total
      ? "Showing " + shown + " of " + total
      : "Showing " + shown + " of " + filtered.length + " (filtered from " + total + ")";
  }

  if (filtered.length === 0) {
    container.innerHTML = '<div class="chart-empty">No neglected friends matching filters.</div>';
    return;
  }

  container.innerHTML = filtered.slice(0, 30).map(c => {
    const daysAgo = c.last_seen ? Math.floor((Date.now() / 1000 - c.last_seen) / 86400) : null;
    const label = daysAgo !== null ? daysAgo + "d ago" : "never";
    const tierDot = c.tier_color
      ? '<span class="neglected-tier-dot" style="background:' + esc(c.tier_color) + '"></span>' + esc(c.tier_name || "")
      : "";
    return '<div class="neglected-card" data-contact-id="' + esc(c.id) + '" style="cursor:pointer;">' +
      '<div class="neglected-card-info">' +
        '<span class="neglected-name">' + esc(c.name) + '</span>' +
        '<div class="neglected-meta">' +
          '<span class="neglected-time">' + esc(label) + '</span>' +
          (tierDot ? '<span>' + tierDot + '</span>' : '') +
          (c.total_messages ? '<span>' + c.total_messages + ' msgs</span>' : '') +
        '</div>' +
      '</div>' +
      '<button class="neglected-dismiss" title="Dismiss from neglected list" data-dismiss-id="' + esc(c.id) + '">&times;</button>' +
    '</div>';
  }).join("");

  container.querySelectorAll("[data-contact-id]").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("neglected-dismiss")) return;
      if (el.dataset.contactId) openContactDetail(el.dataset.contactId);
    });
  });
  container.querySelectorAll(".neglected-dismiss").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.dismissId;
      if (!id) return;
      try {
        await adminFetch("/api/friends/contacts/" + encodeURIComponent(id) + "/dismiss-neglected", { method: "POST" });
        neglectedData = neglectedData.filter(c => c.id !== id);
        filterAndRenderNeglected();
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
      '<div class="initiator-name">' + esc(item.name) + '</div>' +
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

  try {
    const tfTierParam = dashboardTierFilter !== null ? "&tier=" + encodeURIComponent(dashboardTierFilter) : "";
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
  } catch (err) {
    if (container) container.innerHTML = '<div class="chart-empty">Failed to load.</div>';
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

// ── Reciprocity (Message Balance) ──

let reciprocityData = [];

function renderReciprocity(data) {
  reciprocityData = data || [];
  populateRecipFilters(reciprocityData);
  filterAndRenderReciprocity();
}

function populateRecipFilters(data) {
  const groupSel = $("recip-group-filter");
  const tagSel = $("recip-tag-filter");
  if (groupSel) {
    const groups = new Set();
    data.forEach(r => (r.group_names || "").split(", ").filter(Boolean).forEach(g => groups.add(g)));
    groupSel.innerHTML = '<option value="">All Groups</option>' +
      [...groups].sort().map(g => '<option value="' + esc(g) + '">' + esc(g) + '</option>').join("");
  }
  if (tagSel) {
    const tags = new Set();
    data.forEach(r => (r.tag_names || "").split(", ").filter(Boolean).forEach(t => tags.add(t)));
    tagSel.innerHTML = '<option value="">All Tags</option>' +
      [...tags].sort().map(t => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join("");
  }
  // Attach change listeners (only once)
  if (!groupSel?.dataset.bound) {
    groupSel?.addEventListener("change", filterAndRenderReciprocity);
    if (groupSel) groupSel.dataset.bound = "1";
  }
  if (!tagSel?.dataset.bound) {
    tagSel?.addEventListener("change", filterAndRenderReciprocity);
    if (tagSel) tagSel.dataset.bound = "1";
  }
  const sortSel = $("recip-sort");
  if (sortSel && !sortSel.dataset.bound) {
    sortSel.addEventListener("change", filterAndRenderReciprocity);
    sortSel.dataset.bound = "1";
  }
}

function filterAndRenderReciprocity() {
  const container = $("reciprocity-list");
  if (!container) return;

  let filtered = [...reciprocityData];
  const groupFilter = $("recip-group-filter")?.value;
  const tagFilter = $("recip-tag-filter")?.value;
  const sortMode = $("recip-sort")?.value || "balance";

  if (groupFilter) {
    filtered = filtered.filter(r => (r.group_names || "").includes(groupFilter));
  }
  if (tagFilter) {
    filtered = filtered.filter(r => (r.tag_names || "").includes(tagFilter));
  }

  if (sortMode === "balance") {
    filtered.sort((a, b) => b.ratio - a.ratio);
  } else if (sortMode === "most-sent") {
    filtered.sort((a, b) => b.sent - a.sent);
  } else if (sortMode === "most-received") {
    filtered.sort((a, b) => b.received - a.received);
  } else if (sortMode === "least-active") {
    filtered.sort((a, b) => (a.sent + a.received) - (b.sent + b.received));
  } else if (sortMode === "worst-balance") {
    filtered.sort((a, b) => a.ratio - b.ratio);
  } else if (sortMode === "name") {
    filtered.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  } else {
    filtered.sort((a, b) => (b.sent + b.received) - (a.sent + a.received));
  }

  if (filtered.length === 0) {
    container.innerHTML = '<div class="chart-empty">No data matching filters.</div>';
    return;
  }

  container.innerHTML = filtered.slice(0, 15).map(r => {
    const total = r.sent + r.received || 1;
    const sentPct = Math.round((r.sent / total) * 100);
    const recvPct = 100 - sentPct;
    return '<div class="recip-row" data-contact-id="' + esc(r.id) + '" style="cursor:pointer;">' +
      '<div class="recip-name">' + esc(r.name) + '</div>' +
      '<div class="recip-bar">' +
        '<div class="recip-bar-sent" style="width:' + sentPct + '%" title="Sent: ' + r.sent + '"></div>' +
        '<div class="recip-bar-received" style="width:' + recvPct + '%" title="Received: ' + r.received + '"></div>' +
      '</div>' +
      '<div class="recip-pct">' + r.ratio + '%</div>' +
    '</div>';
  }).join("") +
  '<div style="font-size:10px;color:var(--text-dim);margin-top:8px;display:flex;gap:12px;">' +
    '<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--accent);margin-right:3px;"></span>Sent</span>' +
    '<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--green);margin-right:3px;"></span>Received</span>' +
    '<span style="margin-left:auto;">% = balance (100=perfect)</span>' +
  '</div>';

  // Make rows clickable
  container.querySelectorAll(".recip-row[data-contact-id]").forEach(row => {
    row.addEventListener("click", () => {
      const id = row.dataset.contactId;
      if (id) openContactDetail(id);
    });
  });
}

// ── Streaks ──

function renderStreaks(data) {
  const container = $("streaks-list");
  if (!container) return;
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="chart-empty">No data yet.</div>';
    return;
  }
  container.innerHTML = data.map(s => {
    return '<div class="streak-row" data-contact-id="' + esc(s.id) + '" style="cursor:pointer;">' +
      '<div class="streak-name">' + esc(s.name) + '</div>' +
      (s.current_streak > 0
        ? '<span class="streak-badge active">\uD83D\uDD25 ' + s.current_streak + 'd</span>'
        : '') +
      '<span class="streak-badge record">\uD83C\uDFC6 ' + s.longest_streak + 'd best</span>' +
    '</div>';
  }).join("");
  container.querySelectorAll("[data-contact-id]").forEach(el => {
    el.addEventListener("click", () => { if (el.dataset.contactId) openContactDetail(el.dataset.contactId); });
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
      '<div class="fast-name">' + esc(f.name) + '</div>' +
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

async function openContactDetail(contactId) {
  const panel = $("detail-panel");
  const overlay = $("detail-overlay");
  if (!panel || !overlay) return;

  panel.classList.add("open");
  overlay.classList.add("open");

  // Show loading state
  const nameEl = $("detail-name");
  if (nameEl) nameEl.textContent = "Loading...";

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
    const stats = detailData.stats;

    // Populate detail panel with editable name
    const displayName = contact.name || "Unknown";
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

    const detailStats = $("detail-stats");
    if (detailStats) {
      const myResp = stats.my_avg_response_sec ? formatDuration(stats.my_avg_response_sec) : "--";
      const theirResp = stats.their_avg_response_sec ? formatDuration(stats.their_avg_response_sec) : "--";
      detailStats.innerHTML =
        '<div class="detail-stat">' +
          '<div class="value">' + (stats.total_messages ?? 0) + '</div>' +
          '<div class="label">Total Messages</div>' +
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

    // Voice stats
    const detailVoice = $("detail-voice-stats");
    if (detailVoice && detailData.voiceStats) {
      const vs = detailData.voiceStats;
      if (vs.total_notes > 0) {
        detailVoice.innerHTML =
          '<div class="voice-stat-item"><div class="val">' + vs.total_notes + '</div><div class="lbl">Voice Notes</div></div>' +
          '<div class="voice-stat-item"><div class="val">' + vs.total_minutes + '</div><div class="lbl">Minutes</div></div>' +
          '<div class="voice-stat-item"><div class="val">' + vs.sent_notes + '</div><div class="lbl">Sent</div></div>' +
          '<div class="voice-stat-item"><div class="val">' + vs.received_notes + '</div><div class="lbl">Received</div></div>';
      } else {
        detailVoice.innerHTML = '';
      }
    }

    // Notes
    const notesEl = $("contact-notes");
    if (notesEl) notesEl.value = contact.notes || "";
    const saveBtn = $("save-notes-btn");
    if (saveBtn) saveBtn.dataset.contactId = contactId;

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
  } catch (err) {
    console.error("Failed to load contact detail:", err);
    if (nameEl) nameEl.textContent = "Error loading contact";
  }
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
          esc(c.name) +
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
    '<div class="chip-name">' + esc(c.name) + '</div>' +
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
      esc(c.name) +
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

// ── Graph Visualization ──

let graphInstance = null;
let graphData = null;

async function loadGraph() {
  const container = $("graph-container");
  const loading = $("graph-loading");
  if (!container) return;
  if (loading) loading.textContent = "Loading graph data...";

  try {
    const minMsgs = $("graph-min-messages")?.value || "50";
    const res = await cachedFetch("/api/friends/graph?minMessages=" + minMsgs);
    if (!res.ok) throw new Error("Failed to load graph");
    graphData = await res.json();

    if (loading) loading.style.display = "none";
    renderGraph(graphData);
  } catch (err) {
    console.error("Failed to load graph:", err);
    if (loading) loading.textContent = "Failed to load graph: " + err.message;
  }
}

function renderGraph(data) {
  const container = $("graph-container");
  if (!container || !data || !data.nodes.length) return;

  // Clean up previous instance
  if (graphInstance) { graphInstance.kill(); graphInstance = null; }

  // Build graphology graph
  const Graph = graphology;
  const graph = new Graph();

  // Default tier colors
  const defaultColors = ["#4fc3f7", "#81c784", "#ffb74d", "#f06292", "#ba68c8", "#00b894", "#e17055"];
  const tierFilter = $("graph-tier-filter")?.value || "all";

  // Filter by tier
  const filteredNodes = tierFilter === "all"
    ? data.nodes
    : data.nodes.filter(n => tierFilter === "none" ? !n.tierId : String(n.tierId) === tierFilter);

  const nodeIds = new Set(filteredNodes.map(n => n.id));

  // Add nodes
  for (const n of filteredNodes) {
    const size = Math.max(3, Math.min(20, Math.sqrt(n.messages) / 2));
    const color = n.tierColor || "#555";
    const now = Math.floor(Date.now() / 1000);
    const daysSinceContact = (now - (n.lastSeen || 0)) / 86400;
    const alpha = daysSinceContact < 7 ? 1 : daysSinceContact < 30 ? 0.8 : daysSinceContact < 90 ? 0.5 : 0.3;

    graph.addNode(n.id, {
      label: n.name || n.id.split("@")[0],
      size,
      color: color + Math.round(alpha * 255).toString(16).padStart(2, "0"),
      x: Math.random() * 100,
      y: Math.random() * 100,
      // Custom data for tooltips
      _data: n
    });
  }

  // Add edges (only between visible nodes)
  let edgeIdx = 0;
  for (const e of data.edges) {
    if (nodeIds.has(e.source) && nodeIds.has(e.target)) {
      try {
        graph.addEdge(e.source, e.target, {
          size: Math.min(3, e.weight),
          color: "rgba(255,255,255,0.08)"
        });
      } catch { /* duplicate edge */ }
      edgeIdx++;
    }
  }

  // Layout
  const layout = $("graph-layout")?.value || "force";
  if (layout === "concentric") {
    // Concentric layout by tier
    const tiers = {};
    filteredNodes.forEach(n => {
      const key = n.tierId || "none";
      if (!tiers[key]) tiers[key] = [];
      tiers[key].push(n.id);
    });
    const tierKeys = Object.keys(tiers).sort((a, b) => (a === "none" ? 999 : parseInt(a)) - (b === "none" ? 999 : parseInt(b)));
    tierKeys.forEach((tk, ring) => {
      const members = tiers[tk];
      const radius = 30 + ring * 40;
      members.forEach((id, i) => {
        const angle = (2 * Math.PI * i) / members.length;
        graph.setNodeAttribute(id, "x", Math.cos(angle) * radius);
        graph.setNodeAttribute(id, "y", Math.sin(angle) * radius);
      });
    });
  } else {
    // Force-directed layout using ForceAtlas2
    if (typeof ForceAtlas2 !== "undefined" && ForceAtlas2.assign) {
      ForceAtlas2.assign(graph, {
        iterations: 100,
        settings: {
          gravity: 1,
          scalingRatio: 10,
          barnesHutOptimize: graph.order > 500,
          strongGravityMode: true,
          slowDown: 5
        }
      });
    }
  }

  // Create Sigma renderer
  graphInstance = new Sigma(graph, container, {
    renderEdgeLabels: false,
    labelFont: "sans-serif",
    labelSize: 11,
    labelColor: { color: "#ccc" },
    labelRenderedSizeThreshold: 8,
    defaultEdgeType: "line",
    minCameraRatio: 0.1,
    maxCameraRatio: 10
  });

  // Tooltip on hover
  const tooltip = $("graph-tooltip");
  graphInstance.on("enterNode", ({ node }) => {
    const attrs = graph.getNodeAttributes(node);
    const d = attrs._data;
    if (!d || !tooltip) return;
    const tierBadge = d.tierName ? '<span style="background:' + (d.tierColor || "#555") + '22;color:' + (d.tierColor || "#555") + ';padding:1px 6px;border-radius:3px;font-size:10px;">' + d.tierName + '</span>' : '';
    tooltip.innerHTML =
      '<strong>' + (d.name || d.id) + '</strong> ' + tierBadge + '<br>' +
      '<span style="color:var(--text-dim);">' + d.messages + ' messages (' + d.messages30d + ' last 30d)</span><br>' +
      (d.tags.length > 0 ? '<span style="color:var(--accent);font-size:10px;">' + d.tags.slice(0, 5).join(", ") + '</span><br>' : '') +
      (d.groups.length > 0 ? '<span style="color:var(--text-dim);font-size:10px;">Groups: ' + d.groups.slice(0, 3).join(", ") + '</span>' : '');
    tooltip.style.display = "block";
  });

  graphInstance.on("leaveNode", () => {
    if (tooltip) tooltip.style.display = "none";
  });

  // Move tooltip with mouse
  container.addEventListener("mousemove", (e) => {
    if (tooltip && tooltip.style.display !== "none") {
      const rect = container.getBoundingClientRect();
      tooltip.style.left = (e.clientX - rect.left + 15) + "px";
      tooltip.style.top = (e.clientY - rect.top + 15) + "px";
    }
  });

  // Click to open contact detail
  graphInstance.on("clickNode", ({ node }) => {
    openContactDetail(node);
  });

  // Search highlight
  const searchInput = $("graph-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.toLowerCase().trim();
      graph.forEachNode((node, attrs) => {
        const match = !q || (attrs.label && attrs.label.toLowerCase().includes(q));
        graph.setNodeAttribute(node, "hidden", !match && q.length > 0);
      });
      graphInstance.refresh();
    });
  }

  // Legend
  const legend = $("graph-legend");
  if (legend) {
    const tierColors = {};
    filteredNodes.forEach(n => {
      if (n.tierName && n.tierColor) tierColors[n.tierName] = n.tierColor;
    });
    legend.innerHTML = Object.entries(tierColors).map(([name, color]) =>
      '<span class="graph-legend-item"><span class="graph-legend-dot" style="background:' + color + ';"></span>' + name + '</span>'
    ).join("") + '<span class="graph-legend-item"><span class="graph-legend-dot" style="background:#555;"></span>Unassigned</span>';
  }

  // Populate tier filter
  const tierSelect = $("graph-tier-filter");
  if (tierSelect && tierSelect.options.length <= 1) {
    const tiers = {};
    data.nodes.forEach(n => { if (n.tierName) tiers[n.tierId] = n.tierName; });
    for (const [id, name] of Object.entries(tiers)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      tierSelect.appendChild(opt);
    }
    const noneOpt = document.createElement("option");
    noneOpt.value = "none";
    noneOpt.textContent = "Unassigned";
    tierSelect.appendChild(noneOpt);
  }
}

function setupGraphHandlers() {
  const tierFilter = $("graph-tier-filter");
  const layoutSelect = $("graph-layout");
  const minMsgSelect = $("graph-min-messages");

  if (tierFilter) tierFilter.addEventListener("change", () => { if (graphData) renderGraph(graphData); });
  if (layoutSelect) layoutSelect.addEventListener("change", () => { if (graphData) renderGraph(graphData); });
  if (minMsgSelect) minMsgSelect.addEventListener("change", () => { invalidateCache("/api/friends/graph"); loadGraph(); });
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
  const id = c.id || "";
  const phonePart = id.split("@")[0];
  if (phonePart && /^\d{7,15}$/.test(phonePart)) {
    return "+" + phonePart;
  }
  return c.name || "Unknown";
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
