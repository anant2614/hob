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
