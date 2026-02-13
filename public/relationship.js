// Auth: check localStorage for admin token (same pattern as main app)
const adminToken = localStorage.getItem("adminToken");
const isAdmin = !!adminToken;

// API base: use Railway URL when hosted on Firebase, relative path otherwise
const API_BASE =
  window.location.hostname.includes("firebaseapp.com") ||
  window.location.hostname.includes("web.app")
    ? "https://whatsapp-events-nyc-production.up.railway.app"
    : "";

// Admin fetch helper — adds auth token
function adminFetch(path, opts = {}) {
  const separator = path.includes("?") ? "&" : "?";
  return fetch(
    `${API_BASE}${path}${separator}token=${encodeURIComponent(adminToken)}`,
    opts
  );
}

// State
let dashboardData = null;
let refreshTimer = null;
let expandedCards = new Set();

// ── Init ──

document.addEventListener("DOMContentLoaded", () => {
  if (!isAdmin) {
    document.getElementById("login-gate").classList.remove("hidden");
    document.getElementById("analyze-btn").classList.add("hidden");
    return;
  }

  document.getElementById("main-content").classList.remove("hidden");
  setupAnalyzeButton();
  loadDashboard();

  // Auto-refresh every 60 seconds
  refreshTimer = setInterval(loadDashboard, 60000);
});

// ── Data Loading ──

async function loadDashboard() {
  try {
    const res = await adminFetch("/api/relationship/dashboard");
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }
    dashboardData = await res.json();
    renderDashboard();
  } catch (err) {
    console.error("Failed to load dashboard:", err);
    document.getElementById("loading-state").classList.add("hidden");
    const errorEl = document.getElementById("error-state");
    errorEl.textContent = `Failed to load dashboard: ${err.message}`;
    errorEl.classList.remove("hidden");
  }
}

// ── Analyze Now ──

