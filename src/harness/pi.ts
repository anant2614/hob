// The ONLY module that imports Pi (@earendil-works/*) or the SDK's harness and
// model glue (agents/harness/*, agents/models/*). Everything else talks to the
// agent loop through AgentRuntime and EventStream, and to tools through
// ToolSpec, so a harness swap replaces this file and nothing else.
// test/architecture.test.ts enforces the boundary.

import type { Provider } from "@earendil-works/pi-ai/models";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  type HarnessSettings,
  type ToolExecutionResult,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import { PiHarness, ROOT_SESSION, type PiModel } from "agents/harness/pi";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "agents/models/pi-ai";
import type { AgentRuntime, EventStream } from "../agent/runtime";
import type { Policy } from "../tools/policy";
import type { ToolSpec } from "../tools/spec";

/** The wire format of the events this adapter emits; see src/shared/protocol.ts. */
export const EVENT_FORMAT = "pi-events/1";

/**
 * Hob's tools and prompt sections, as one Pi extension. Never rename it: Pi
 * stores extension names with pending tasks, and tasks of an uninstalled
 * extension stall.
 */
const CORE_EXTENSION = "core";

/**
 * Model calls go through AI Gateway over the AI binding, so the Worker holds no
 * provider key. `provider` is for tests (pi-ai's faux provider).
 */
export type ModelSource =
  | {
      readonly kind: "gateway";
      readonly binding: Ai;
      /** A pi-ai gateway specifier such as "anthropic/claude-opus-5-5", or a Workers AI "@cf/…" id. */
      readonly modelId: string;
      readonly gatewayId: string;
      /** Attached to every gateway log entry. At most 5 entries. Built inside the harness factory. */
      readonly metadata: () => Record<string, string>;
    }
  | { readonly kind: "provider"; readonly provider: Provider; readonly model: PiModel };

export type PromptSection = {
  readonly key: string;
  render(): string | undefined;
  /** Default true: wrap the text as <key>…</key>. */
  readonly tag?: boolean;
};

export type PiRuntimeOptions = {
  readonly model: ModelSource;
  /** Called when Pi opens, once per isolate. */
  readonly tools: () => readonly ToolSpec[];
  /** Rendered in order before every model request. Put static sections first. */
  readonly sections: readonly PromptSection[];
  readonly policy: Policy;
};

export type PiRuntime = {
  /** The Lifecycle capability to install on the host Durable Object. */
  readonly capability: PiHarness;
  readonly runtime: AgentRuntime;
  /** Pi's agent events for one conversation: a snapshot, then a batch per commit. */
  events(conversation: string): Promise<EventStream>;
  /** Point the root conversation at the configured model if it was created with another one. */
  syncModel(): Promise<void>;
  /** The configured model, as `provider/id`. */
  readonly modelName: string;
};

const SETTINGS: HarnessSettings = {
  // pi doubles the delay before each retry: 1, 2, 4, 8 and 16 seconds.
  retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
  // An alarm invocation runs at most 15 minutes; a stream must end well inside that.
  stream: { timeoutMs: 5 * 60_000 },
  // Fewer SQLite writes than Pi's 100 ms default; a crash loses at most 250 ms of output.
  progress: { partialIntervalMs: 250, outputIntervalMs: 250 }
};

const NEVER_ABORTED = new AbortController().signal;

/** Compile a harness-neutral ToolSpec into a Pi tool. Every call goes through the policy. */
export function toPiTool(spec: ToolSpec, policy: Policy): ToolRegistration {
  const sideEffect = spec.effect === "side-effect";
  return {
    name: spec.name,
    description: spec.description,
    // Pi validates arguments with TypeBox, which accepts plain JSON Schema.
    parameters: spec.inputSchema as never,
    replay: sideEffect ? "unsafe" : "safe",
    executionMode: sideEffect || spec.sequential === true ? "sequential" : "parallel",
    async execute(args, api, context): Promise<ToolExecutionResult> {
      // Stable across crash replays of this call.
      const idempotencyKey = await api.memo("idem", crypto.randomUUID(), context);
      const out = await policy.run(spec, args, {
        signal: context.abortSignal ?? NEVER_ABORTED,
        idempotencyKey,
        conversation: String(api.conversationId),
        output: (chunk) => api.output(chunk)
      });
      return {
        content: out.content.map((item) => ({ type: "text" as const, text: item.text })),
        isError: out.isError === true
      };
    }
  };
}

function defaultModel(source: ModelSource): PiModel {
  return source.kind === "gateway" ? { provider: CLOUDFLARE_PROVIDER_ID, id: source.modelId } : source.model;
}

function providerFor(source: ModelSource): Provider {
  if (source.kind === "provider") return source.provider;
  // Gateway options must live on createAI: options passed to ai(id, options)
  // never reach a Pi session.
  const ai = createAI({ binding: source.binding, id: source.gatewayId, metadata: source.metadata() });
  try {
    ai(source.modelId);
  } catch (error) {
    // Keep Pi open so the transcript still loads; the run reports the failure.
    console.error(`MODEL_ID ${JSON.stringify(source.modelId)} is not a model this gateway knows`, error);
  }
  return ai.provider;
}

export function createPiRuntime(options: PiRuntimeOptions): PiRuntime {
  const registry = createRegistry();
  const model = defaultModel(options.model);
  const harness = new PiHarness({
    harness: ({ storage, context }) => {
      registry.install({
        name: CORE_EXTENSION,
        sections: options.sections.map((section) => ({
          key: section.key,
          render: () => section.render(),
          ...(section.tag === undefined ? {} : { tag: section.tag })
        })),
        tools: options.tools().map((spec) => toPiTool(spec, options.policy))
      });
      const models = createModels();
      models.setProvider(providerFor(options.model));
      return Harness.open(
        storage,
        { models, registry, settings: SETTINGS, onReport: (error) => console.warn("pi report", error) },
        context
      );
    },
    // Opus 5.5 always thinks; "low" asks for low effort. Never use "off" there:
    // pi-ai would send thinking: disabled, which that model rejects.
    defaults: { model, thinkingLevel: "low" }
  });

  const session = (conversation?: string) => conversation ?? ROOT_SESSION;

  const runtime: AgentRuntime = {
    async submit(input, o = {}) {
      const receipt = await harness.submit(input, {
        session: session(o.conversation),
        operationId: o.operationId,
        whenBusy: o.whenBusy
      });
      return { operationId: receipt.operationId, conversation: receipt.session, accepted: receipt.accepted };
    },
    async wait(operationId, o = {}) {
      const result = await harness.wait(operationId, { session: session(o.conversation), signal: o.signal });
      return {
        operationId: result.operationId,
        conversation: result.session,
        status: result.status,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.text === undefined ? {} : { text: result.text })
      };
    },
    abort: (o = {}) => harness.abort({ session: session(o.conversation), operationId: o.operationId }),
    reset: (o = {}) => harness.session(session(o.conversation)).reset(o.handoff)
  };

  return {
    capability: harness,
    runtime,
    modelName: `${model.provider}/${model.id}`,
    async events(conversation) {
      const stream = await harness.session(conversation).events();
      return {
        snapshot: stream.snapshot,
        start: (listener) => stream.start((events) => listener(events)),
        stop: () => stream.stop()
      };
    },
    async syncModel() {
      const stream = await harness.session(ROOT_SESSION).events();
      const stored = stream.snapshot.agent.model;
      await stream.stop();
      if (stored?.provider === model.provider && stored.modelId === model.id) return;
      await harness.session(ROOT_SESSION).setModel(model);
    }
  };
}
