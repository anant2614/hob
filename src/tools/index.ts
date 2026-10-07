import type { AppStore } from "../agent/store";
import { forgetTool, rememberTool } from "./memory";
import type { ToolSpec } from "./spec";
import { readPageTool, type ReadPageOptions } from "./web";

/** v0's tools. None changes anything outside Hob, so none needs approval. */
export function coreTools(store: Pick<AppStore, "memory">, web: ReadPageOptions = {}): ToolSpec[] {
  return [rememberTool(store), forgetTool(store), readPageTool(web)];
}
