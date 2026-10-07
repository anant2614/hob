import { BookmarkSimpleIcon, EraserIcon, GlobeSimpleIcon, WrenchIcon } from "@phosphor-icons/react";
import type { JsonValue } from "@earendil-works/pi-ai";
import { lazy, Suspense } from "react";
import type { TranscriptMessage } from "./transcript";
import { describeTool, readableResult, resultText, textOf, type ToolNote, type ToolResult, type Turn } from "./turns";
import type { RunningTool } from "./view";

const Markdown = lazy(() => import("./markdown"));

function Answer({ text, streaming }: { readonly text: string; readonly streaming: boolean }) {
  return (
    <Suspense fallback={<p className="plain-answer">{text}</p>}>
      <Markdown text={text} streaming={streaming} />
    </Suspense>
  );
}

const ICONS = {
  remember: BookmarkSimpleIcon,
  forget: EraserIcon,
  read: GlobeSimpleIcon,
  tool: WrenchIcon
} as const;

function NoteLine({ note }: { readonly note: ToolNote }) {
  const Icon = ICONS[note.icon];
  return (
    <span className="note-line">
      <Icon size={15} weight={note.tone === "running" ? "regular" : "bold"} aria-hidden="true" />
      <span>{note.label}</span>
      {note.tone === "running" ? <span className="note-dots" aria-hidden="true" /> : null}
    </span>
  );
}

function ToolCall({
  name,
  args,
  result,
  running
}: {
  readonly name: string;
  readonly args: JsonValue;
  readonly result: ToolResult | undefined;
  readonly running: RunningTool | undefined;
}) {
  const note = describeTool(name, args, result, running !== undefined);
  const text = result ? readableResult(resultText(result)) : (running?.output ?? "");
  return (
    <details className="tool-note" data-tone={note.tone}>
      <summary>
        <NoteLine note={note} />
      </summary>
      <div className="tool-detail">
        {name === "read_page" && result && !result.error ? (
          <p className="tool-caption">From the web. Hob treats it as information, not instructions.</p>
        ) : null}
        <pre>{text === "" ? JSON.stringify(args, null, 2) : text}</pre>
      </div>
    </details>
  );
}

function HobMessage({
  message,
  results,
  running,
  streaming
}: {
  readonly message: TranscriptMessage;
  readonly results: ReadonlyMap<string, ToolResult>;
  readonly running: readonly RunningTool[];
  readonly streaming: boolean;
}) {
  return (
    <>
      {message.parts.map((part, index) => {
        const key = `${message.id}-${index}`;
        switch (part.type) {
          case "text":
            return part.text.trim() === "" ? null : <Answer key={key} text={part.text} streaming={streaming} />;
          case "thinking":
            return part.text.trim() === "" ? null : (
              <details key={key} className="reasoning">
                <summary>Reasoning</summary>
                <p>{part.text}</p>
              </details>
            );
          case "tool-call":
            return (
              <ToolCall
                key={key}
                name={part.name}
                args={part.arguments}
                result={results.get(part.id)}
                running={running.find((tool) => tool.callId === part.id)}
              />
            );
          default:
            return null;
        }
      })}
      {message.error ? (
        <p className="turn-error" role="alert">
          {message.error}
        </p>
      ) : null}
    </>
  );
}

export function Logbook({
  turns,
  results,
  running,
  thinking
}: {
  readonly turns: readonly Turn[];
  readonly results: ReadonlyMap<string, ToolResult>;
  readonly running: readonly RunningTool[];
  /** Hob is working but has nothing to show yet. */
  readonly thinking: boolean;
}) {
  const last = turns.at(-1);
  return (
    <ol className="logbook" aria-label="Conversation">
      {turns.map((turn) => {
        if (turn.kind === "notice") {
          return (
            <li key={turn.id} className="turn turn-notice">
              <span className="speaker" />
              <p>{turn.text}</p>
            </li>
          );
        }
        if (turn.kind === "you") {
          return (
            <li key={turn.id} className="turn turn-you">
              <span className="speaker">you</span>
              <div className="said said-you">{textOf(turn.message)}</div>
            </li>
          );
        }
        return (
          <li key={turn.id} className="turn turn-hob">
            <span className="speaker">hob</span>
            <div className="said">
              {turn.messages.map((message) =>
                message.role === "assistant" ? (
                  <HobMessage
                    key={message.id}
                    message={message}
                    results={results}
                    running={running}
                    streaming={message.id === "live"}
                  />
                ) : null
              )}
              {thinking && turn === last ? <p className="thinking">Thinking</p> : null}
            </div>
          </li>
        );
      })}
      {thinking && last?.kind !== "hob" ? (
        <li className="turn turn-hob">
          <span className="speaker">hob</span>
          <div className="said">
            <p className="thinking">Thinking</p>
          </div>
        </li>
      ) : null}
    </ol>
  );
}
