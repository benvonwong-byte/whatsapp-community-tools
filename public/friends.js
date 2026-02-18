// ── State ──

let contacts = [];
let groups = [];
let chats = [];
let selectedRecipients = new Set();
let currentSort = { field: "last_seen", dir: "desc" };
let weeklyChart = null;
let hourlyChart = null;
let detailChart = null;
let sendPollTimer = null;
let searchDebounceTimer = null;
let activeTagFilters = new Set();
let tagFilterMode = "OR";
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth() + 1;

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
  _initNameEditHandlers();

  // Load initial tab
  loadDashboard();
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

async function loadDashboard() {
  try {
    const res = await adminFetch("/api/friends/dashboard");
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
    renderNeglectedList(data.neglected);
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
    const res = await adminFetch("/api/friends/tags");
    if (!res.ok) return;
    const tags = await res.json();
    renderDashboardTagCloud(tags);
  } catch (err) {
    console.error("Failed to load tags:", err);
  }
}

function renderDashboardTagCloud(tags) {
  const container = $("dash-tag-cloud");
  if (!container) return;
  if (!tags || tags.length === 0) {
    container.innerHTML = '<span class="chart-empty">No tags yet. Use "AI Tag All" to auto-tag contacts from conversations.</span>';
    return;
  }

  container.innerHTML = tags.slice(0, 40).map(t => {
    const p = parseTagCategory(t.name);
    const active = dashTagFilter === t.name ? ' active' : '';
    return '<span class="dash-tag' + active + '" data-tag="' + esc(t.name) + '" ' +
      'style="background:' + p.color + '18;color:' + p.color + ';border-color:' + (dashTagFilter === t.name ? p.color : 'transparent') + ';">' +
      esc(p.label) +
      ' <span class="tag-count">' + t.contact_count + '</span>' +
    '</span>';
  }).join("");

  container.querySelectorAll(".dash-tag").forEach(chip => {
    chip.addEventListener("click", () => {
      const tag = chip.dataset.tag;
      if (dashTagFilter === tag) {
        dashTagFilter = null; // deselect
      } else {
        dashTagFilter = tag;
      }
      renderDashboardTagCloud(tags);
      // Switch to contacts tab with tag filter applied
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
  container.innerHTML = distribution.map(d =>
    '<div class="tier-pill">' +
      '<span class="dot" style="background:' + esc(d.tier_color || '#666') + '"></span>' +
      '<span>' + esc(d.tier_name || 'Unassigned') + '</span>' +
      '<span class="count">' + d.count + '</span>' +
    '</div>'
  ).join("");
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

function renderNeglectedList(contactsList) {
  const container = $("neglected-list");
  if (!container) return;
  if (!contactsList || contactsList.length === 0) {
    container.innerHTML = '<div class="empty-state">No neglected contacts</div>';
    return;
  }
  container.innerHTML = contactsList.map((c) => {
    const daysAgo = c.last_seen ? Math.floor((Date.now() / 1000 - c.last_seen) / 86400) : null;
    const label = daysAgo !== null ? daysAgo + " days ago" : "never";
    return '<div class="neglected-card" data-contact-id="' + esc(c.id) + '" style="cursor:pointer;">' +
      '<span class="neglected-name">' + esc(c.name) + '</span>' +
      '<span class="neglected-time">' + esc(label) + '</span>' +
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
        btn.closest(".neglected-card")?.remove();
        if (container.querySelectorAll(".neglected-card").length === 0) {
          container.innerHTML = '<div class="empty-state">No neglected contacts</div>';
        }
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
    const res = await adminFetch("/api/friends/top-friends?days=" + tfWindowDays + "&offset=" + tfOffsetDays + "&limit=10");
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
    return '<div class="top-friend-row" data-contact-id="' + esc(String(f.id)) + '" style="cursor:pointer;">' +
      '<div class="top-friend-rank ' + rankClass + '">' + (i + 1) + '</div>' +
      '<div class="top-friend-info">' +
        '<div class="top-friend-name">' + esc(f.name) + '</div>' +
        tagsHtml +
      '</div>' +
      '<div>' +
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
    // Load groups, tiers, and tags for filter dropdowns
    const [groupsRes, tiersRes, tagsRes] = await Promise.all([
      adminFetch("/api/friends/groups"),
      adminFetch("/api/friends/tiers"),
      adminFetch("/api/friends/tags"),
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
    return '<tr class="contact-row" data-id="' + esc(String(c.id)) + '">' +
      '<td class="contact-name-cell"><strong>' + esc(c.name) + '</strong>' + (tagChips ? '<div style="margin-top:2px;">' + tagChips + '</div>' : '') + '</td>' +
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
    // Fetch contact detail and activity in parallel
    const [detailRes, activityRes] = await Promise.all([
      adminFetch("/api/friends/contacts/" + encodeURIComponent(contactId)),
      adminFetch("/api/friends/contacts/" + encodeURIComponent(contactId) + "/activity?granularity=week"),
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

    // Phone number (extracted from contact ID)
    const phoneEl = $("detail-phone");
    if (phoneEl) {
      const phone = contactId.includes("@") ? contactId.split("@")[0] : "";
      if (phone && /^\d+$/.test(phone)) {
        phoneEl.textContent = "+" + phone;
        phoneEl.href = "tel:+" + phone;
        phoneEl.style.display = "";
      } else {
        phoneEl.style.display = "none";
      }
    }

    setupNameEditing(contactId, displayName);

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
  } catch (err) {
    console.error("Failed to load contact detail:", err);
    if (nameEl) nameEl.textContent = "Error loading contact";
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

function renderDetailTags(contactId, tags) {
  const container = $("detail-tags");
  if (!container) return;

  let html = tags.map((t) => {
    const { label, color } = parseTagCategory(t.name);
    return '<span class="detail-tag" data-tag-id="' + t.tag_id + '" style="background:' + color + '20;color:' + color + ';border:1px solid ' + color + '40;">' +
      esc(label) +
      (t.mention_count > 1 ? ' <small>(' + t.mention_count + ')</small>' : '') +
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

function renderTierLanes(tiersList, allContacts) {
  const container = $("tier-lanes");
  if (!container) return;

  const byTier = {};
  const unassigned = [];
  allContacts.forEach(c => {
    if (c.tier_id) {
      if (!byTier[c.tier_id]) byTier[c.tier_id] = [];
      byTier[c.tier_id].push(c);
    } else {
      unassigned.push(c);
    }
  });

  let html = '';

  tiersList.forEach(t => {
    const members = byTier[t.id] || [];
    html += '<div class="group-lane" data-tier-id="' + esc(String(t.id)) + '">' +
      '<div class="group-lane-header">' +
        '<span class="color-dot" style="background:' + esc(t.color || '#4fc3f7') + '"></span>' +
        '<span class="lane-title">' + esc(t.name) + '</span>' +
        '<span class="lane-count">' + members.length + '</span>' +
        '<button class="lane-btn" data-action="edit-tier" data-tier-id="' + esc(String(t.id)) + '" title="Edit">&#9998;</button>' +
        '<button class="lane-btn delete" data-action="delete-tier" data-tier-id="' + esc(String(t.id)) + '" title="Delete">&#128465;</button>' +
      '</div>' +
      '<div class="group-lane-body tier-drop-zone" data-tier-id="' + esc(String(t.id)) + '">' +
        members.map(c =>
          '<div class="contact-chip" draggable="true" data-contact-id="' + esc(String(c.id)) + '" data-source-tier="' + esc(String(t.id)) + '">' +
            '<div class="chip-name">' + esc(c.name) + '</div>' +
            '<div class="chip-meta">' + (c.messages_30d || 0) + ' msgs / 30d</div>' +
          '</div>'
        ).join("") +
      '</div>' +
    '</div>';
  });

  html += '<div class="group-lane ungrouped-lane" data-tier-id="unassigned">' +
    '<div class="group-lane-header">' +
      '<span class="color-dot" style="background:#666"></span>' +
      '<span class="lane-title">Unassigned</span>' +
      '<span class="lane-count">' + unassigned.length + '</span>' +
    '</div>' +
    '<div class="group-lane-body tier-drop-zone" data-tier-id="unassigned">' +
      unassigned.map(c =>
        '<div class="contact-chip" draggable="true" data-contact-id="' + esc(String(c.id)) + '" data-source-tier="unassigned">' +
          '<div class="chip-name">' + esc(c.name) + '</div>' +
          '<div class="chip-meta">' + (c.messages_30d || 0) + ' msgs / 30d</div>' +
        '</div>'
      ).join("") +
    '</div>' +
  '</div>';

  container.innerHTML = html;

  container.querySelectorAll('[data-action="edit-tier"]').forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const tid = parseInt(btn.dataset.tierId);
      const tier = tiersList.find(t => t.id === tid);
      if (tier) openTierModal(tier);
    });
  });

  container.querySelectorAll('[data-action="delete-tier"]').forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      deleteTier(btn.dataset.tierId);
    });
  });

  setupTierDragAndDrop();
}

function setupTierDragAndDrop() {
  const chips = document.querySelectorAll("#tier-lanes .contact-chip[draggable]");
  const zones = document.querySelectorAll(".tier-drop-zone");

  chips.forEach(chip => {
    chip.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/plain", JSON.stringify({
        contactId: chip.dataset.contactId,
        sourceTier: chip.dataset.sourceTier,
      }));
      chip.classList.add("dragging");
    });
    chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
  });

  zones.forEach(zone => {
    zone.addEventListener("dragover", e => {
      e.preventDefault();
      zone.closest(".group-lane").classList.add("drag-over");
    });
    zone.addEventListener("dragleave", () => {
      zone.closest(".group-lane").classList.remove("drag-over");
    });
    zone.addEventListener("drop", async e => {
      e.preventDefault();
      zone.closest(".group-lane").classList.remove("drag-over");
      try {
        const payload = JSON.parse(e.dataTransfer.getData("text/plain"));
        const targetTier = zone.dataset.tierId;
        if (targetTier === payload.sourceTier) return;
        const tierId = targetTier === "unassigned" ? null : parseInt(targetTier);
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
  const createBtn = $("create-tier-btn");
  if (createBtn) createBtn.addEventListener("click", () => openTierModal());

  const saveBtn = $("tier-modal-save");
  if (saveBtn) saveBtn.addEventListener("click", saveTier);

  const cancelBtn = $("tier-modal-cancel");
  if (cancelBtn) cancelBtn.addEventListener("click", closeTierModal);

  const modal = $("tier-modal");
  if (modal) modal.addEventListener("click", e => { if (e.target === modal) closeTierModal(); });
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
    const res = await adminFetch("/api/friends/calendar?year=" + calYear + "&month=" + calMonth);
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

    const maxVisible = 4;
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

// ── Utility Functions ──

function esc(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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
