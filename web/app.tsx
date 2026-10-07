import { ArrowDownIcon, BookmarkSimpleIcon, DotsThreeVerticalIcon, InfoIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Composer } from "./composer";
import { Logbook } from "./logbook";
import { MemoryDrawer } from "./memory";
import { PilotLight, type PilotState } from "./pilot";
import type { AppState } from "./state";
import { formatCost, groupTurns, resultsByCall } from "./turns";
import { useHob } from "./use-hob";

const STARTERS = [
  "What do you remember about me?",
  "Remember that I take my coffee as a flat white.",
  "Read this page and give me the gist: "
];

function pilotState(state: AppState): PilotState {
  if (state.status === "connecting") return "connecting";
  if (state.status === "reconnecting") return "out";
  if (state.view.resuming) return "resuming";
  return state.view.running ? "working" : "lit";
}

/** One sentence about what is happening, most important first. */
function statusText(state: AppState): string {
  const { view } = state;
  if (state.status === "connecting") return "Connecting…";
  if (state.status === "reconnecting") return view.running ? "Connection lost. Reconnecting…" : "Reconnecting…";
  if (view.resuming) return "Resuming the answer that was cut off…";
  if (view.retry) return "The model is busy. Trying again shortly…";
  if (view.compacting) return "Summarising older messages…";
  if (view.running && view.queued > 0) return `Working. ${view.queued} more waiting.`;
  if (view.running) return "Working…";
  return state.model ? `Ready. ${state.model.split("/").at(-1)}` : "Ready.";
}

function NewTopicMenu({ onNewTopic, disabled }: { readonly onNewTopic: () => void; readonly disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className="icon-btn"
        aria-label="More"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setConfirming(false);
        }}
      >
        <DotsThreeVerticalIcon size={20} weight="bold" />
      </button>
      {open ? (
        <div className="menu-pop" role="menu">
          {confirming ? (
            <div className="menu-confirm">
              <p>Clear this conversation? Hob keeps its memory.</p>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  role="menuitem"
                  disabled={disabled}
                  onClick={() => {
                    onNewTopic();
                    setOpen(false);
                    setConfirming(false);
                  }}
                >
                  Start new topic
                </button>
                <button type="button" className="btn" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="menu-item" role="menuitem" onClick={() => setConfirming(true)}>
              New topic
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function App() {
  const hob = useHob();
  const [draft, setDraft] = useState("");
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [pinned, setPinned] = useState(true);
  const scroller = useRef<HTMLElement>(null);

  const { view } = hob;
  const messages = useMemo(() => (view.live ? [...view.messages, view.live] : view.messages), [view.messages, view.live]);
  const turns = useMemo(() => groupTurns(messages), [messages]);
  const results = useMemo(() => resultsByCall(view.messages), [view.messages]);
  const thinking = view.running && view.live === null && view.tools.length === 0;
  const connected = hob.status === "open";
  const flagged = hob.memory.filter((item) => item.tainted).length;
  const error = hob.notice ?? view.error;

  // Follow new output while the reader is at the bottom; leave them be if they scrolled up.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned) element.scrollTop = element.scrollHeight;
  }, [turns, thinking, pinned, view.tools]);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
  }, []);

  const send = (whenBusy: "followUp" | "steer") => {
    const text = draft.trim();
    if (text === "") return;
    if (hob.submit(text, whenBusy)) {
      setDraft("");
      setPinned(true);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="column topbar-inner">
          <div className="brand">
            <PilotLight state={pilotState(hob)} />
            <span className="wordmark">hob</span>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="memory-btn"
              onClick={() => setMemoryOpen(true)}
              aria-label={`Memory, ${hob.memory.length} saved${flagged > 0 ? `, ${flagged} to check` : ""}`}
            >
              <BookmarkSimpleIcon size={17} weight="bold" aria-hidden="true" />
              <span>Memory</span>
              <span className="count">{hob.memory.length}</span>
              {flagged > 0 ? <span className="flag-dot" aria-hidden="true" /> : null}
            </button>
            <NewTopicMenu onNewTopic={hob.newTopic} disabled={!connected} />
          </div>
        </div>
      </header>

      <main className="scroller" ref={scroller} onScroll={onScroll}>
        <div className="column">
          {!turns.some((turn) => turn.kind !== "notice") && !view.running ? (
            <section className="welcome">
              <p className="welcome-line">Tell Hob something worth remembering, or give it a link to read.</p>
              <div className="starters">
                {STARTERS.map((starter) => (
                  <button key={starter} type="button" className="starter" onClick={() => setDraft(starter)}>
                    {starter.trim()}
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <Logbook turns={turns} results={results} running={view.tools} thinking={thinking} />
          )}
        </div>
      </main>

      {!pinned ? (
        <button type="button" className="jump" onClick={() => setPinned(true)}>
          <ArrowDownIcon size={14} weight="bold" aria-hidden="true" /> Latest
        </button>
      ) : null}

      <footer className="dock">
        <div className="column">
          {error ? (
            <div className="alert" role="alert">
              <p>{error}</p>
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={hob.dismiss}>
                <XIcon size={16} />
              </button>
            </div>
          ) : null}
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={() => send("followUp")}
            onSteer={() => send("steer")}
            onStop={hob.stop}
            running={view.running}
            disabled={!connected}
          />
          <div className="statusline">
            <span role="status" aria-live="polite">
              {statusText(hob)}
            </span>
            {hob.tainted ? (
              <span className="taint" title="Hob only opens sites you name yourself until you start a new topic.">
                <InfoIcon size={14} weight="bold" aria-hidden="true" /> Includes web pages
              </span>
            ) : null}
            <span className="spend" title={`${view.usage.tokens.toLocaleString()} tokens`}>
              {formatCost(view.usage.cost)} spent
            </span>
          </div>
        </div>
      </footer>

      <MemoryDrawer
        open={memoryOpen}
        items={hob.memory}
        onClose={() => setMemoryOpen(false)}
        onSave={hob.saveMemory}
        onDelete={hob.deleteMemory}
      />
    </div>
  );
}
