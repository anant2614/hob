import { describe, expect, it } from "vitest";
import { htmlToText } from "../src/tools/html";

const PAGE = `<!doctype html>
<html>
  <head>
    <title>Hello &amp; welcome</title>
    <style>p { color: red }</style>
    <script>window.secret = "</p>not text";</script>
  </head>
  <body>
    <nav><a href="/">Menu</a></nav>
    <!-- a comment -->
    <h1>Main   title</h1>
    <p>First   para with <a href="/docs?x=1&amp;y=2">the docs</a> and <a href="#top">a jump</a>.</p>
    <script type="module">alert("x")</script>
    <ul><li>One</li><li>Two <b>bold</b></li></ul>
    <p>Caf&#233; &lt;b&gt; &#8217;&#x27; &nbsp;&mdash; done</p>
    <noscript>Enable JS</noscript>
    <footer>Foot</footer>
  </body>
</html>`;

describe("htmlToText", () => {
  const { title, text } = htmlToText(PAGE, "https://example.com/a/b");

  it("takes the document title, decoded", () => {
    expect(title).toBe("Hello & welcome");
  });

  it("drops scripts, styles, navigation, footers and comments", () => {
    for (const gone of ["alert", "window.secret", "not text", "color: red", "Menu", "Foot", "Enable JS", "a comment"]) {
      expect(text).not.toContain(gone);
    }
  });

  it("keeps link targets as absolute URLs, except in-page jumps", () => {
    expect(text).toContain("the docs (https://example.com/docs?x=1&y=2)");
    expect(text).toContain("a jump.");
    expect(text).not.toContain("#top");
  });

  it("marks headings and list items and decodes entities", () => {
    expect(text.split("\n")).toEqual(
      expect.arrayContaining([
        "# Main title",
        "First para with the docs (https://example.com/docs?x=1&y=2) and a jump.",
        "- One",
        "- Two bold",
        "Café <b> ’' — done"
      ])
    );
  });

  it("leaves no runs of blank lines or spaces", () => {
    expect(text).not.toMatch(/\n{3,}/);
    expect(text).not.toMatch(/ {2,}/);
    expect(text).toBe(text.trim());
  });

  it("returns no title for a fragment without one", () => {
    expect(htmlToText("<p>hi</p>")).toEqual({ text: "hi" });
  });
});

describe("htmlToText on awkward markup", () => {
  const read = (html: string) => htmlToText(html, "https://example.com/a/b").text;

  it("keeps a quoted > inside an attribute", () => {
    expect(read(`<a title="a > b" href="/x">link</a> after`)).toBe("link (https://example.com/x) after");
  });

  it("keeps a bare < that starts no tag", () => {
    expect(read("<p>1 < 2 and 3 > 2</p>")).toBe("1 < 2 and 3 > 2");
  });

  it("drops the rest of the page after an unclosed comment or script", () => {
    expect(read("<p>keep</p><!-- never closed <p>gone</p>")).toBe("keep");
    expect(read(`<p>keep</p><script>var s = "<p>gone</p>"`)).toBe("keep");
  });

  it("ends a comment at <!--> and skips doctypes and CDATA", () => {
    expect(read("<!doctype html><p>a<!-->b<![CDATA[gone]]></p>")).toBe("ab");
  });

  it("matches tags in any case", () => {
    expect(read("<SCRIPT>gone()</SCRIPT><P>Hi</P><Script>gone()</sCrIpT>")).toBe("Hi");
  });

  it("reads the body when the head is never closed", () => {
    expect(htmlToText("<html><head><title>T</title><body><p>Body</p>")).toEqual({ title: "T", text: "Body" });
  });

  it("does not hide the rest of the page behind an unclosed nav", () => {
    expect(read("<nav>menu <p>body</p>")).toContain("body");
  });

  it("drops a tag cut off at the end of the document", () => {
    expect(read(`<p>ok</p><a href="/x`)).toBe("ok");
  });

  it("ends an open link when the next one starts", () => {
    expect(read(`<a href="/1">one<a href="/2">two</a>`)).toBe(
      "one (https://example.com/1)two (https://example.com/2)"
    );
  });

  it("converts hostile 2 MB documents in linear time", () => {
    const size = 2 * 1024 * 1024;
    const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length));
    const hostile = {
      "bare <": fill("<"),
      "unclosed comments": fill("<!--"),
      "unclosed links": fill("<a>"),
      "unclosed scripts": fill("<script>"),
      "unclosed titles": fill("<title>"),
      "unterminated tags": fill("<p"),
      "one endless attribute": `<a href="${fill("x")}`,
      "deep nesting": fill("<div>"),
      "unclosed navs": fill("<nav>x"),
      "entity soup": fill("&#1")
    };
    const slow: string[] = [];
    for (const [name, html] of Object.entries(hostile)) {
      const started = performance.now();
      htmlToText(html, "https://example.com/");
      const ms = performance.now() - started;
      // Linear runs take well under 300 ms here; the old quadratic regexes took minutes.
      if (ms > 2000) slow.push(`${name}: ${Math.round(ms)} ms`);
    }
    expect(slow).toEqual([]);
  }, 120_000);
});
