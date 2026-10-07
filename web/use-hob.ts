import type { AgentEvent } from "@earendil-works/pi-durable";
import { useAgent } from "agents/react";
import { useCallback, useReducer } from "react";
import { ROOT_CONVERSATION, type ClientMessage, type ServerMessage, type WhenBusy } from "../src/shared/protocol";
import { INITIAL_APP, reduceApp } from "./state";

/** `WebSocket.OPEN`. */
const OPEN = 1;

/**
 * Hob over its WebSocket. The browser never names a Durable Object: it
 * connects to /chat and the Worker routes the owner to theirs. A reconnect
 * gets a fresh snapshot, which replaces the view.
 */
export function useHob() {
  const [state, dispatch] = useReducer(reduceApp, INITIAL_APP);

  const agent = useAgent({
    agent: "PiAgent",
    basePath: "chat",
    query: { session: ROOT_CONVERSATION },
    onOpen: () => dispatch({ type: "open" }),
    onClose: () => dispatch({ type: "closed" }),
    onMessage: (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      try {
        dispatch({ type: "server", message: JSON.parse(event.data) as ServerMessage<AgentEvent> });
      } catch {
        // Not one of ours.
      }
    }
  });

  const send = useCallback(
    (message: ClientMessage): boolean => {
      if (agent.readyState !== OPEN) {
        dispatch({ type: "notice", text: "Hob is offline right now. Your message is still in the box." });
        return false;
      }
      agent.send(JSON.stringify(message));
      return true;
    },
    [agent]
  );

  /** Idle: starts an answer. Busy: queued as a follow-up, or with "steer" folded into the running answer. */
  const submit = useCallback(
    (input: string, whenBusy: WhenBusy = "followUp") =>
      send({ type: "submit", id: crypto.randomUUID(), operationId: crypto.randomUUID(), input, whenBusy }),
    [send]
  );
  const stop = useCallback(() => send({ type: "abort", id: crypto.randomUUID() }), [send]);
  const newTopic = useCallback(() => send({ type: "reset", id: crypto.randomUUID() }), [send]);
  const saveMemory = useCallback(
    (key: string, text: string) => send({ type: "memory_set", id: crypto.randomUUID(), key, text }),
    [send]
  );
  const deleteMemory = useCallback((key: string) => send({ type: "memory_delete", id: crypto.randomUUID(), key }), [send]);
  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);

  return { ...state, submit, stop, newTopic, saveMemory, deleteMemory, dismiss };
}
