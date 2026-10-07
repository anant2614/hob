import type { AgentEvent } from "@earendil-works/pi-durable";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ROOT_CONVERSATION, type ClientMessage, type ServerMessage, type WhenBusy } from "../src/shared/protocol";
import { Outbox, Requests, type SubmitMessage } from "./outbox";
import { INITIAL_APP, reduceApp } from "./state";

/** `WebSocket.OPEN`. */
const OPEN = 1;
/** How long a submission may go unanswered before the socket is presumed dead and replaced. */
const ANSWER_TIMEOUT_MS = 10_000;
const OFFLINE = "Hob is offline right now. Try again once it's back.";

/**
 * Hob over its WebSocket. The browser never names a Durable Object: it
 * connects to /chat and the Worker routes the owner to theirs. A reconnect
 * gets a fresh snapshot, which replaces the view, and sends again whatever
 * the agent hadn't acknowledged.
 */
export function useHob() {
  const [state, dispatch] = useReducer(reduceApp, INITIAL_APP);
  const [outbox] = useState(() => new Outbox());
  const [requests] = useState(() => new Requests());
  const socket = useRef<{ send(data: string): void } | null>(null);

  const agent = useAgent({
    agent: "PiAgent",
    basePath: "chat",
    query: { session: ROOT_CONVERSATION },
    onOpen: () => {
      dispatch({ type: "open" });
      // Whatever the last socket may have lost; the agent drops duplicates.
      for (const message of outbox.resend(Date.now())) socket.current?.send(JSON.stringify(message));
    },
    onClose: () => {
      dispatch({ type: "closed" });
      requests.failAll("Hob went offline before answering. Try again once it's back.");
    },
    onMessage: (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let frame: ServerMessage<AgentEvent>;
      try {
        frame = JSON.parse(event.data) as ServerMessage<AgentEvent>;
      } catch {
        return; // Not one of ours.
      }
      if (typeof frame !== "object" || frame === null) return;
      if ((frame.type === "result" || frame.type === "error") && frame.id !== undefined) {
        outbox.settle(frame.id);
        if (requests.settle(frame)) return; // The caller shows this answer.
      }
      dispatch({ type: "server", message: frame });
    }
  });
  socket.current = agent;

  // A socket can look open and deliver nothing, as after a phone sleeps. When a
  // submission goes unanswered, replace the socket; the new one resends it.
  useEffect(() => {
    const timer = setInterval(() => {
      if (agent.readyState === OPEN && outbox.overdue(Date.now(), ANSWER_TIMEOUT_MS)) agent.reconnect();
    }, 2_000);
    return () => clearInterval(timer);
  }, [agent, outbox]);

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

  /** Send a message whose answer the caller waits for. Rejects when Hob is offline or refuses. */
  const request = useCallback(
    (message: ClientMessage & { readonly id: string }): Promise<unknown> => {
      if (agent.readyState !== OPEN) return Promise.reject(new Error(OFFLINE));
      const answer = requests.wait(message.id);
      agent.send(JSON.stringify(message));
      return answer;
    },
    [agent, requests]
  );

  /** Idle: starts an answer. Busy: queued as a follow-up, or with "steer" folded into the running answer. */
  const submit = useCallback(
    (input: string, whenBusy: WhenBusy = "followUp"): boolean => {
      const message: SubmitMessage = {
        type: "submit",
        id: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        input,
        whenBusy
      };
      if (!send(message)) return false;
      outbox.add(message, Date.now());
      return true;
    },
    [send, outbox]
  );
  const stop = useCallback(() => send({ type: "abort", id: crypto.randomUUID() }), [send]);
  const newTopic = useCallback(() => send({ type: "reset", id: crypto.randomUUID() }), [send]);
  const saveMemory = useCallback(
    (key: string, text: string) => request({ type: "memory_set", id: crypto.randomUUID(), key, text }),
    [request]
  );
  const deleteMemory = useCallback(
    (key: string) => request({ type: "memory_delete", id: crypto.randomUUID(), key }),
    [request]
  );
  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);

  return { ...state, submit, stop, newTopic, saveMemory, deleteMemory, dismiss };
}
