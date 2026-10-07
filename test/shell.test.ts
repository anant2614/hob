import { describe, expect, it } from "vitest";
import headers from "../public/_headers?raw";
import shell from "../index.html?raw";

function csp(): Map<string, string[]> {
  const line = headers.split("\n").find((entry) => entry.trim().startsWith("Content-Security-Policy:")) ?? "";
  const policy = line.slice(line.indexOf(":") + 1);
  return new Map(
    policy
      .split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...sources]) => [name ?? "", sources])
  );
}

describe("the static shell", () => {
  it("lets the page contact and load scripts only from its own origin", () => {
    const policy = csp();
    // 'self' already covers the same-origin wss://…/chat socket.
    expect(policy.get("connect-src")).toEqual(["'self'"]);
    expect(policy.get("script-src")).toEqual(["'self'"]);
    expect(policy.get("default-src")).toEqual(["'self'"]);
    for (const [name, sources] of policy) {
      for (const scheme of ["*", "http:", "https:", "ws:", "wss:"]) expect(sources, name).not.toContain(scheme);
    }
  });

  it("fetches the manifest with the Access cookie, so Add to Home Screen works behind Access", () => {
    expect(shell).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials"/);
  });
});
