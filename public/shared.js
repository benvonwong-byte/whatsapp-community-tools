// ── Shared utilities used by all app pages ──

// Auth: check URL params (?token= or ?admin=) then localStorage
const _params = new URLSearchParams(window.location.search);
let adminToken = _params.get("token") || _params.get("admin") || localStorage.getItem("adminToken");
const isAdmin = !!adminToken;

// Strip token from URL immediately (keep URL clean)
if (_params.has("token") || _params.has("admin")) {
  if (adminToken) {
    localStorage.setItem("adminToken", adminToken);
  }
  const cleanUrl = window.location.pathname + window.location.hash;
  history.replaceState(null, "", cleanUrl);
} else if (adminToken && !localStorage.getItem("adminToken")) {
  localStorage.setItem("adminToken", adminToken);
}

// API base: use Railway URL when hosted on Firebase, relative path otherwise
const API_BASE =
  window.location.hostname.includes("firebaseapp.com") ||
  window.location.hostname.includes("web.app")
    ? "https://whatsapp-events-nyc-production.up.railway.app"
    : "";

// Fetch helpers
function adminFetch(path, opts = {}) {
  const headers = opts.headers ? { ...opts.headers } : {};
  headers["Authorization"] = `Bearer ${adminToken}`;
  return fetch(`${API_BASE}${path}`, { ...opts, headers });
}

function apiFetch(url, options = {}) {
  return fetch(`${API_BASE}${url}`, options);
}

// DOM shortcut
const $ = (id) => document.getElementById(id);

// HTML escaping
const _escEl = document.createElement("div");
function escapeHtml(str) {
  if (!str) return "";
  _escEl.textContent = str;
  return _escEl.innerHTML;
}

function escapeAttr(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Relative time formatting (handles SQLite datetime strings)
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
