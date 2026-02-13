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

// Trend chart interactivity state
let trendPoints = []; // [{x, y, score, date, summary, tone}]

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
  setupTranscribeButton();
  setupImportButton();
  setupUpdateControls();
  setupTrendChartInteractivity();
  loadDashboard();
  refreshTimer = setInterval(loadDashboard, 30000);
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

  // Reset & Re-analyze button
  const resetBtn = $("reset-analyze-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      if (resetBtn.disabled) return;
      if (!confirm("This will reset ALL messages to unanalyzed and re-analyze the full history day by day. Continue?")) return;
      resetBtn.disabled = true;
      btn.disabled = true;
      try {
        const resetRes = await adminFetch("/api/relationship/reset-analyzed", { method: "POST" });
        const resetData = await resetRes.json();
        if (!resetRes.ok) throw new Error(resetData.error || "Reset failed");

        const analyzeRes = await adminFetch("/api/relationship/analyze", { method: "POST" });
        if (!analyzeRes.ok) {
          const data = await analyzeRes.json().catch(() => ({}));
          throw new Error(data.error || `Server returned ${analyzeRes.status}`);
        }
        showAnalyzeProgress();
        startAnalyzePoll();
      } catch (err) {
        alert("Failed: " + err.message);
        resetBtn.disabled = false;
        btn.disabled = false;
      }
    });
  }
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

  var resetBtn = $("reset-analyze-btn");
  if (!p.active && p.phase === "idle") {
    el.classList.add("hidden");
    el.classList.remove("done", "error");
    btn.disabled = false;
    btn.textContent = "Analyze Now";
    if (resetBtn) resetBtn.disabled = false;
    stopAnalyzePoll();
    return;
  }

  if (p.active) {
    el.classList.remove("hidden", "done", "error");
    btn.disabled = true;
    btn.textContent = "Analyzing...";
    var pct = 5;
    if (p.phase === "collecting") {
      pct = 5;
    } else if (p.phase === "analyzing" && p.totalDays > 0) {
      pct = 10 + Math.round((p.currentDay / p.totalDays) * 80);
    } else if (p.phase === "saving") {
      pct = 95;
    }
    fill.style.width = pct + "%";
    label.textContent = phaseLabel(p.phase, p.messageCount, p.currentDay, p.totalDays);
    startAnalyzePoll();
  } else if (p.phase === "done") {
    el.classList.remove("hidden", "error");
    el.classList.add("done");
    label.textContent = "Analysis complete!";
    fill.style.width = "100%";
    btn.disabled = false;
    btn.textContent = "Analyze Now";
    if (resetBtn) resetBtn.disabled = false;
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
    if (resetBtn) resetBtn.disabled = false;
    stopAnalyzePoll();
  }

  if (logEl && p.log && p.log.length > 0) {
    logEl.textContent = p.log.join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function phaseLabel(phase, count, currentDay, totalDays) {
  switch (phase) {
    case "collecting": return `Collecting ${count || 0} unanalyzed messages...`;
    case "analyzing":
      if (totalDays > 1) return `Analyzing day ${currentDay || 1} of ${totalDays} (${count || 0} messages total)...`;
      return `Analyzing ${count || 0} messages with Claude...`;
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

// ── Transcribe Voice Notes ──

function setupTranscribeButton() {
  const btn = $("transcribe-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    if (!confirm("Transcribe all untranscribed voice notes via Groq Whisper? This re-fetches messages from WhatsApp.")) return;
    btn.disabled = true;
    btn.textContent = "Transcribing...";
    try {
      const res = await adminFetch("/api/relationship/transcribe", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Transcription failed");
      alert(`Transcription complete! ${data.transcribed} voice notes transcribed.`);
      await loadDashboard();
    } catch (err) {
      alert("Transcription failed: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Transcribe Voice";
    }
  });
}

// ── Dashboard Update Controls ──

function setupUpdateControls() {
  const freqSelect = $("update-frequency");
  const sendBtn = $("send-update-btn");
  const previewBtn = $("preview-update-btn");
  const modal = $("preview-modal");
  const closeBtn = $("preview-close");
  const previewContent = $("preview-content");
  const previewSend = $("preview-send");

  // Load current settings
  adminFetch("/api/relationship/settings").then(r => r.json()).then(data => {
    if (freqSelect) freqSelect.value = data.updateFrequency || "off";
  }).catch(() => {});

  // Save frequency when changed
  if (freqSelect) {
    freqSelect.addEventListener("change", async () => {
      try {
        await adminFetch("/api/relationship/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updateFrequency: freqSelect.value }),
        });
      } catch (err) {
        alert("Failed to save setting: " + err.message);
      }
    });
  }

  // Send now
  if (sendBtn) {
    sendBtn.addEventListener("click", async () => {
      if (sendBtn.disabled) return;
      if (!confirm("Send a dashboard update to Hope via WhatsApp now?")) return;
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending...";
      try {
        const freq = freqSelect ? freqSelect.value : "daily";
        const res = await adminFetch("/api/relationship/send-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ frequency: freq === "off" ? "daily" : freq }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Send failed");
        alert("Update sent to Hope!");
      } catch (err) {
        alert("Failed to send: " + err.message);
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send Now";
      }
    });
  }

  // Preview
  if (previewBtn && modal) {
    previewBtn.addEventListener("click", async () => {
      try {
        const freq = freqSelect ? freqSelect.value : "daily";
        const res = await adminFetch(`/api/relationship/preview-update?frequency=${freq === "off" ? "daily" : freq}`);
        const data = await res.json();
        if (previewContent) previewContent.textContent = data.message || "No data available.";
        modal.style.display = "flex";
      } catch (err) {
        alert("Failed to load preview: " + err.message);
      }
    });
  }

  // Close modal
  if (closeBtn && modal) {
    closeBtn.addEventListener("click", () => { modal.style.display = "none"; });
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.style.display = "none"; });
  }

  // Send from preview
  if (previewSend && modal) {
    previewSend.addEventListener("click", async () => {
      if (previewSend.disabled) return;
      previewSend.disabled = true;
      previewSend.textContent = "Sending...";
      try {
        const freq = freqSelect ? freqSelect.value : "daily";
        const res = await adminFetch("/api/relationship/send-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ frequency: freq === "off" ? "daily" : freq }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Send failed");
        alert("Update sent to Hope!");
        modal.style.display = "none";
      } catch (err) {
        alert("Failed to send: " + err.message);
      } finally {
        previewSend.disabled = false;
        previewSend.textContent = "Send to Hope";
      }
    });
  }
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

/** Aggregate metrics across all daily analyses in the range */
function computeRangeAnalysis(dailyAnalyses) {
  if (!dailyAnalyses || dailyAnalyses.length === 0) return null;
  if (dailyAnalyses.length === 1) return dailyAnalyses[0];

  const n = dailyAnalyses.length;
  function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

  // Average numeric metrics
  const ranged = {
    date: dailyAnalyses[0].date, // most recent
    overallScore: avg(dailyAnalyses.map(a => a.overallScore ?? 0)),
    summary: `Average across ${n} days. Most recent: ${dailyAnalyses[0].summary || "No summary."}`,
    messageCount: dailyAnalyses.reduce((s, a) => s + (a.messageCount || 0), 0),
    voiceMinutes: dailyAnalyses.reduce((s, a) => s + (a.voiceMinutes || 0), 0),
    emotionalTone: computeDominantTone(dailyAnalyses),
    horsemen: {
      criticism: avg(dailyAnalyses.map(a => a.horsemen?.criticism ?? 0)),
      contempt: avg(dailyAnalyses.map(a => a.horsemen?.contempt ?? 0)),
      stonewalling: avg(dailyAnalyses.map(a => a.horsemen?.stonewalling ?? 0)),
      defensiveness: avg(dailyAnalyses.map(a => a.horsemen?.defensiveness ?? 0)),
    },
    positives: {
      fondness: avg(dailyAnalyses.map(a => a.positives?.fondness ?? 0)),
      turningToward: avg(dailyAnalyses.map(a => a.positives?.turningToward ?? 0)),
      repair: avg(dailyAnalyses.map(a => a.positives?.repair ?? 0)),
    },
    perel: {
      curiosity: avg(dailyAnalyses.map(a => a.perel?.curiosity ?? 0)),
      playfulness: avg(dailyAnalyses.map(a => a.perel?.playfulness ?? 0)),
      autonomyBalance: avg(dailyAnalyses.map(a => a.perel?.autonomyBalance ?? 0)),
    },
    // Aggregate bank account
    emotionalBankAccount: aggregateBankAccount(dailyAnalyses),
    // Aggregate bids
    bids: aggregateBids(dailyAnalyses),
    // Most recent pursue-withdraw pattern
    pursueWithdraw: dailyAnalyses[0].pursueWithdraw,
    // Most recent recommendations, quotes, language (per-day makes more sense)
    recommendations: dailyAnalyses[0].recommendations,
    notableQuotes: dailyAnalyses[0].notableQuotes,
    languageEmotionAnalysis: dailyAnalyses[0].languageEmotionAnalysis,
    evidence: dailyAnalyses[0].evidence || {},
  };
  return ranged;
}

function computeDominantTone(analyses) {
  const counts = {};
  for (const a of analyses) {
    const t = a.emotionalTone || "neutral";
    counts[t] = (counts[t] || 0) + 1;
  }
  let best = "neutral", bestCount = 0;
  for (const [tone, count] of Object.entries(counts)) {
    if (count > bestCount) { best = tone; bestCount = count; }
  }
  return best;
}

function aggregateBankAccount(analyses) {
  const valid = analyses.filter(a => a.emotionalBankAccount);
  if (valid.length === 0) return null;
  const totalDeposits = valid.reduce((s, a) => s + (a.emotionalBankAccount.deposits || 0), 0);
  const totalWithdrawals = valid.reduce((s, a) => s + (a.emotionalBankAccount.withdrawals || 0), 0);
  const ratio = totalDeposits / Math.max(totalWithdrawals, 1);
  const status = ratio >= 5.0 ? "healthy" : ratio >= 2.0 ? "watch" : "overdrawn";
  return { deposits: totalDeposits, withdrawals: totalWithdrawals, ratio, status };
}

function aggregateBids(analyses) {
  const valid = analyses.filter(a => a.bids);
  if (valid.length === 0) return null;
  return {
    benMade: valid.reduce((s, a) => s + (a.bids.benMade || 0), 0),
    hopeMade: valid.reduce((s, a) => s + (a.bids.hopeMade || 0), 0),
    turnedToward: valid.reduce((s, a) => s + (a.bids.turnedToward || 0), 0),
    turnedAway: valid.reduce((s, a) => s + (a.bids.turnedAway || 0), 0),
    turnedAgainst: valid.reduce((s, a) => s + (a.bids.turnedAgainst || 0), 0),
  };
}

function renderDashboard() {
  const loading = $("loading-state");
  const errEl = $("error-state");
  const dash = $("dashboard");
  if (loading) loading.classList.add("hidden");
  if (errEl) errEl.classList.add("hidden");
  if (dash) dash.classList.remove("hidden");

  const d = dashboardData;

  // Compute range-aggregated analysis from all daily analyses
  d.rangeAnalysis = computeRangeAnalysis(d.dailyAnalyses || []);

  // Toolbar
  renderMonitorBar(d);
  // Zone 1: Action (uses latest for actionable recs)
  renderActionCards(d);
  renderNotableQuotes(d);
  // Zone 2: Trend
  renderTrendChart(d);
  // Zone 3: Overview (uses range-aggregated metrics)
  renderHealthScoreHero(d);
  renderBankAccount(d);
  renderWaryOf(d);
  renderLanguageEmotion(d);
  renderBids(d);
  renderPursueWithdraw(d);
  renderCommunicationBalance(d);
  renderRadarChart(d);
  // Zone 4: Granular (uses range-aggregated metrics)
  renderStats(d);
  renderSparklines(d);
  renderHorsemen(d);
  renderPositives(d);
  renderPerelGauges(d);
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

// ── ZONE 1: ACTION ──

function renderActionCards(d) {
  const a = d.latestAnalysis;
  const recs = a ? a.recommendations : null;

  // Ben card
  const benText = $("action-ben-text");
  const benCtx = $("action-ben-context");
  if (benText) {
    if (recs && recs.forBen && recs.forBen.length > 0) {
      benText.textContent = recs.forBen[0];
      if (benCtx) benCtx.textContent = recs.forBen.length > 1 ? recs.forBen.slice(1).join(" ") : "";
    } else {
      benText.textContent = "Run an analysis to get recommendations.";
      if (benCtx) benCtx.textContent = "";
    }
  }

  // Hope card
  const hopeText = $("action-hope-text");
  const hopeCtx = $("action-hope-context");
  if (hopeText) {
    if (recs && recs.forHope && recs.forHope.length > 0) {
      hopeText.textContent = recs.forHope[0];
      if (hopeCtx) hopeCtx.textContent = recs.forHope.length > 1 ? recs.forHope.slice(1).join(" ") : "";
    } else {
      hopeText.textContent = "Run an analysis to get recommendations.";
      if (hopeCtx) hopeCtx.textContent = "";
    }
  }

  // Together card
  const togetherText = $("action-together-text");
  const togetherCtx = $("action-together-context");
  if (togetherText) {
    if (recs && recs.forBoth && recs.forBoth.length > 0) {
      togetherText.textContent = recs.forBoth[0];
      if (togetherCtx) togetherCtx.textContent = recs.forBoth.length > 1 ? recs.forBoth.slice(1).join(" ") : "";
    } else {
      togetherText.textContent = "Run an analysis to get recommendations.";
      if (togetherCtx) togetherCtx.textContent = "";
    }
  }
}

function renderNotableQuotes(d) {
  const section = $("notable-quotes-section");
  const container = $("notable-quotes-content");
  if (!section || !container) return;

  const quotes = d.latestAnalysis ? d.latestAnalysis.notableQuotes : null;
  if (!quotes || quotes.length === 0) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");

  container.innerHTML = quotes.map(q => {
    const isHope = (q.speaker || "").toLowerCase() === "hope";
    const cls = isHope ? "notable-quote-card hope" : "notable-quote-card";
    const label = q.label || "insight";
    return `<div class="${cls}">
      <div class="quote-text">"${escapeHtml(q.quote)}"</div>
      <div class="quote-meta">
        <span style="color:${isHope ? 'var(--pink)' : 'var(--accent)'}">${escapeHtml(q.speaker || "Unknown")}</span>
        <span class="quote-label">${escapeHtml(label)}</span>
      </div>
    </div>`;
  }).join("");
}

// ── ZONE 2: TREND (Interactive) ──

function renderTrendChart(d) {
  const canvas = $("trend-chart");
  const emptyEl = $("chart-empty");
  if (!canvas || !emptyEl) return;
  const trend = d.trend || [];
  const dailyAnalyses = d.dailyAnalyses || [];

  // Build lookup for summaries/tones by date
  const dayLookup = {};
  for (const da of dailyAnalyses) {
    dayLookup[da.date] = da;
  }

  if (trend.length < 2) {
    canvas.style.display = "none";
    emptyEl.classList.remove("hidden");
    trendPoints = [];
    return;
  }

  canvas.style.display = "block";
  emptyEl.classList.add("hidden");

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const container = canvas.parentElement;
  const rect = container.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.scale(dpr, dpr);

  const pL = 36, pR = 12, pT = 16, pB = 28;
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
    const dayData = dayLookup[pt.date] || {};
    return { x, y, score, date: pt.date, summary: dayData.summary || "", tone: dayData.emotionalTone || "" };
  });

  // Store for interactivity
  trendPoints = pts;

  // Line
  ctx.beginPath();
  ctx.strokeStyle = "#4fc3f7"; ctx.lineWidth = 2;
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
    ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
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

function setupTrendChartInteractivity() {
  const container = document.querySelector(".trend-chart-container");
  if (!container) return;

  container.addEventListener("mousemove", handleTrendHover);
  container.addEventListener("mouseleave", hideTrendTooltip);
  container.addEventListener("click", handleTrendClick);
}

function findClosestTrendPoint(clientX, clientY) {
  const canvas = $("trend-chart");
  if (!canvas || trendPoints.length === 0) return null;
  const rect = canvas.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;

  let closest = null;
  let minDist = Infinity;
  for (const pt of trendPoints) {
    const dx = pt.x - mx;
    const dy = pt.y - my;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < minDist && dist < 40) {
      minDist = dist;
      closest = pt;
    }
  }
  return closest;
}

function handleTrendHover(e) {
  const pt = findClosestTrendPoint(e.clientX, e.clientY);
  if (pt) {
    showTrendTooltip(pt, e.clientX, e.clientY);
  } else {
    hideTrendTooltip();
  }
}

function handleTrendClick(e) {
  const pt = findClosestTrendPoint(e.clientX, e.clientY);
  if (!pt) return;

  // Show tooltip
  showTrendTooltip(pt, e.clientX, e.clientY);

  // Scroll to daily card
  const card = document.querySelector(`.daily-card[data-date="${pt.date}"]`);
  if (card) {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.style.outline = "2px solid var(--accent)";
    setTimeout(() => { card.style.outline = ""; }, 2000);
  }
}

function showTrendTooltip(pt, clientX, clientY) {
  const tooltip = $("trend-tooltip");
  const container = document.querySelector(".trend-chart-container");
  if (!tooltip || !container) return;

  const dateEl = $("trend-tooltip-date");
  const scoreEl = $("trend-tooltip-score");
  const summaryEl = $("trend-tooltip-summary");
  const toneEl = $("trend-tooltip-tone");

  if (dateEl) {
    const dateObj = new Date(pt.date + "T00:00:00");
    dateEl.textContent = dateObj.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  if (scoreEl) {
    scoreEl.textContent = Math.round(pt.score);
    scoreEl.className = "trend-tooltip-score " + scoreColor(pt.score);
  }
  if (summaryEl) {
    summaryEl.textContent = pt.summary ? (pt.summary.length > 150 ? pt.summary.slice(0, 147) + "..." : pt.summary) : "";
  }
  if (toneEl) {
    if (pt.tone) {
      toneEl.innerHTML = `<span class="tone-badge ${pt.tone}">${pt.tone}</span>`;
    } else {
      toneEl.innerHTML = "";
    }
  }

  // Position tooltip
  const containerRect = container.getBoundingClientRect();
  let left = clientX - containerRect.left + 12;
  let top = clientY - containerRect.top - 10;

  // Keep within bounds
  if (left + 200 > containerRect.width) left = left - 220;
  if (top < 0) top = 10;

  tooltip.style.left = left + "px";
  tooltip.style.top = top + "px";
  tooltip.classList.remove("hidden");
}

function hideTrendTooltip() {
  const tooltip = $("trend-tooltip");
  if (tooltip) tooltip.classList.add("hidden");
}

// ── ZONE 3: OVERVIEW ──

function renderHealthScoreHero(d) {
  const a = d.rangeAnalysis;
  const scoreEl = $("health-score");
  const summaryEl = $("health-summary");
  const dateEl = $("health-date");
  const toneEl = $("health-tone");
  if (!scoreEl || !summaryEl || !dateEl) return;

  if (!a) {
    scoreEl.textContent = "--";
    scoreEl.className = "health-score-number-big";
    summaryEl.textContent = 'No analysis available yet. Click "Analyze Now" to generate one.';
    dateEl.textContent = "";
    if (toneEl) toneEl.innerHTML = "";
    return;
  }

  const score = a.overallScore ?? 0;
  scoreEl.textContent = Math.round(score);
  scoreEl.className = "health-score-number-big " + scoreColor(score);
  summaryEl.textContent = a.summary || "No summary available.";

  if (a.date) {
    const days = d.dailyAnalyses || [];
    if (days.length > 1) {
      const oldest = new Date(days[days.length - 1].date + "T00:00:00");
      const newest = new Date(days[0].date + "T00:00:00");
      const fmtOpts = { month: "short", day: "numeric" };
      dateEl.textContent = `Average across ${days.length} days (${oldest.toLocaleDateString("en-US", fmtOpts)} — ${newest.toLocaleDateString("en-US", fmtOpts)})`;
    } else {
      const dateObj = new Date(a.date + "T00:00:00");
      dateEl.textContent = "Analysis from " + dateObj.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    }
  }

  if (toneEl) {
    const tone = a.emotionalTone || "neutral";
    toneEl.innerHTML = `<span class="tone-badge ${tone}">${tone}</span>`;
  }
}

function renderWaryOf(d) {
  const container = $("wary-content");
  if (!container) return;

  const a = d.rangeAnalysis;
  if (!a) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-dim)">No data yet.</div>';
    return;
  }

  const warnings = [];

  // Check horsemen
  const h = a.horsemen || {};
  if (h.criticism > 40) warnings.push({ icon: "!", label: "Criticism", text: `Criticism level is elevated (${Math.round(h.criticism)}%). Watch for attacking character vs. behavior.` });
  if (h.contempt > 20) warnings.push({ icon: "!", label: "Contempt", text: `Contempt detected (${Math.round(h.contempt)}%). This is the strongest predictor of relationship breakdown.` });
  if (h.stonewalling > 40) warnings.push({ icon: "!", label: "Stonewalling", text: `Stonewalling pattern detected (${Math.round(h.stonewalling)}%). One partner may be shutting down.` });
  if (h.defensiveness > 40) warnings.push({ icon: "!", label: "Defensiveness", text: `Defensiveness is high (${Math.round(h.defensiveness)}%). Focus on taking responsibility.` });

  // Check bank account
  const bank = a.emotionalBankAccount;
  if (bank && bank.status === "overdrawn") {
    warnings.push({ icon: "$", label: "Overdrawn", text: `Emotional bank account is overdrawn (${bank.ratio.toFixed(1)}:1). Focus on making deposits.` });
  } else if (bank && bank.status === "watch") {
    warnings.push({ icon: "$", label: "Low Balance", text: `Emotional bank ratio (${bank.ratio.toFixed(1)}:1) is below the 5:1 target.` });
  }

  // Check pursue-withdraw
  const pw = a.pursueWithdraw;
  if (pw && pw.pattern !== "balanced") {
    const labels = { "ben-pursues": "Ben is pursuing", "hope-pursues": "Hope is pursuing", "mutual-withdrawal": "Mutual withdrawal" };
    warnings.push({ icon: "~", label: labels[pw.pattern] || pw.pattern, text: pw.description || "" });
  }

  // Check bids
  const bids = a.bids;
  if (bids) {
    const total = (bids.turnedToward || 0) + (bids.turnedAway || 0) + (bids.turnedAgainst || 0);
    const awayPct = total > 0 ? ((bids.turnedAway || 0) + (bids.turnedAgainst || 0)) / total : 0;
    if (awayPct > 0.3) {
      warnings.push({ icon: "x", label: "Missed Bids", text: `${Math.round(awayPct * 100)}% of bids for connection are being turned away or against.` });
    }
  }

  if (warnings.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--green)">Nothing to worry about right now. Keep it up!</div>';
    return;
  }

  container.innerHTML = warnings.map(w =>
    `<div class="wary-item">
      <div class="wary-icon">${escapeHtml(w.icon)}</div>
      <div class="wary-text"><span class="wary-label">${escapeHtml(w.label)}</span> &mdash; ${escapeHtml(w.text)}</div>
    </div>`
  ).join("");
}

