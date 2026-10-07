import type { AgentEvent } from "@earendil-works/pi-durable";
import type { MemoryItem, ServerMessage, ToolInfo } from "../src/shared/protocol";
import { EMPTY_VIEW, reduceEvents, reduceView, type HobView } from "./view";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

/** Everything the app shows: the socket, the agent's hello, memory, taint, and the conversation view. */
export type AppState = {
  readonly status: ConnectionStatus;
  readonly model: string | null;
  readonly tools: readonly ToolInfo[];
  readonly memory: readonly MemoryItem[];
  readonly tainted: boolean;
  readonly view: HobView;
  /** The latest error the agent sent back, until dismissed. */
  readonly notice: string | null;
  /** Sockets closed since the last one opened: failed reconnects, once it is more than one. */
  readonly failures: number;
};

export const INITIAL_APP: AppState = {
  status: "connecting",
  model: null,
  tools: [],
  memory: [],
  tainted: false,
  view: EMPTY_VIEW,
  notice: null,
  failures: 0
};

export type AppAction =
  | { readonly type: "open" }
  | { readonly type: "closed" }
  | { readonly type: "server"; readonly message: ServerMessage<AgentEvent> }
  | { readonly type: "notice"; readonly text: string }
  | { readonly type: "dismiss" };

export function reduceApp(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "open":
      return { ...state, status: "open", failures: 0 };
    case "closed":
      return {
        ...state,
        status: state.status === "connecting" ? "connecting" : "reconnecting",
        view: reduceView(state.view, { type: "disconnected" }),
        failures: state.failures + 1
      };
    case "notice":
      return { ...state, notice: action.text };
    case "dismiss":
      return { ...state, notice: null, view: { ...state.view, error: null } };
    case "server": {
      const message = action.message;
      if (typeof message !== "object" || message === null) return state;
      switch (message.type) {
        case "hello":
          return { ...state, model: message.model, tools: message.tools };
        case "events":
          return { ...state, view: reduceEvents(state.view, message.events) };
        case "memory":
          return { ...state, memory: message.items };
        case "taint":
          return { ...state, tainted: message.tainted };
        case "error":
          return { ...state, notice: message.message };
        case "result":
          return state;
        default:
          // A frame from a newer server than this page.
          return state;
      }
    }
  }
}

/** Failed reconnects before the status suggests a reload: an expired Access session fails every one. */
const RELOAD_AFTER = 3;

/** Whether reconnecting keeps failing, so a reload (and a fresh sign-in) is the way back. */
export function needsReload(state: AppState): boolean {
  return state.status !== "open" && state.failures >= RELOAD_AFTER;
}

/** One sentence about what is happening, most important first. */
export function statusText(state: AppState): string {
  const { view } = state;
  if (needsReload(state)) return "Can't reach Hob. If you were signed out, reload to sign in again.";
  if (state.status === "connecting") return "Connecting…";
  if (state.status === "reconnecting") return view.running ? "Connection lost. Reconnecting…" : "Reconnecting…";
  if (view.resuming) return "Resuming the answer that was cut off…";
  if (view.retry) return "The model is busy. Trying again shortly…";
  if (view.compacting) return "Summarising older messages…";
  if (view.running && view.queued > 0) return `Working. ${view.queued} more waiting.`;
  if (view.running) return "Working…";
  return state.model ? `Ready. ${state.model.split("/").at(-1)}` : "Ready.";
}
