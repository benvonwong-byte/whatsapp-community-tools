export interface LinkPreview {
  url?: string | null;
  title?: string | null;
  description?: string | null;
}

export interface ExtractedLink {
  /** The URL as it was shared. */
  url: string;
  /** The shared URL without tracking parameters or fragment, for display. */
  cleanUrl: string;
  /** Canonical form used to recognise the same link shared in different places. */
  normalizedUrl: string;
  domain: string;
  title: string | null;
  description: string | null;
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?'"*_~]+$/;
const BRACKETS: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };

// Query parameters that only track where a click came from.
const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "igshid", "igsh",
  "mc_cid", "mc_eid", "ref_src", "ref_url", "_hsenc", "_hsmi", "mkt_tok",
]);
// `si` is a share-tracking id on these sites but can be meaningful elsewhere.
const SI_TRACKING_DOMAINS = new Set(["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "open.spotify.com"]);

/** Strip punctuation that ends a sentence rather than the URL, keeping balanced brackets. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const before = url;
    url = url.replace(TRAILING_PUNCTUATION, "");
    const last = url[url.length - 1];
    const open = BRACKETS[last];
    if (open && url.split(open).length <= url.split(last).length - 1) url = url.slice(0, -1);
    if (url === before) return url;
  }
}

export function normalizeUrl(raw: string): Pick<ExtractedLink, "url" | "cleanUrl" | "normalizedUrl" | "domain"> | null {
  const url = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(/^www\./i.test(url) ? `https://${url}` : url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const domain = parsed.hostname.replace(/^www\./, "");
  if (!domain.includes(".")) return null;

  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower) || (lower === "si" && SI_TRACKING_DOMAINS.has(domain))) {
      parsed.searchParams.delete(key);
    }
  }
  const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : "";
  const port = parsed.port ? `:${parsed.port}` : "";
  parsed.hash = "";
  return {
    url,
    cleanUrl: parsed.href.replace(/\/$/, ""),
    normalizedUrl: `https://${domain}${port}${path}${parsed.search}`,
    domain,
  };
}

/** Links in a message's text and link previews, one entry per distinct URL. */
export function extractLinks(text: string | null | undefined, previews: LinkPreview[] = []): ExtractedLink[] {
  const byUrl = new Map<string, ExtractedLink>();
  const add = (raw: string, preview?: LinkPreview) => {
    const n = normalizeUrl(raw);
    if (!n) return;
    const existing = byUrl.get(n.normalizedUrl);
    if (existing) {
      existing.title ??= preview?.title || null;
      existing.description ??= preview?.description || null;
    } else {
      byUrl.set(n.normalizedUrl, { ...n, title: preview?.title || null, description: preview?.description || null });
    }
  };
  for (const match of text?.matchAll(URL_RE) ?? []) add(trimUrl(match[0]));
  for (const p of previews) if (p?.url) add(p.url, p);
  return [...byUrl.values()];
}
