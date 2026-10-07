/** Normalize a hostname for comparison: lowercase, no leading `www.`. */
export function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

/** The normalized host of an http(s) URL, or undefined for anything else. */
export function hostOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return parsed.hostname === "" ? undefined : normalizeHost(parsed.hostname);
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const DOMAIN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;

/** Hosts named in free text, as full URLs or bare domains, in order of first mention. */
export function extractHosts(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.match(URL_PATTERN) ?? []) {
    const host = hostOf(match);
    if (host !== undefined) hosts.add(host);
  }
  const rest = text.replace(URL_PATTERN, " ");
  for (const match of rest.match(DOMAIN_PATTERN) ?? []) hosts.add(normalizeHost(match));
  return [...hosts];
}
