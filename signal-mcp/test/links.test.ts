import assert from "node:assert/strict";
import { test } from "node:test";
import { extractLinks, normalizeUrl } from "../src/links";

const urls = (text: string) => extractLinks(text).map((l) => l.url);

test("trims sentence punctuation but keeps URL characters", () => {
  assert.deepEqual(urls("Read this: https://example.com/a?b=1."), ["https://example.com/a?b=1"]);
  assert.deepEqual(urls("Wow https://example.com/page!!"), ["https://example.com/page"]);
  assert.deepEqual(urls('"https://example.com/quoted"'), ["https://example.com/quoted"]);
});

test("keeps balanced brackets and drops wrapping ones", () => {
  assert.deepEqual(urls("see https://en.wikipedia.org/wiki/Foo_(bar)"), ["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  assert.deepEqual(urls("(see https://example.com/x)"), ["https://example.com/x"]);
  assert.deepEqual(urls("(https://en.wikipedia.org/wiki/Foo_(bar))."), ["https://en.wikipedia.org/wiki/Foo_(bar)"]);
});

test("finds www links and ignores non-web schemes", () => {
  assert.deepEqual(urls("go to www.example.org/events today"), ["www.example.org/events"]);
  assert.deepEqual(urls("mailto:a@b.com ftp://example.com sgnl://linkdevice"), []);
});

test("normalizes so the same link shared differently groups together", () => {
  const variants = [
    "https://www.nytimes.com/2026/10/01/climate.html?utm_source=signal&utm_medium=share",
    "http://nytimes.com/2026/10/01/climate.html/",
    "https://nytimes.com/2026/10/01/climate.html#comments",
    "https://NYTimes.com/2026/10/01/climate.html?fbclid=abc",
  ];
  const normalized = new Set(variants.map((v) => normalizeUrl(v)?.normalizedUrl));
  assert.deepEqual([...normalized], ["https://nytimes.com/2026/10/01/climate.html"]);
  assert.equal(normalizeUrl(variants[0])?.domain, "nytimes.com");
});

test("clean URLs drop tracking and fragments but keep the original host", () => {
  const n = normalizeUrl("https://www.nytimes.com/2026/climate.html?utm_source=x&id=7#comments");
  assert.equal(n?.cleanUrl, "https://www.nytimes.com/2026/climate.html?id=7");
  assert.equal(normalizeUrl("https://lu.ma/?utm_campaign=y")?.cleanUrl, "https://lu.ma");
});

test("strips share-tracking `si` only where it is tracking", () => {
  assert.equal(normalizeUrl("https://youtu.be/abc123?si=XYZ&t=42")?.normalizedUrl, "https://youtu.be/abc123?t=42");
  assert.equal(normalizeUrl("https://example.com/search?si=1")?.normalizedUrl, "https://example.com/search?si=1");
});

test("merges preview titles into links found in the text", () => {
  const links = extractLinks("Great read: https://www.nytimes.com/climate.html?utm_source=x", [
    { url: "https://www.nytimes.com/climate.html", title: "The Climate Report", description: "Numbers" },
    { url: "https://other.example.com/only-in-preview", title: "Preview only" },
  ]);
  assert.equal(links.length, 2);
  assert.equal(links[0].title, "The Climate Report");
  assert.equal(links[0].url, "https://www.nytimes.com/climate.html?utm_source=x");
  assert.equal(links[1].normalizedUrl, "https://other.example.com/only-in-preview");
});

test("dedupes repeated links within a message", () => {
  assert.equal(extractLinks("https://a.example.com and again https://a.example.com/").length, 1);
});
