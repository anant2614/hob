// HTML to readable text, small and synchronous, in one linear pass. Pages are
// untrusted, so no step may cost more than linear time on any input: a 2 MB
// page of `<` or of unclosed comments must not stall the agent. Good enough
// for v0's read_page; v1 moves to Browser Run's quickAction("markdown").

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

/** Elements whose content is never readable text, skipped up to their end tag. */
const SKIPPED = new Set(["script", "style", "noscript", "svg", "template", "iframe", "object", "canvas", "title", "nav", "footer"]);
/** Of those, the ones a browser reads as raw text: without an end tag, the rest of the document is their content. */
const RAW_TEXT = new Set(["script", "style", "noscript", "iframe", "title"]);
const BLOCK = new Set([
  "p", "div", "section", "article", "main", "header", "aside", "ul", "ol", "dl", "dt", "dd", "table", "thead", "tbody",
  "tfoot", "tr", "blockquote", "pre", "figure", "figcaption", "form", "fieldset", "details", "summary", "address", "hr"
]);
const TAG_NAME = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;
const HEADING = /^h([1-6])$/;

const LT = 0x3c;
const GT = 0x3e;
const EQUALS = 0x3d;
const SLASH = 0x2f;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

function isLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function collapse(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The index of the `>` that ends a tag, skipping quoted attribute values; -1 when the document ends first. */
function tagEnd(html: string, from: number): number {
  for (let i = from; i < html.length; ) {
    const code = html.charCodeAt(i);
    if (code === GT) return i;
    i++;
    if (code !== EQUALS) continue;
    while (i < html.length && isSpace(html.charCodeAt(i))) i++;
    const quote = html.charCodeAt(i);
    if (quote === DOUBLE_QUOTE || quote === SINGLE_QUOTE) {
      const close = html.indexOf(quote === DOUBLE_QUOTE ? '"' : "'", i + 1);
      if (close === -1) return -1;
      i = close + 1;
    }
  }
  return -1;
}

const endTagPatterns = new Map<string, RegExp>();

/** Where the end tag of `name` at or after `from` starts and ends, in any case; undefined when there is none. */
function findEndTag(html: string, name: string, from: number): { start: number; end: number } | undefined {
  let pattern = endTagPatterns.get(name);
  if (pattern === undefined) {
    pattern = new RegExp(`</${name}(?![a-z0-9:-])`, "gi");
    endTagPatterns.set(name, pattern);
  }
  pattern.lastIndex = from;
  const match = pattern.exec(html);
  if (match === null) return undefined;
  const close = html.indexOf(">", pattern.lastIndex);
  return { start: match.index, end: close === -1 ? html.length : close + 1 };
}

/** The entity-decoded value of attribute `wanted` in a start tag's attribute text. */
function attribute(attributes: string, wanted: string): string | undefined {
  const length = attributes.length;
  let i = 0;
  while (i < length) {
    while (i < length && (isSpace(attributes.charCodeAt(i)) || attributes.charCodeAt(i) === SLASH)) i++;
    const nameStart = i;
    while (i < length) {
      const code = attributes.charCodeAt(i);
      if (isSpace(code) || code === EQUALS || code === SLASH) break;
      i++;
    }
    const name = attributes.slice(nameStart, i).toLowerCase();
    if (name === "") {
      i++;
      continue;
    }
    while (i < length && isSpace(attributes.charCodeAt(i))) i++;
    let value = "";
    if (attributes.charCodeAt(i) === EQUALS) {
      i++;
      while (i < length && isSpace(attributes.charCodeAt(i))) i++;
      const quote = attributes.charCodeAt(i);
      if (quote === DOUBLE_QUOTE || quote === SINGLE_QUOTE) {
        const close = attributes.indexOf(quote === DOUBLE_QUOTE ? '"' : "'", i + 1);
        const stop = close === -1 ? length : close;
        value = attributes.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const start = i;
        while (i < length && !isSpace(attributes.charCodeAt(i))) i++;
        value = attributes.slice(start, i);
      }
    }
    if (name === wanted) return decodeEntities(value);
  }
  return undefined;
}

/** An absolute http(s) URL for a link target, or undefined for jumps and other schemes. */
function linkTarget(rawHref: string | undefined, baseUrl: string | undefined): string | undefined {
  const href = rawHref?.trim() ?? "";
  if (href === "" || href.startsWith("#")) return undefined;
  try {
    const url = baseUrl === undefined ? new URL(href) : new URL(href, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function htmlToText(html: string, baseUrl?: string): { title?: string; text: string } {
  const out: string[] = [];
  let title: string | undefined;
  // The link being read: its target, and where its label starts in `out`.
  let link: { readonly target: string | undefined; readonly from: number } | undefined;
  // Elements with no end tag anywhere after some point; never searched for again.
  const unclosed = new Set<string>();

  let i = 0; // where the scan resumes
  let textFrom = 0; // where the text not yet in `out` starts
  const flush = (to: number) => {
    if (to > textFrom) out.push(decodeEntities(html.slice(textFrom, to)));
  };

  const endLink = () => {
    if (link === undefined) return;
    const { target, from } = link;
    link = undefined;
    if (target === undefined) return;
    if (out.slice(from).join("").trim() === "") out.length = from;
    else out.push(` (${target})`);
  };

  const startTag = (name: string, attributes: string) => {
    if (name === "br") out.push("\n");
    else if (name === "li") out.push("\n- ");
    else if (name === "a") {
      endLink(); // links don't nest: a new one ends the open one, as in a browser
      link = { target: linkTarget(attribute(attributes, "href"), baseUrl), from: out.length };
    } else {
      const heading = HEADING.exec(name);
      if (heading) out.push(`\n\n${"#".repeat(Number(heading[1]))} `);
      else if (BLOCK.has(name)) out.push("\n\n");
    }
  };

  const endTag = (name: string) => {
    if (name === "a") endLink();
    else if (name === "td" || name === "th") out.push(" ");
    else if (HEADING.test(name) || BLOCK.has(name)) out.push("\n\n");
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const next = html.charCodeAt(lt + 1);

    // Comments, doctypes, CDATA and processing instructions. `<!-->` is an empty comment.
    if (next === 0x21 || next === 0x3f) {
      flush(lt);
      const close = html.startsWith("<!--", lt) ? html.indexOf("-->", lt + 2) : html.indexOf(">", lt + 2);
      i = close === -1 ? html.length : close + (html.startsWith("<!--", lt) ? 3 : 1);
      textFrom = i;
      continue;
    }

    // A `<` that starts no tag, as in "1 < 2", is text.
    const opens = isLetter(next) || (next === SLASH && isLetter(html.charCodeAt(lt + 2)));
    if (!opens) {
      i = lt + 1;
      continue;
    }
    TAG_NAME.lastIndex = lt;
    const match = TAG_NAME.exec(html);
    if (match === null) {
      i = lt + 1;
      continue;
    }
    flush(lt);
    const closing = match[1] === "/";
    const name = (match[2] ?? "").toLowerCase();
    const end = tagEnd(html, TAG_NAME.lastIndex);
    if (end === -1) {
      // A tag cut off by the end of the document is dropped, with nothing after it.
      i = textFrom = html.length;
      break;
    }
    const attributes = html.slice(TAG_NAME.lastIndex, end);
    i = textFrom = end + 1;

    if (closing) {
      endTag(name);
      continue;
    }
    if (SKIPPED.has(name) && !unclosed.has(name)) {
      const close = findEndTag(html, name, i);
      if (close === undefined) {
        if (RAW_TEXT.has(name)) {
          i = textFrom = html.length;
          break;
        }
        unclosed.add(name);
        continue;
      }
      if (name === "title" && title === undefined) {
        title = collapse(decodeEntities(html.slice(i, close.start))).replace(/\n/g, " ");
      }
      i = textFrom = close.end;
      continue;
    }
    startTag(name, attributes);
  }
  flush(html.length);
  endLink();

  const text = collapse(out.join(""));
  return title ? { title, text } : { text };
}
