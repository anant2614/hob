import { describe, expect, it } from "vitest";
import { extractHosts, hostOf } from "../src/tools/hosts";

describe("hostOf", () => {
  it.each([
    ["https://Example.com/a?b=c", "example.com"],
    ["http://www.example.com", "example.com"],
    ["https://docs.python.org:443/3/", "docs.python.org"],
    ["not a url", undefined],
    ["mailto:someone@example.com", undefined]
  ])("%j → %j", (url, want) => {
    expect(hostOf(url)).toBe(want);
  });
});

describe("extractHosts", () => {
  it("finds hosts in URLs and bare domains the owner typed", () => {
    expect(
      extractHosts("Read https://Example.com/post?id=1 then check docs.python.org and www.bbc.co.uk.")
    ).toEqual(["example.com", "docs.python.org", "bbc.co.uk"]);
  });

  it("returns each host once and nothing for plain text", () => {
    expect(extractHosts("see example.com, then example.com/again")).toEqual(["example.com"]);
    expect(extractHosts("remember that I like tea")).toEqual([]);
  });
});
