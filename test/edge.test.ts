import { runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CONNECT_HEADERS } from "./worker";
import { fetchChat, follow } from "./ws";

describe("the edge Worker", () => {
  it("connects the owner's browser on localhost when DEV_AUTH is set", async () => {
    const response = await fetchChat("http://localhost/chat?session=1", { origin: "http://localhost" });
    expect(response.status).toBe(101);
    const socket = response.webSocket as WebSocket;
    socket.accept();
    const client = follow(socket);
    await client.until(() => client.frames.some((frame) => frame.type === "hello"), "hello");
    socket.close();
  });

  it("forbids a request with no Access token on a real hostname", async () => {
    const response = await fetchChat("https://agent.example.com/chat?session=1");
    expect(response.status).toBe(403);
  });

  it("forbids a WebSocket opened from another site", async () => {
    const response = await fetchChat("http://localhost/chat?session=1", { origin: "https://evil.example" });
    expect(response.status).toBe(403);
  });

  it("only serves the exact /chat path", async () => {
    expect((await fetchChat("http://localhost/chat/sub/pi-agent/other")).status).toBe(404);
    expect((await fetchChat("http://localhost/chat/")).status).toBe(404);
  });

  it("asks for a WebSocket on /chat", async () => {
    expect((await SELF.fetch("http://localhost/chat")).status).toBe(426);
  });

  it("strips internal and credential headers before the agent sees the request", async () => {
    const response = await fetchChat("http://localhost/chat?session=1", {
      "x-agents-lifecycle-props": btoa(JSON.stringify({ evil: true })),
      "x-partykit-props": "{}",
      "x-cf-agents-subagent-url": "https://evil.example/",
      "cf-access-jwt-assertion": "not-a-jwt",
      cookie: "CF_Authorization=abc"
    });
    expect(response.status).toBe(101);
    (response.webSocket as WebSocket).accept();
    const seen = await runInDurableObject(env.PiAgent.getByName("u:usr_test"), (_instance, state) =>
      state.storage.kv.get<string[]>(CONNECT_HEADERS)
    );
    expect(seen).toContain("upgrade");
    for (const header of [
      "x-agents-lifecycle-props",
      "x-partykit-props",
      "x-cf-agents-subagent-url",
      "cf-access-jwt-assertion",
      "cookie"
    ]) {
      expect(seen).not.toContain(header);
    }
    (response.webSocket as WebSocket).close();
  });
});
