// HTML to readable text, small and synchronous. It is good enough for v0's
// read_page; v1 moves to Browser Run's quickAction("markdown").

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
  times: "×",
  deg: "°"
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, name: string) => {
    if (name.startsWith("#")) {
      const hex = name[1] === "x" || name[1] === "X";
      const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** Elements whose content is never readable text. */
const SKIPPED = /<(script|style|noscript|svg|template|iframe|object|canvas|head|title|nav|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK =
  /<\/?(?:p|div|section|article|main|header|aside|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|blockquote|pre|figure|figcaption|form|fieldset|details|summary|address|hr)\b[^>]*>/gi;
const LINK = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

function collapse(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** An absolute http(s) URL for a link target, or undefined for jumps and other schemes. */
function linkTarget(rawHref: string, baseUrl: string | undefined): string | undefined {
  const href = decodeEntities(rawHref.trim());
  if (href === "" || href.startsWith("#")) return undefined;
  try {
    const url = baseUrl === undefined ? new URL(href) : new URL(href, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function htmlToText(html: string, baseUrl?: string): { title?: string; text: string } {
  let doc = html.replace(/<!--[\s\S]*?-->/g, "");
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(doc);
  const title = titleMatch ? collapse(decodeEntities(titleMatch[1] ?? "")).replace(/\n/g, " ") : "";

  doc = doc
    .replace(SKIPPED, " ")
    .replace(LINK, (_match, attributes: string, inner: string) => {
      const href = HREF.exec(attributes);
      const target = href ? linkTarget(href[1] ?? href[2] ?? href[3] ?? "", baseUrl) : undefined;
      const label = inner.replace(/<[^>]*>/g, " ").trim();
      if (target === undefined) return label;
      if (label === "") return "";
      // Re-escape `&` so the entity pass below turns it back into a literal `&`.
      return `${label} (${target.replace(/&/g, "&amp;")})`;
    })
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li\s*>/gi, "")
    .replace(/<h([1-6])\b[^>]*>/gi, (_match, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(BLOCK, "\n\n")
    .replace(/<[^>]*>/g, "");

  const text = collapse(decodeEntities(doc));
  return title === "" ? { text } : { title, text };
}
