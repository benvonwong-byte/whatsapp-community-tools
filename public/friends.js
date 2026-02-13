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

function adminFetch(path, opts = {}) {
  const separator = path.includes("?") ? "&" : "?";
  return fetch(
    `${API_BASE}${path}${separator}token=${encodeURIComponent(adminToken)}`,
    opts
  );
}

const $ = (id) => document.getElementById(id);

// ── State ──

let contacts = [];
let groups = [];
let chats = [];
let selectedRecipients = new Set();
let currentSort = { field: "last_seen", dir: "desc" };
let weeklyChart = null;
let detailChart = null;
let sendPollTimer = null;
let searchDebounceTimer = null;

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
      else if (target === "groups") loadGroups();
      else if (target === "messaging") loadMessagingRecipients();
      else if (target === "chats") loadChats();
    });
  });

  // Button handlers
  setupScanButton();
  setupBackfillButton();
  setupDetailPanel();
  setupContactFilters();
  setupMessagingHandlers();

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
      btn.textContent = "Backfill Messages";
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
}

// ── Dashboard Tab ──

async function loadDashboard() {
  try {
    const res = await adminFetch("/api/friends/dashboard");
    if (!res.ok) throw new Error("Server returned " + res.status);
    const data = await res.json();
    renderSummaryCards(data.stats);
    renderWeeklyChart(data.weeklyVolume);
    renderNeglectedList(data.neglected);
    renderInitiatorsList(data.topInitiators);
  } catch (err) {
    console.error("Failed to load dashboard:", err);
  }
}

function renderSummaryCards(stats) {
  const container = $("summary-cards");
  if (!container || !stats) return;
  container.innerHTML = [
    { label: "Total Contacts", value: stats.totalContacts ?? 0 },
    { label: "Active (30d)", value: stats.active30d ?? 0 },
    { label: "Groups", value: stats.groupCount ?? 0 },
    { label: "Messages This Week", value: stats.messagesThisWeek ?? 0 },
  ].map((card) =>
    '<div class="summary-card">' +
      '<div class="summary-card-value">' + esc(String(card.value)) + '</div>' +
      '<div class="summary-card-label">' + esc(card.label) + '</div>' +
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
    return '<div class="neglected-card">' +
      '<span class="neglected-name">' + esc(c.name) + '</span>' +
      '<span class="neglected-time">' + esc(label) + '</span>' +
    '</div>';
  }).join("");
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
    return '<div class="initiator-row">' +
      '<div class="initiator-name">' + esc(item.name) + '</div>' +
      '<div class="initiator-bar">' +
        '<div class="initiator-bar-me" style="width:' + myPct + '%"></div>' +
        '<div class="initiator-bar-them" style="width:' + theirPct + '%"></div>' +
      '</div>' +
      '<div class="initiator-labels">' +
        '<span>Me: ' + myInit + '</span>' +
        '<span>Them: ' + theirInit + '</span>' +
      '</div>' +
    '</div>';
  }).join("");
}

// ── Contacts Tab ──

async function loadContacts() {
  try {
    // Load groups for filter dropdown
    const groupsRes = await adminFetch("/api/friends/groups");
    if (groupsRes.ok) {
      groups = await groupsRes.json();
      populateGroupFilter();
    }

    const params = new URLSearchParams();
    params.set("sort", currentSort.field);
    params.set("dir", currentSort.dir);

    const groupFilter = $("filter-group");
    if (groupFilter && groupFilter.value) params.set("group", groupFilter.value);

    const qualityFilter = $("filter-quality");
    if (qualityFilter && qualityFilter.value) params.set("minScore", qualityFilter.value);

    const searchInput = $("contact-search");
    if (searchInput && searchInput.value.trim()) params.set("search", searchInput.value.trim());

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
    return '<tr class="contact-row" data-id="' + esc(String(c.id)) + '">' +
      '<td class="contact-name-cell"><strong>' + esc(c.name) + '</strong></td>' +
      '<td>' + esc(c.group_names || "") + '</td>' +
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

    // Populate detail panel
    if (nameEl) nameEl.textContent = contact.name || "Unknown";

    const detailStats = $("detail-stats");
    if (detailStats) {
      const myResp = stats.my_avg_response_sec ? formatDuration(stats.my_avg_response_sec) : "--";
      const theirResp = stats.their_avg_response_sec ? formatDuration(stats.their_avg_response_sec) : "--";
      detailStats.innerHTML =
        '<div class="detail-stat">' +
          '<div class="detail-stat-value">' + (stats.total_messages ?? 0) + '</div>' +
          '<div class="detail-stat-label">Total Messages</div>' +
        '</div>' +
        '<div class="detail-stat">' +
          '<div class="detail-stat-value">' + (stats.sent_messages ?? 0) + '</div>' +
          '<div class="detail-stat-label">Sent</div>' +
        '</div>' +
        '<div class="detail-stat">' +
          '<div class="detail-stat-value">' + (stats.received_messages ?? 0) + '</div>' +
          '<div class="detail-stat-label">Received</div>' +
        '</div>' +
        '<div class="detail-stat">' +
          '<div class="detail-stat-value">' + (stats.initiation_ratio != null ? Math.round(stats.initiation_ratio) + "%" : "--") + '</div>' +
          '<div class="detail-stat-label">My Initiation %</div>' +
        '</div>' +
        '<div class="detail-stat">' +
          '<div class="detail-stat-value">' + myResp + '</div>' +
          '<div class="detail-stat-label">My Avg Response</div>' +
        '</div>' +
        '<div class="detail-stat">' +
          '<div class="detail-stat-value">' + theirResp + '</div>' +
          '<div class="detail-stat-label">Their Avg Response</div>' +
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

// ── Groups Tab ──

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

  // Add "Create Group" button
  html += '<div class="group-actions-bar">' +
    '<button id="create-group-btn" class="btn btn-primary">+ New Group</button>' +
  '</div>';

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

  // Setup event handlers
  const createBtn = $("create-group-btn");
  if (createBtn) createBtn.addEventListener("click", () => createGroupModal());

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
    return '<div class="chat-card">' +
      '<div class="chat-card-info">' + label + '</div>' +
      '<label class="toggle-switch">' +
        '<input type="checkbox" class="chat-monitor-toggle" data-chat-id="' + esc(chat.chat_id) + '"' + (chat.monitored ? " checked" : "") + ' />' +
        '<span class="toggle-slider"></span>' +
      '</label>' +
    '</div>';
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
