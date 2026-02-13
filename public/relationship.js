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

// ── State ──
let dashboardData = null;
let refreshTimer = null;
let expandedCards = new Set();
let analyzePollTimer = null;

// Date range state
let dateRange = { startDate: null, endDate: null, preset: "30" };

function toDateStr(d) { return d.toISOString().split("T")[0]; }

function setPresetRange(days) {
  dateRange.preset = String(days);
  if (days === "all") {
    dateRange.startDate = null;
    dateRange.endDate = null;
  } else {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - parseInt(days));
    dateRange.startDate = toDateStr(start);
    dateRange.endDate = toDateStr(end);
  }
  syncDateInputs();
  updateChipHighlight();
  loadDashboard();
}

function syncDateInputs() {
  const s = $("range-start");
  const e = $("range-end");
  if (s && e) { s.value = dateRange.startDate || ""; e.value = dateRange.endDate || ""; }
}

function updateChipHighlight() {
  document.querySelectorAll(".range-chip").forEach((c) => {
    c.classList.toggle("active", c.dataset.range === dateRange.preset);
  });
}

function buildDashboardUrl() {
  let url = "/api/relationship/dashboard";
  if (dateRange.startDate && dateRange.endDate) {
    url += `?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}`;
  }
  return url;
}

// ── Init ──

document.addEventListener("DOMContentLoaded", () => {
  if (!isAdmin) {
    $("login-gate")?.classList.remove("hidden");
    $("analyze-btn")?.classList.add("hidden");
    return;
  }

  $("main-content")?.classList.remove("hidden");
  setPresetRange("30");
  setupDateRangeControls();
  setupAnalyzeButton();
  setupBackfillButton();
  setupImportButton();
  loadDashboard();
  refreshTimer = setInterval(loadDashboard, 60000);
});

// ── Date Range Controls ──

function setupDateRangeControls() {
  document.querySelectorAll(".range-chip").forEach((chip) => {
    chip.addEventListener("click", () => setPresetRange(chip.dataset.range));
  });
  const s = $("range-start");
  const e = $("range-end");
  if (!s || !e) return;
  function onCustom() {
    if (s.value && e.value) {
      dateRange.startDate = s.value;
      dateRange.endDate = e.value;
      dateRange.preset = "custom";
      updateChipHighlight();
      loadDashboard();
    }
  }
  s.addEventListener("change", onCustom);
  e.addEventListener("change", onCustom);
}

// ── Data Loading ──

async function loadDashboard() {
  try {
    const res = await adminFetch(buildDashboardUrl());
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    dashboardData = await res.json();
    renderDashboard();
  } catch (err) {
    console.error("Failed to load dashboard:", err);
    $("loading-state")?.classList.add("hidden");
    const errEl = $("error-state");
    if (errEl) {
      errEl.textContent = `Failed to load dashboard: ${err.message}`;
      errEl.classList.remove("hidden");
    }
  }
}

// ── Analyze: async with progress polling ──

