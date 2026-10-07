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
};

export const INITIAL_APP: AppState = {
  status: "connecting",
  model: null,
  tools: [],
  memory: [],
  tainted: false,
  view: EMPTY_VIEW,
  notice: null
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
      return { ...state, status: "open" };
    case "closed":
      return {
        ...state,
        status: state.status === "connecting" ? "connecting" : "reconnecting",
        view: reduceView(state.view, { type: "disconnected" })
      };
    case "notice":
      return { ...state, notice: action.text };
    case "dismiss":
      return { ...state, notice: null };
    case "server": {
      const message = action.message;
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
      }
    }
  }
}