function renderLanguageEmotion(d) {
  const container = $("language-emotion-content");
  if (!container) return;

  const le = d.latestAnalysis ? d.latestAnalysis.languageEmotionAnalysis : null;
  if (!le) {
    container.innerHTML = '<div style="font-size:11px;color:var(--text-dim)">Run analysis to see language patterns.</div>';
    return;
  }

  let html = "";

  // Emotion tags
  if (le.benEmotions && le.benEmotions.length > 0) {
    html += '<div style="margin-bottom:6px"><span style="font-size:10px;color:var(--text-dim)">Ben:</span> ';
    html += '<div class="emotion-tags" style="display:inline-flex">';
    html += le.benEmotions.map(e => `<span class="emotion-tag ben">${escapeHtml(e)}</span>`).join("");
    html += '</div></div>';
  }
  if (le.hopeEmotions && le.hopeEmotions.length > 0) {
    html += '<div style="margin-bottom:6px"><span style="font-size:10px;color:var(--text-dim)">Hope:</span> ';
    html += '<div class="emotion-tags" style="display:inline-flex">';
    html += le.hopeEmotions.map(e => `<span class="emotion-tag hope">${escapeHtml(e)}</span>`).join("");
    html += '</div></div>';
  }

  if (le.communicationNotes) {
    html += `<div class="language-note">${escapeHtml(le.communicationNotes)}</div>`;
  }
  if (le.notableShifts) {
    html += `<div class="language-note" style="margin-top:4px;font-style:italic">${escapeHtml(le.notableShifts)}</div>`;
  }

  container.innerHTML = html || '<div style="font-size:11px;color:var(--text-dim)">No language data available.</div>';
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

// ── Radar Chart (Canvas) ──

function renderRadarChart(d) {
  const canvas = $("radar-chart");
  if (!canvas) return;
  const a = d.rangeAnalysis;
  if (!a) { canvas.style.display = "none"; return; }
  canvas.style.display = "block";

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const size = Math.min(canvas.parentElement.getBoundingClientRect().width, 160);
  canvas.width = size * dpr; canvas.height = size * dpr;
  canvas.style.width = size + "px"; canvas.style.height = size + "px";
  ctx.scale(dpr, dpr);

  const cx = size / 2, cy = size / 2, radius = size * 0.30;

  // 7 axes: horsemen inverted + positives
  const labels = ["Lo Crit", "Lo Cont", "Lo Stone", "Lo Def",
                  "Fondness", "Turning", "Repair"];
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
  ctx.font = "7px -apple-system, sans-serif";
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
    const lx = cx + Math.cos(angle) * (radius + 14);
    const ly = cy + Math.sin(angle) * (radius + 14);
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
  const h = d.rangeAnalysis?.horsemen || {};
  const ev = d.rangeAnalysis?.evidence || {};
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
  const p = d.rangeAnalysis?.positives || {};
  const ev = d.rangeAnalysis?.evidence || {};
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
  const p = d.rangeAnalysis?.perel || {};
  const ev = d.rangeAnalysis?.evidence || {};
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

// ── Bank Account ──

function renderBankAccount(d) {
  const a = d.rangeAnalysis;
  const bank = a ? a.emotionalBankAccount : null;
  const ratioEl = $("bank-ratio");
  const statusEl = $("bank-status");
  const depEl = $("bank-deposits");
  const withEl = $("bank-withdrawals");

  if (!ratioEl) return;

  if (!bank) {
    ratioEl.textContent = "--";
    ratioEl.className = "bank-ratio";
    if (statusEl) { statusEl.textContent = "No data"; statusEl.className = "bank-status"; }
    if (depEl) depEl.textContent = "0";
    if (withEl) withEl.textContent = "0";
    return;
  }

  ratioEl.textContent = bank.ratio.toFixed(1) + ":1";
  ratioEl.className = "bank-ratio " + bank.status;
  if (statusEl) {
    statusEl.textContent = bank.status === "healthy" ? "Healthy" : bank.status === "watch" ? "Watch" : "Overdrawn";
    statusEl.className = "bank-status " + bank.status;
  }
  if (depEl) depEl.textContent = String(bank.deposits);
  if (withEl) withEl.textContent = String(bank.withdrawals);
}

// ── Bids ──

function renderBids(d) {
  const bids = d.rangeAnalysis ? d.rangeAnalysis.bids : null;
  const towardFill = $("bid-toward-fill");
  const awayFill = $("bid-away-fill");
  const againstFill = $("bid-against-fill");
  const towardVal = $("bid-toward-val");
  const awayVal = $("bid-away-val");
  const againstVal = $("bid-against-val");
  const summaryEl = $("bid-summary");

  if (!towardFill) return;

  if (!bids) {
    if (towardFill) towardFill.style.width = "0%";
    if (awayFill) awayFill.style.width = "0%";
    if (againstFill) againstFill.style.width = "0%";
    if (towardVal) towardVal.textContent = "0";
    if (awayVal) awayVal.textContent = "0";
    if (againstVal) againstVal.textContent = "0";
    if (summaryEl) summaryEl.textContent = "";
    return;
  }

  var total = (bids.turnedToward || 0) + (bids.turnedAway || 0) + (bids.turnedAgainst || 0);
  var maxVal = Math.max(total, 1);

  if (towardFill) towardFill.style.width = ((bids.turnedToward || 0) / maxVal * 100) + "%";
  if (awayFill) awayFill.style.width = ((bids.turnedAway || 0) / maxVal * 100) + "%";
  if (againstFill) againstFill.style.width = ((bids.turnedAgainst || 0) / maxVal * 100) + "%";

  if (towardVal) towardVal.textContent = String(bids.turnedToward || 0);
  if (awayVal) awayVal.textContent = String(bids.turnedAway || 0);
  if (againstVal) againstVal.textContent = String(bids.turnedAgainst || 0);

  if (summaryEl) {
    var totalBids = (bids.benMade || 0) + (bids.hopeMade || 0);
    var towardPct = total > 0 ? Math.round((bids.turnedToward || 0) / total * 100) : 0;
    summaryEl.textContent = totalBids + ' bids total (Ben: ' + (bids.benMade || 0) + ', Hope: ' + (bids.hopeMade || 0) + '). ' + towardPct + '% turned toward.';
  }
}

// ── Pursue-Withdraw ──

function renderPursueWithdraw(d) {
  const patternEl = $("pursue-pattern");
  const descEl = $("pursue-description");
  if (!patternEl) return;

  const pw = d.rangeAnalysis ? d.rangeAnalysis.pursueWithdraw : null;
  if (!pw) {
    patternEl.textContent = "--";
    patternEl.className = "pursue-pattern";
    if (descEl) descEl.textContent = "";
    return;
  }

  var labels = {
    "balanced": "Balanced",
    "ben-pursues": "Ben Pursues",
    "hope-pursues": "Hope Pursues",
    "mutual-withdrawal": "Mutual Withdrawal",
  };
  var cls = {
    "balanced": "balanced",
    "ben-pursues": "pursuing",
    "hope-pursues": "pursuing",
    "mutual-withdrawal": "withdrawal",
  };

  patternEl.textContent = labels[pw.pattern] || pw.pattern;
  patternEl.className = "pursue-pattern " + (cls[pw.pattern] || "");
  if (descEl) descEl.textContent = pw.description || "";
}

// ── Communication Balance ──

function renderCommunicationBalance(d) {
  // Message ratio
  var r = d.stats ? d.stats.messageRatio : null;
  var ben = r ? (r.benPercent || 50) : 50;
  var hope = r ? (r.hopePercent || 50) : 50;
  var ll = $("bal-ratio-left"), rl = $("bal-ratio-right");
  var lf = $("bal-ratio-fill-left"), rf = $("bal-ratio-fill-right");
  if (ll) ll.textContent = 'Ben: ' + Math.round(ben) + '%';
  if (rl) rl.textContent = 'Hope: ' + Math.round(hope) + '%';
  if (lf) lf.style.width = ben + "%";
  if (rf) rf.style.width = hope + "%";

  // Initiator stats
  var initEl = $("initiator-stats");
  if (initEl) {
    var inits = (d.stats && d.stats.initiators) || {};
    var benInits = inits.self || 0;
    var hopeInits = inits.hope || 0;
    initEl.innerHTML = '<span style="color:var(--accent)">Ben: ' + benInits + '</span> &middot; <span style="color:var(--pink)">Hope: ' + hopeInits + '</span>';
  }

  // Response times
  var rtEl = $("response-time-stats");
  if (rtEl) {
    var rt = (d.stats && d.stats.responseTimes) || {};
    function fmtTime(sec) {
      if (!sec) return "--";
      if (sec < 60) return sec + "s";
      if (sec < 3600) return Math.round(sec / 60) + "m";
      return (sec / 3600).toFixed(1) + "h";
    }
    var benAvg = fmtTime(rt.self ? rt.self.avgSec : null);
    var hopeAvg = fmtTime(rt.hope ? rt.hope.avgSec : null);
    rtEl.innerHTML = '<span style="color:var(--accent)">Ben: ' + benAvg + '</span> &middot; <span style="color:var(--pink)">Hope: ' + hopeAvg + '</span>';
  }
}

// ── Daily Cards (with voice tags) ──

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
      const isVoice = msg.type === "voice";
      const voiceTag = isVoice
        ? '<span class="message-voice-tag">&#9654; Voice</span>'
        : "";
      const content = isVoice
        ? (msg.transcript || msg.body || "[voice note]")
        : (msg.body || "[media]");
      return `<div class="message-item">
        <div class="message-sender ${cls}">${name}<span class="message-time">${time}</span>${voiceTag}</div>
        <div class="message-text">${escapeHtml(content)}</div>
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