function setupAnalyzeButton() {
  const btn = $("analyze-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Starting...";

    try {
      const res = await adminFetch("/api/relationship/analyze", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server returned ${res.status}`);
      }
      showAnalyzeProgress();
      startAnalyzePoll();
    } catch (err) {
      alert("Failed to start analysis: " + err.message);
      btn.disabled = false;
      btn.textContent = "Analyze Now";
    }
  });

  // Check once on load in case analysis is already running
  pollAnalyzeStatus();
}

function startAnalyzePoll() {
  if (analyzePollTimer) return;
  analyzePollTimer = setInterval(pollAnalyzeStatus, 2000);
}

function stopAnalyzePoll() {
  if (analyzePollTimer) { clearInterval(analyzePollTimer); analyzePollTimer = null; }
}

function showAnalyzeProgress() {
  const el = $("analyze-progress");
  if (el) el.classList.remove("hidden", "done", "error");
}

async function pollAnalyzeStatus() {
  try {
    const res = await adminFetch("/api/relationship/analyze-status");
    const p = await res.json();
    renderAnalyzeProgress(p);
  } catch { /* ignore */ }
}

function renderAnalyzeProgress(p) {
  const el = $("analyze-progress");
  const btn = $("analyze-btn");
  const label = $("analyze-progress-label");
  const fill = $("analyze-progress-fill");
  const logEl = $("analyze-progress-log");
  if (!el || !btn || !label || !fill) return;

  if (!p.active && p.phase === "idle") {
    el.classList.add("hidden");
    el.classList.remove("done", "error");
    btn.disabled = false;
    btn.textContent = "Analyze Now";
    stopAnalyzePoll();
    return;
  }

  if (p.active) {
    el.classList.remove("hidden", "done", "error");
    btn.disabled = true;
    btn.textContent = "Analyzing...";
    const phasePct = { collecting: 15, analyzing: 50, saving: 90 };
    fill.style.width = (phasePct[p.phase] || 5) + "%";
    label.textContent = phaseLabel(p.phase, p.messageCount);
    startAnalyzePoll();
  } else if (p.phase === "done") {
    el.classList.remove("hidden", "error");
    el.classList.add("done");
    label.textContent = "Analysis complete!";
    fill.style.width = "100%";
    btn.disabled = false;
    btn.textContent = "Analyze Now";
    stopAnalyzePoll();
    loadDashboard();
    setTimeout(() => { el.classList.add("hidden"); el.classList.remove("done"); }, 5000);
  } else if (p.phase === "error") {
    el.classList.remove("hidden", "done");
    el.classList.add("error");
    label.textContent = "Analysis failed: " + (p.errorMessage || "Unknown error");
    fill.style.width = "100%";
    btn.disabled = false;
    btn.textContent = "Analyze Now";
    stopAnalyzePoll();
  }

  if (logEl && p.log && p.log.length > 0) {
    logEl.textContent = p.log.join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function phaseLabel(phase, count) {
  switch (phase) {
    case "collecting": return `Collecting ${count || 0} unanalyzed messages...`;
    case "analyzing": return `Analyzing ${count || 0} messages with Claude...`;
    case "saving": return "Saving analysis results...";
    default: return "Starting analysis...";
  }
}

// ── Backfill ──

function setupBackfillButton() {
  const btn = $("backfill-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    if (!confirm("Fetch all available message history from WhatsApp?")) return;
    btn.disabled = true;
    btn.textContent = "Fetching...";
    try {
      const res = await adminFetch("/api/relationship/backfill", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Backfill failed");
      alert(`Backfill complete! Imported ${data.messagesImported} messages.`);
      await loadDashboard();
    } catch (err) {
      alert("Backfill failed: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Backfill";
    }
  });
}

// ── Import .txt ──

function setupImportButton() {
  const btn = $("import-btn");
  const fileInput = $("import-file");
  if (!btn || !fileInput) return;
  btn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    btn.disabled = true;
    btn.textContent = "Importing...";
    try {
      const text = await file.text();
      const res = await adminFetch("/api/relationship/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      alert(`Imported: ${data.imported} | Duplicates: ${data.duplicates} | Total: ${data.total}`);
      await loadDashboard();
    } catch (err) {
      alert("Import failed: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Import .txt";
      fileInput.value = "";
    }
  });
}

// ── Rendering ──

function $(id) { return document.getElementById(id); }

function renderDashboard() {
  const loading = $("loading-state");
  const errEl = $("error-state");
  const dash = $("dashboard");
  if (loading) loading.classList.add("hidden");
  if (errEl) errEl.classList.add("hidden");
  if (dash) dash.classList.remove("hidden");

  const d = dashboardData;
  renderMonitorBar(d);
  renderStats(d);
  renderSparklines(d);
  renderRatio(d);
  renderLatestAnalysis(d);
  renderRadarChart(d);
  renderHorsemen(d);
  renderPositives(d);
  renderPerelGauges(d);
  renderTrendChart(d);
  renderDailyCards(d);
}

// ── Monitor Bar ──

function renderMonitorBar(d) {
  const dot = $("monitor-dot");
  const lastMsgEl = $("monitor-last-msg");
  const todayEl = $("monitor-today-count");
  if (!dot || !lastMsgEl || !todayEl) return;
  const lastMsg = d.monitoring?.lastMessageAt;
  const todayCount = d.monitoring?.messagesToday ?? 0;
  let color = "red";
  if (lastMsg) {
    const diffMin = (Date.now() - new Date(lastMsg).getTime()) / 60000;
    if (diffMin < 30) color = "green";
    else if (diffMin < 120) color = "yellow";
  }
  dot.className = "monitor-dot " + color;
  lastMsgEl.innerHTML = lastMsg
    ? `Last: <strong>${formatRelativeTime(lastMsg)}</strong>`
    : `Last: <strong>--</strong>`;
  todayEl.innerHTML = `Today: <strong>${todayCount}</strong>`;
}

// ── Stats ──

function renderStats(d) {
  const s = d.stats || {};
  const el = (id, val) => { const e = $(id); if (e) e.textContent = val; };
  el("stat-total-messages", (s.totalMessages ?? 0).toLocaleString());
  el("stat-voice-minutes", (s.voiceMinutes ?? 0).toLocaleString());
  el("stat-days-tracked", (s.daysTracked ?? 0).toLocaleString());
  const avg = s.daysTracked > 0 ? Math.round(s.totalMessages / s.daysTracked) : 0;
  el("stat-avg-per-day", avg.toLocaleString());
}

// ── Sparklines ──

function renderSparklines(d) {
  const days = d.dailyAnalyses || [];
  if (days.length < 2) return;
  const recent = days.slice(0, 7).reverse();
  drawSparkline("spark-messages", recent.map(a => a.messageCount || 0), "#4fc3f7");
  drawSparkline("spark-health", recent.map(a => a.overallScore || 0), "#00b894");
}

function drawSparkline(id, data, color) {
  const canvas = $(id);
  if (!canvas || data.length < 2) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const W = 60, H = 20;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + "px"; canvas.style.height = H + "px";
  ctx.scale(dpr, dpr);
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  ctx.clearRect(0, 0, W, H);
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  data.forEach((val, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - ((val - min) / range) * (H - 4) - 2;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// ── Message Ratio ──

function renderRatio(d) {
  const r = d.stats?.messageRatio || {};
  const ben = r.benPercent ?? 50;
  const hope = r.hopePercent ?? 50;
  const ll = $("ratio-left-label"), rl = $("ratio-right-label");
  const lf = $("ratio-fill-left"), rf = $("ratio-fill-right");
  if (ll) ll.textContent = `Ben: ${Math.round(ben)}%`;
  if (rl) rl.textContent = `Hope: ${Math.round(hope)}%`;
  if (lf) lf.style.width = ben + "%";
  if (rf) rf.style.width = hope + "%";
}

// ── Latest Analysis ──

function renderLatestAnalysis(d) {
  const a = d.latestAnalysis;
  const scoreEl = $("health-score");
  const summaryEl = $("health-summary");
  const dateEl = $("health-date");
  if (!scoreEl || !summaryEl || !dateEl) return;
  if (!a) {
    scoreEl.textContent = "--";
    scoreEl.className = "health-score-number";
    summaryEl.textContent = 'No analysis available yet. Click "Analyze Now" to generate one.';
    dateEl.textContent = "";
    return;
  }
  const score = a.overallScore ?? 0;
  scoreEl.textContent = Math.round(score);
  scoreEl.className = "health-score-number " + scoreColor(score);
  summaryEl.textContent = a.summary || "No summary available.";
  if (a.date) {
    const dateObj = new Date(a.date + "T00:00:00");
    dateEl.textContent = "Analysis from " + dateObj.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  }
}

// ── Radar Chart (Canvas) ──

function renderRadarChart(d) {
  const canvas = $("radar-chart");
  if (!canvas) return;
  const a = d.latestAnalysis;
  if (!a) { canvas.style.display = "none"; return; }
  canvas.style.display = "block";

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const size = Math.min(canvas.parentElement.getBoundingClientRect().width, 260);
  canvas.width = size * dpr; canvas.height = size * dpr;
  canvas.style.width = size + "px"; canvas.style.height = size + "px";
  ctx.scale(dpr, dpr);

  const cx = size / 2, cy = size / 2, radius = size * 0.34;

  // 7 axes: horsemen inverted + positives
  const labels = ["Low Criticism", "Low Contempt", "Low Stonewalling", "Low Defensive",
                  "Fondness", "Turning Toward", "Repair"];
  const values = [
    100 - (a.horsemen.criticism || 0),
    100 - (a.horsemen.contempt || 0),
    100 - (a.horsemen.stonewalling || 0),
    100 - (a.horsemen.defensiveness || 0),
    a.positives.fondness || 0,
    a.positives.turningToward || 0,
    a.positives.repair || 0,
  ];

  const n = labels.length;
  const step = (Math.PI * 2) / n;
  ctx.clearRect(0, 0, size, size);

  // Concentric rings
  [0.25, 0.5, 0.75, 1.0].forEach(pct => {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const angle = i * step - Math.PI / 2;
      const x = cx + Math.cos(angle) * radius * pct;
      const y = cy + Math.sin(angle) * radius * pct;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 0.5;
    ctx.stroke();
  });

  // Axis lines + labels
  ctx.font = "9px -apple-system, sans-serif";
  ctx.fillStyle = "#888";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < n; i++) {
    const angle = i * step - Math.PI / 2;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 0.5;
    ctx.stroke();
    const lx = cx + Math.cos(angle) * (radius + 18);
    const ly = cy + Math.sin(angle) * (radius + 18);
    ctx.fillText(labels[i], lx, ly);
  }

  // Data polygon
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const angle = i * step - Math.PI / 2;
    const val = Math.max(0, Math.min(100, values[i])) / 100;
    const x = cx + Math.cos(angle) * radius * val;
    const y = cy + Math.sin(angle) * radius * val;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(79, 195, 247, 0.15)";
  ctx.fill();
  ctx.strokeStyle = "#4fc3f7";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Data dots
  for (let i = 0; i < n; i++) {
    const angle = i * step - Math.PI / 2;
    const val = Math.max(0, Math.min(100, values[i])) / 100;
    const x = cx + Math.cos(angle) * radius * val;
    const y = cy + Math.sin(angle) * radius * val;
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = val >= 0.7 ? "#00b894" : val >= 0.4 ? "#fdcb6e" : "#d63031";
    ctx.fill();
  }
}

// ── Gottman Four Horsemen ──

function renderHorsemen(d) {
  const container = $("horsemen-bars");
  if (!container) return;
  const h = d.latestAnalysis?.horsemen || {};
  const ev = d.latestAnalysis?.evidence || {};
  const items = [
    { key: "criticism", label: "Criticism", evKey: "criticism" },
    { key: "contempt", label: "Contempt", evKey: "contempt" },
    { key: "stonewalling", label: "Stonewalling", evKey: "stonewalling" },
    { key: "defensiveness", label: "Defensiveness", evKey: "defensiveness" },
  ];
  container.innerHTML = items.map((item) => {
    const val = h[item.key] ?? 0;
    const cls = val > 60 ? "horseman" : val > 30 ? "horseman mid" : "horseman low";
    return metricBarHTML(item.label, val, cls, item.evKey, ev);
  }).join("");
}

// ── Gottman Positives ──

function renderPositives(d) {
  const container = $("positives-bars");
  if (!container) return;
  const p = d.latestAnalysis?.positives || {};
  const ev = d.latestAnalysis?.evidence || {};
  const items = [
    { key: "fondness", label: "Fondness", evKey: "fondnessAdmiration" },
    { key: "turningToward", label: "Turning Toward", evKey: "turningToward" },
    { key: "repair", label: "Repair Attempts", evKey: "repairAttempts" },
  ];
  container.innerHTML = items.map((item) => {
    const val = p[item.key] ?? 0;
    const cls = val >= 60 ? "positive" : val >= 30 ? "positive mid" : "positive low";
    return metricBarHTML(item.label, val, cls, item.evKey, ev);
  }).join("");
}

// ── Metric Bar with Evidence ──

function metricBarHTML(label, value, colorClass, evKey, evidence) {
  const pct = Math.max(0, Math.min(100, value));
  const quotes = (evidence && evidence[evKey]) || [];
  let evHTML = "";
  if (quotes.length > 0) {
    evHTML = `<div class="evidence-panel" onclick="event.stopPropagation(); this.classList.toggle('open')">
      <div class="evidence-toggle">
        <span class="evidence-arrow">&#9654;</span> ${quotes.length} quote${quotes.length > 1 ? "s" : ""}
      </div>
      <div class="evidence-quotes">
        ${quotes.map(q => `<div class="evidence-quote">"${escapeHtml(q)}"</div>`).join("")}
      </div>
    </div>`;
  }
  return `<div class="metric-row-wrap">
    <div class="metric-row">
      <span class="metric-label">${escapeHtml(label)}</span>
      <div class="metric-bar-bg"><div class="metric-bar-fill ${colorClass}" style="width: ${pct}%"></div></div>
      <span class="metric-value">${Math.round(value)}</span>
    </div>
    ${evHTML}
  </div>`;
}

// ── Perel Gauges ──

function renderPerelGauges(d) {
  const container = $("perel-gauges");
  if (!container) return;
  const p = d.latestAnalysis?.perel || {};
  const ev = d.latestAnalysis?.evidence || {};
  const items = [
    { key: "curiosity", label: "Curiosity", evKey: "curiosity" },
    { key: "playfulness", label: "Playfulness", evKey: "playfulness" },
    { key: "autonomyBalance", label: "Autonomy", evKey: "autonomyTogetherness" },
  ];

  container.innerHTML = items.map((item, i) => {
    const val = p[item.key] ?? 0;
    const quotes = (ev && ev[item.evKey]) || [];
    let evHTML = "";
    if (quotes.length > 0) {
      evHTML = `<div class="evidence-panel" style="padding-left:0;text-align:left" onclick="event.stopPropagation(); this.classList.toggle('open')">
        <div class="evidence-toggle"><span class="evidence-arrow">&#9654;</span> ${quotes.length} quote${quotes.length > 1 ? "s" : ""}</div>
        <div class="evidence-quotes">${quotes.map(q => `<div class="evidence-quote">"${escapeHtml(q)}"</div>`).join("")}</div>
      </div>`;
    }
    return `<div class="gauge-item">
      <canvas id="gauge-${i}" class="gauge-canvas"></canvas>
      <div class="gauge-value">${Math.round(val)}</div>
      <div class="gauge-label">${item.label}</div>
      ${evHTML}
    </div>`;
  }).join("");

  // Draw gauges
  items.forEach((item, i) => {
    const canvas = $(`gauge-${i}`);
    if (canvas) drawGauge(canvas, (p[item.key] ?? 0) / 100);
  });
}

function drawGauge(canvas, pct) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const S = 80;
  canvas.width = S * dpr; canvas.height = S * dpr;
  canvas.style.width = S + "px"; canvas.style.height = S + "px";
  ctx.scale(dpr, dpr);

  const cx = S / 2, cy = S / 2, r = 30, lw = 6;
  const startAngle = 0.75 * Math.PI;
  const endAngle = 2.25 * Math.PI;
  const range = endAngle - startAngle;

  ctx.clearRect(0, 0, S, S);

  // Background arc
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle);
  ctx.strokeStyle = "#2a2a2a";
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.stroke();

  // Value arc
  const clamped = Math.max(0, Math.min(1, pct));
  const color = clamped >= 0.7 ? "#00b894" : clamped >= 0.4 ? "#fdcb6e" : "#d63031";
  if (clamped > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, startAngle + range * clamped);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.stroke();
  }
}

// ── Trend Chart (Canvas) ──

function renderTrendChart(d) {
  const canvas = $("trend-chart");
  const emptyEl = $("chart-empty");
  if (!canvas || !emptyEl) return;
  const trend = d.trend || [];

  if (trend.length < 2) {
    canvas.style.display = "none";
    emptyEl.classList.remove("hidden");
    return;
  }

  canvas.style.display = "block";
  emptyEl.classList.add("hidden");

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + "px";
  canvas.style.height = rect.height + "px";
  ctx.scale(dpr, dpr);

  const W = rect.width, H = rect.height;
  const pL = 36, pR = 12, pT = 12, pB = 28;
  const cW = W - pL - pR, cH = H - pT - pB;

  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = "#333"; ctx.lineWidth = 0.5;
  ctx.font = "10px -apple-system, sans-serif";
  ctx.fillStyle = "#666"; ctx.textAlign = "right";
  for (let yVal = 0; yVal <= 100; yVal += 25) {
    const y = pT + cH - (yVal / 100) * cH;
    ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.stroke();
    ctx.fillText(yVal.toString(), pL - 4, y + 3);
  }

  // Color zones
  const redTop = pT + cH - (40 / 100) * cH;
  const yellowTop = pT + cH - (70 / 100) * cH;
  ctx.fillStyle = "rgba(214, 48, 49, 0.04)";
  ctx.fillRect(pL, redTop, cW, pT + cH - redTop);
  ctx.fillStyle = "rgba(253, 203, 110, 0.03)";
  ctx.fillRect(pL, yellowTop, cW, redTop - yellowTop);
  ctx.fillStyle = "rgba(0, 184, 148, 0.03)";
  ctx.fillRect(pL, pT, cW, yellowTop - pT);

  // Points
  const pts = trend.map((pt, i) => {
    const x = pL + (i / (trend.length - 1)) * cW;
    const score = Math.max(0, Math.min(100, pt.score ?? 0));
    const y = pT + cH - (score / 100) * cH;
    return { x, y, score, date: pt.date };
  });

  // Line
  ctx.beginPath();
  ctx.strokeStyle = "#4fc3f7"; ctx.lineWidth = 1.5;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  pts.forEach((pt, i) => { if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y); });
  ctx.stroke();

  // Gradient fill
  const grad = ctx.createLinearGradient(0, pT, 0, pT + cH);
  grad.addColorStop(0, "rgba(79, 195, 247, 0.15)");
  grad.addColorStop(1, "rgba(79, 195, 247, 0)");
  ctx.beginPath();
  pts.forEach((pt, i) => { if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y); });
  ctx.lineTo(pts[pts.length - 1].x, pT + cH);
  ctx.lineTo(pts[0].x, pT + cH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Dots
  pts.forEach((pt) => {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = pt.score >= 70 ? "#00b894" : pt.score >= 40 ? "#fdcb6e" : "#d63031";
    ctx.fill();
  });

  // X labels
  ctx.fillStyle = "#666"; ctx.textAlign = "center";
  ctx.font = "9px -apple-system, sans-serif";
  const labelStep = Math.max(1, Math.floor(trend.length / 6));
  for (let i = 0; i < trend.length; i += labelStep) {
    const dateObj = new Date(trend[i].date + "T00:00:00");
    ctx.fillText(dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" }), pts[i].x, H - 6);
  }
  if (trend.length > 1) {
    const last = pts[pts.length - 1];
    const lastDate = new Date(trend[trend.length - 1].date + "T00:00:00");
    ctx.fillText(lastDate.toLocaleDateString("en-US", { month: "short", day: "numeric" }), last.x, H - 6);
  }
}

// ── Daily Cards ──

function renderDailyCards(d) {
  const container = $("daily-cards");
  const emptyEl = $("daily-empty");
  if (!container || !emptyEl) return;
  const days = d.dailyAnalyses || [];

  if (days.length === 0) { container.innerHTML = ""; emptyEl.classList.remove("hidden"); return; }
  emptyEl.classList.add("hidden");

  container.innerHTML = days.map((day) => {
    const dateObj = new Date(day.date + "T00:00:00");
    const dateLabel = dateObj.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const score = day.overallScore ?? 0;
    const expanded = expandedCards.has(day.date);
    return `<div class="daily-card${expanded ? " expanded" : ""}" data-date="${escapeAttr(day.date)}">
      <div class="daily-card-header">
        <span class="daily-card-date">${dateLabel}</span>
        <span class="daily-card-count">${day.messageCount ?? 0} msgs</span>
        <span class="daily-card-score ${scoreColor(score)}">${Math.round(score)}</span>
      </div>
      ${day.summary ? `<div class="daily-card-summary">${escapeHtml(day.summary)}</div>` : ""}
      <div class="daily-card-messages${expanded ? " open" : ""}" id="messages-${escapeAttr(day.date)}">
        ${expanded ? "" : '<div class="loading-messages">Click to load messages...</div>'}
      </div>
    </div>`;
  }).join("");

  container.querySelectorAll(".daily-card").forEach((card) => {
    card.addEventListener("click", () => toggleDailyCard(card));
  });
}

async function toggleDailyCard(card) {
  const date = card.dataset.date;
  const messagesEl = card.querySelector(".daily-card-messages");

  if (expandedCards.has(date)) {
    expandedCards.delete(date);
    card.classList.remove("expanded");
    messagesEl.classList.remove("open");
    return;
  }

  expandedCards.add(date);
  card.classList.add("expanded");
  messagesEl.classList.add("open");
  messagesEl.innerHTML = '<div class="loading-messages">Loading messages...</div>';

  try {
    const res = await adminFetch(`/api/relationship/messages?date=${encodeURIComponent(date)}`);
    if (!res.ok) throw new Error("Failed to fetch messages");
    const messages = await res.json();

    if (messages.length === 0) {
      messagesEl.innerHTML = '<div class="loading-messages">No messages for this date.</div>';
      return;
    }

    messagesEl.innerHTML = messages.map((msg) => {
      const cls = msg.speaker === "self" ? "ben" : "hope";
      const name = msg.speaker === "self" ? "Ben" : "Hope";
      const time = msg.timestamp
        ? new Date(msg.timestamp * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
        : "";
      const badge = msg.type && msg.type !== "text"
        ? `<span class="message-type-badge">${escapeHtml(msg.type)}</span>` : "";
      return `<div class="message-item">
        <div class="message-sender ${cls}">${name}<span class="message-time">${time}</span>${badge}</div>
        <div class="message-text">${escapeHtml(msg.body || msg.transcript || "[media]")}</div>
      </div>`;
    }).join("");
  } catch (err) {
    messagesEl.innerHTML = `<div class="loading-messages" style="color:var(--red)">Failed: ${escapeHtml(err.message)}</div>`;
  }
}

// ── Utilities ──

function scoreColor(score) {
  if (score >= 70) return "green";
  if (score >= 40) return "yellow";
  return "red";
}

function formatRelativeTime(str) {
  if (!str) return "";
  const normalized = str.includes("T") ? str : str.replace(" ", "T");
  const date = new Date(normalized + (normalized.includes("Z") || normalized.includes("+") ? "" : "Z"));
  if (isNaN(date.getTime())) return str;
  const diffMs = Date.now() - date.getTime();
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

const _escEl = document.createElement("div");
function escapeHtml(str) { if (!str) return ""; _escEl.textContent = str; return _escEl.innerHTML; }
function escapeAttr(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
