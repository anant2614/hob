import type { AppStore } from "../agent/store";
import { hostOf } from "./hosts";
import { textOutput, type ToolCtx, type ToolOutput, type ToolSpec } from "./spec";
import { clip } from "./text";

/** The label's source is for orientation; a tracking URL several KB long would crowd out the content. */
const MAX_SOURCE = 500;

export type PolicyStore = {
  readonly conversations: Pick<AppStore["conversations"], "isTainted" | "taint" | "hasOwnerHost">;
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
      tainted: this.#store.conversations.isTainted(ctx.conversation),
      checkEgress: (url) => this.#egressRefusal(ctx.conversation, url)
    });
    if (out.untrusted === undefined) return out;

    this.#store.conversations.taint(ctx.conversation, out.untrusted.source);
    const source = out.untrusted.source;
    const content = out.content.map((item) => ({ type: "text" as const, text: labelUntrusted(item.text, source) }));
    return out.isError ? { content, isError: true } : { content };
  }

  /** Why the conversation may not contact `target` now: once tainted, it reaches only hosts the owner named. */
  #egressRefusal(conversation: string, target: string): string | undefined {
    if (!this.#store.conversations.isTainted(conversation)) return undefined;
    const host = hostOf(target);
    if (host === undefined) return `Not run: ${JSON.stringify(target)} is not an http(s) URL.`;
    if (this.#store.conversations.hasOwnerHost(conversation, host)) return undefined;
    return `Not fetched: this conversation contains untrusted web content, so Hob only contacts sites the owner named in their own messages, and ${host} is not one of them. Ask the owner whether to read it; once they name it, you can try again.`;
  }
}