function setupAnalyzeButton() {
  const btn = document.getElementById("analyze-btn");
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Analyzing...";
    try {
      const res = await adminFetch("/api/relationship/analyze", {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server returned ${res.status}`);
      }
      await loadDashboard();
    } catch (err) {
      console.error("Analysis failed:", err);
      alert("Analysis failed: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Analyze Now";
    }
  });
}

// ── Rendering ──

function renderDashboard() {
  document.getElementById("loading-state").classList.add("hidden");
  document.getElementById("error-state").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");

  const d = dashboardData;

  renderMonitorBar(d);
  renderStats(d);
  renderRatio(d);
  renderLatestAnalysis(d);
  renderHorsemen(d);
  renderPositives(d);
  renderPerel(d);
  renderTrendChart(d);
  renderDailyCards(d);
}

// ── Monitor Bar ──

function renderMonitorBar(d) {
  const dot = document.getElementById("monitor-dot");
  const lastMsgEl = document.getElementById("monitor-last-msg");
  const todayEl = document.getElementById("monitor-today-count");

  const lastMsg = d.monitoring?.lastMessageAt;
  const todayCount = d.monitoring?.messagesToday ?? 0;

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

// ── Stats Panel ──

function renderStats(d) {
  const stats = d.stats || {};
  document.getElementById("stat-total-messages").textContent =
    (stats.totalMessages ?? 0).toLocaleString();
  document.getElementById("stat-voice-minutes").textContent =
    (stats.voiceMinutes ?? 0).toLocaleString();
  document.getElementById("stat-days-tracked").textContent =
    (stats.daysTracked ?? 0).toLocaleString();

  const avg =
    stats.daysTracked > 0
      ? Math.round(stats.totalMessages / stats.daysTracked)
      : 0;
  document.getElementById("stat-avg-per-day").textContent = avg.toLocaleString();
}

// ── Message Ratio ──

function renderRatio(d) {
  const ratio = d.stats?.messageRatio || {};
  const benPct = ratio.benPercent ?? 50;
  const hopePct = ratio.hopePercent ?? 50;

  document.getElementById("ratio-left-label").textContent = `Ben: ${Math.round(benPct)}%`;
  document.getElementById("ratio-right-label").textContent = `Hope: ${Math.round(hopePct)}%`;
  document.getElementById("ratio-fill-left").style.width = benPct + "%";
  document.getElementById("ratio-fill-right").style.width = hopePct + "%";
}

// ── Latest Analysis ──

function renderLatestAnalysis(d) {
  const analysis = d.latestAnalysis;
  const scoreEl = document.getElementById("health-score");
  const summaryEl = document.getElementById("health-summary");
  const dateEl = document.getElementById("health-date");

  if (!analysis) {
    scoreEl.textContent = "--";
    scoreEl.className = "health-score-number";
    summaryEl.textContent =
      'No analysis available yet. Click "Analyze Now" to generate one.';
    dateEl.textContent = "";
    return;
  }

  const score = analysis.overallScore ?? 0;
  scoreEl.textContent = Math.round(score);
  scoreEl.className = "health-score-number " + scoreColor(score);

  summaryEl.textContent = analysis.summary || "No summary available.";

  if (analysis.date) {
    const dateObj = new Date(analysis.date);
    dateEl.textContent =
      "Analysis from " +
      dateObj.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
  }
}

// ── Gottman Four Horsemen ──

function renderHorsemen(d) {
  const container = document.getElementById("horsemen-bars");
  const horsemen = d.latestAnalysis?.horsemen || {};

  const items = [
    { key: "criticism", label: "Criticism" },
    { key: "contempt", label: "Contempt" },
    { key: "stonewalling", label: "Stonewalling" },
    { key: "defensiveness", label: "Defensiveness" },
  ];

  container.innerHTML = items
    .map((item) => {
      const val = horsemen[item.key] ?? 0;
      const colorClass =
        val > 60 ? "horseman" : val > 30 ? "horseman mid" : "horseman low";
      return metricBarHTML(item.label, val, colorClass);
    })
    .join("");
}

// ── Gottman Positives ──

function renderPositives(d) {
  const container = document.getElementById("positives-bars");
  const positives = d.latestAnalysis?.positives || {};

  const items = [
    { key: "fondness", label: "Fondness" },
    { key: "turningToward", label: "Turning Toward" },
    { key: "repair", label: "Repair Attempts" },
  ];

  container.innerHTML = items
    .map((item) => {
      const val = positives[item.key] ?? 0;
      const colorClass =
        val >= 60 ? "positive" : val >= 30 ? "positive mid" : "positive low";
      return metricBarHTML(item.label, val, colorClass);
    })
    .join("");
}

// ── Perel Dimensions ──

function renderPerel(d) {
  const container = document.getElementById("perel-bars");
  const perel = d.latestAnalysis?.perel || {};

  const items = [
    { key: "curiosity", label: "Curiosity" },
    { key: "playfulness", label: "Playfulness" },
    { key: "autonomyBalance", label: "Autonomy Balance" },
  ];

  container.innerHTML = items
    .map((item) => {
      const val = perel[item.key] ?? 0;
      return metricBarHTML(item.label, val, "perel");
    })
    .join("");
}

function metricBarHTML(label, value, colorClass) {
  const pct = Math.max(0, Math.min(100, value));
  return `
    <div class="metric-row">
      <span class="metric-label">${escapeHtml(label)}</span>
      <div class="metric-bar-bg">
        <div class="metric-bar-fill ${colorClass}" style="width: ${pct}%"></div>
      </div>
      <span class="metric-value">${Math.round(value)}</span>
    </div>`;
}

// ── Trend Chart (Canvas) ──

function renderTrendChart(d) {
  const canvas = document.getElementById("trend-chart");
  const emptyEl = document.getElementById("chart-empty");
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

  const W = rect.width;
  const H = rect.height;
  const padLeft = 40;
  const padRight = 16;
  const padTop = 16;
  const padBottom = 32;
  const chartW = W - padLeft - padRight;
  const chartH = H - padTop - padBottom;

  ctx.clearRect(0, 0, W, H);

  // Y-axis: 0 to 100
  const minY = 0;
  const maxY = 100;

  // Grid lines
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.font = "11px -apple-system, sans-serif";
  ctx.fillStyle = "#888";
  ctx.textAlign = "right";

  for (let yVal = 0; yVal <= 100; yVal += 25) {
    const y = padTop + chartH - (yVal / 100) * chartH;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(W - padRight, y);
    ctx.stroke();
    ctx.fillText(yVal.toString(), padLeft - 6, y + 4);
  }

  // Color zones (subtle background bands)
  // Red zone: 0-40
  ctx.fillStyle = "rgba(214, 48, 49, 0.05)";
  const redTop = padTop + chartH - (40 / 100) * chartH;
  ctx.fillRect(padLeft, redTop, chartW, padTop + chartH - redTop);

  // Yellow zone: 40-70
  ctx.fillStyle = "rgba(253, 203, 110, 0.04)";
  const yellowTop = padTop + chartH - (70 / 100) * chartH;
  ctx.fillRect(padLeft, yellowTop, chartW, redTop - yellowTop);

  // Green zone: 70-100
  ctx.fillStyle = "rgba(0, 184, 148, 0.04)";
  ctx.fillRect(padLeft, padTop, chartW, yellowTop - padTop);

  // Data points
  const points = trend.map((pt, i) => {
    const x = padLeft + (i / (trend.length - 1)) * chartW;
    const score = Math.max(minY, Math.min(maxY, pt.score ?? 0));
    const y = padTop + chartH - ((score - minY) / (maxY - minY)) * chartH;
    return { x, y, score, date: pt.date };
  });

  // Line
  ctx.beginPath();
  ctx.strokeStyle = "#4fc3f7";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  points.forEach((pt, i) => {
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  });
  ctx.stroke();

  // Gradient fill under line
  const gradient = ctx.createLinearGradient(0, padTop, 0, padTop + chartH);
  gradient.addColorStop(0, "rgba(79, 195, 247, 0.2)");
  gradient.addColorStop(1, "rgba(79, 195, 247, 0)");
  ctx.beginPath();
  points.forEach((pt, i) => {
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  });
  ctx.lineTo(points[points.length - 1].x, padTop + chartH);
  ctx.lineTo(points[0].x, padTop + chartH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Dots
  points.forEach((pt) => {
    const color =
      pt.score >= 70 ? "#00b894" : pt.score >= 40 ? "#fdcb6e" : "#d63031";
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  // X-axis date labels (show first, last, and a few in between)
  ctx.fillStyle = "#888";
  ctx.textAlign = "center";
  ctx.font = "10px -apple-system, sans-serif";

  const labelStep = Math.max(1, Math.floor(trend.length / 6));
  for (let i = 0; i < trend.length; i += labelStep) {
    const pt = points[i];
    const dateObj = new Date(trend[i].date + "T00:00:00");
    const label = dateObj.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    ctx.fillText(label, pt.x, H - 8);
  }
  // Always show last label
  if (trend.length > 1) {
    const last = points[points.length - 1];
    const lastDate = new Date(trend[trend.length - 1].date + "T00:00:00");
    const lastLabel = lastDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    ctx.fillText(lastLabel, last.x, H - 8);
  }
}

// ── Daily Cards ──

function renderDailyCards(d) {
  const container = document.getElementById("daily-cards");
  const emptyEl = document.getElementById("daily-empty");
  const days = d.dailyAnalyses || [];

  if (days.length === 0) {
    container.innerHTML = "";
    emptyEl.classList.remove("hidden");
    return;
  }

  emptyEl.classList.add("hidden");

  container.innerHTML = days
    .map((day) => {
      const dateObj = new Date(day.date + "T00:00:00");
      const dateLabel = dateObj.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      const score = day.overallScore ?? 0;
      const expanded = expandedCards.has(day.date);

      return `
      <div class="daily-card${expanded ? " expanded" : ""}" data-date="${escapeAttr(day.date)}">
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
    })
    .join("");

  // Attach click listeners
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
    const res = await adminFetch(
      `/api/relationship/messages?date=${encodeURIComponent(date)}`
    );
    if (!res.ok) throw new Error("Failed to fetch messages");
    const messages = await res.json();

    if (messages.length === 0) {
      messagesEl.innerHTML =
        '<div class="loading-messages">No messages found for this date.</div>';
      return;
    }

    messagesEl.innerHTML = messages
      .map((msg) => {
        const senderClass = (msg.sender || "").toLowerCase().includes("ben")
          ? "ben"
          : "hope";
        const timeStr = msg.timestamp
          ? new Date(msg.timestamp).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
            })
          : "";
        const typeBadge =
          msg.type && msg.type !== "text"
            ? `<span class="message-type-badge">${escapeHtml(msg.type)}</span>`
            : "";

        return `
        <div class="message-item">
          <div class="message-sender ${senderClass}">
            ${escapeHtml(msg.sender || "Unknown")}
            <span class="message-time">${timeStr}</span>
            ${typeBadge}
          </div>
          <div class="message-text">${escapeHtml(msg.text || msg.body || "[media]")}</div>
        </div>`;
      })
      .join("");
  } catch (err) {
    console.error("Failed to load messages:", err);
    messagesEl.innerHTML = `<div class="loading-messages" style="color: var(--red);">Failed to load messages: ${escapeHtml(err.message)}</div>`;
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
