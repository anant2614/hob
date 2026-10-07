import { getAgentByName } from "agents";
import { authenticate } from "./auth/access";
import { stripInternalHeaders } from "./auth/headers";
import { agentName } from "./auth/principal";

export { PiAgent } from "./agent/agent";

/**
 * The stateless edge. Static assets never reach it (Workers Assets serves
 * them, behind the same hostname-based Access application). It authenticates,
 * strips headers the SDK would trust, and routes to the Durable Object whose
 * name the server derives from the principal. The browser never names one.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const principal = await authenticate(request, env);
    if (principal === null) return new Response("Forbidden", { status: 403 });

    // Exactly /chat: the SDK would route paths such as /chat/sub/<class>/<name> to child objects.
    if (url.pathname !== "/chat") return new Response("Not found", { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426, headers: { upgrade: "websocket" } });
    }
    // Browsers always send Origin on a WebSocket handshake; refuse other sites' pages.
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) return new Response("Forbidden", { status: 403 });

    const agent = await getAgentByName(env.PiAgent, agentName(principal));
    return agent.fetch(new Request(request, { headers: stripInternalHeaders(request.headers) }));
  }
} satisfies ExportedHandler<Env>;
