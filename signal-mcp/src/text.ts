export function joinNames(...parts: Array<string | null | undefined>): string | null {
  const joined = parts.filter(Boolean).join(" ").trim();
  return joined || null;
}

/** Signal puts U+FFFC placeholders where mentions go (UTF-16 offsets); swap them for @Name. */
export function replaceMentions(text: string, mentions: Array<{ start: number; length: number; name: string }>): string {
  let result = text;
  for (const m of [...mentions].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, m.start) + `@${m.name}` + result.slice(m.start + m.length);
  }
  return result;
}
