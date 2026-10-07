import type { AppStore } from "../agent/store";
import { hostOf } from "./hosts";
import { textOutput, type ToolCtx, type ToolOutput, type ToolSpec } from "./spec";
import { clip } from "./text";

/** The label's source is for orientation; a tracking URL several KB long would crowd out the content. */
const MAX_SOURCE = 500;

export type PolicyStore = {
  readonly conversations: Pick<AppStore["conversations"], "isTainted" | "taint" | "hasOwnerHost">;
  readonly memory: Pick<AppStore["memory"], "hasUnconfirmed">;
};

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Wrap third-party text so the model can tell it apart, and so it cannot close the wrapper itself. */
function labelUntrusted(text: string, source: string): string {
  const body = text.replace(/<(\/?)untrusted/gi, "&lt;$1untrusted");
  return `<untrusted source="${escapeAttribute(clip(source, MAX_SOURCE))}">\n${body}\n</untrusted>`;
}

/**
 * The one gate every tool call goes through, whatever harness runs it. It
 * lives in the compiled tool, not in a harness extension, so a conversation
 * cannot deselect it.
 */
export class Policy {
  readonly #store: PolicyStore;

  constructor(store: PolicyStore) {
    this.#store = store;
  }

  async run<A>(spec: ToolSpec<A>, args: A, ctx: Omit<ToolCtx, "tainted" | "checkEgress">): Promise<ToolOutput> {
    if (spec.effect === "side-effect") {
      return textOutput(
        `Not run: ${spec.name} would change something outside Hob, and this version has no approval step, so it never runs such tools.`,
        true
      );
    }

    const target = spec.egress?.(args);
    const refusal = target === undefined ? undefined : this.#egressRefusal(ctx.conversation, target);
    if (refusal !== undefined) return textOutput(refusal, true);

    const out = await spec.execute(args, {
      ...ctx,
      tainted: this.#taint(ctx.conversation) !== undefined,
      checkEgress: (url) => this.#egressRefusal(ctx.conversation, url)
    });
    if (out.untrusted === undefined) return out;

    this.#store.conversations.taint(ctx.conversation, out.untrusted.source);
    const source = out.untrusted.source;
    const content = out.content.map((item) => ({ type: "text" as const, text: labelUntrusted(item.text, source) }));
    return out.isError ? { content, isError: true } : { content };
  }

  /**
   * Why third-party text may be steering the model, or undefined when none can
   * be: the conversation read some, or a memory saved after reading some is in
   * every prompt until the owner keeps or deletes it. A new topic clears the
   * first, not the second.
   */
  #taint(conversation: string): string | undefined {
    if (this.#store.conversations.isTainted(conversation)) return "this conversation contains untrusted web content";
    if (this.#store.memory.hasUnconfirmed()) {
      return "a memory saved after reading untrusted web content is still unconfirmed (the owner can keep or delete it in the Memory panel)";
    }
    return undefined;
  }

  /** Why the conversation may not contact `target` now: while tainted, it reaches only hosts the owner named. */
  #egressRefusal(conversation: string, target: string): string | undefined {
    const taint = this.#taint(conversation);
    if (taint === undefined) return undefined;
    const host = hostOf(target);
    if (host === undefined) return `Not run: ${JSON.stringify(target)} is not an http(s) URL.`;
    if (this.#store.conversations.hasOwnerHost(conversation, host)) return undefined;
    return `Not fetched: ${taint}, so Hob only contacts sites the owner named in their own messages, and ${host} is not one of them. Ask the owner whether to read it; once they name it, you can try again.`;
  }
}
