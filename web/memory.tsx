import { PencilSimpleIcon, TrashIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MemoryItem } from "../src/shared/protocol";

const MAX_MEMORIES = 100;
const MAX_TEXT = 1000;

type Save = (key: string, text: string) => Promise<unknown>;
type Delete = (key: string) => Promise<unknown>;

/** Run one memory action at a time, keeping its error for the form that started it. */
function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setPending(false);
    }
  };
  return { run, pending, error };
}

function FormError({ error }: { readonly error: string | null }) {
  return error === null ? null : (
    <p className="form-error" role="alert">
      {error}
    </p>
  );
}

function savedWhen(item: MemoryItem): string {
  const date = new Date(item.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return item.source === "owner" ? `Added by you on ${date}` : `Saved by Hob on ${date}`;
}

function MemoryRow({
  item,
  onSave,
  onDelete
}: {
  readonly item: MemoryItem;
  readonly onSave: Save;
  readonly onDelete: Delete;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const { run, pending, error } = useAction();

  useEffect(() => setDraft(item.text), [item.text]);

  return (
    <li className="memory" data-flagged={item.tainted}>
      <div className="memory-head">
        <span className="memory-key">{item.key}</span>
        <span className="memory-meta">{savedWhen(item)}</span>
      </div>
      {editing ? (
        <form
          className="memory-edit"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await run(() => onSave(item.key, draft))) setEditing(false);
          }}
        >
          <textarea
            value={draft}
            maxLength={MAX_TEXT}
            rows={3}
            aria-label={`Text of ${item.key}`}
            onChange={(event) => setDraft(event.target.value)}
            autoFocus
          />
          <div className="row-actions">
            <button type="submit" className="btn btn-primary" disabled={pending || draft.trim() === ""}>
              {pending ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="memory-text">{item.text}</p>
      )}
      {item.tainted && !editing ? (
        <div className="memory-flag">
          <WarningIcon size={15} weight="bold" aria-hidden="true" />
          <p>Saved after reading a web page. Keep it only if it's true; until you keep or delete it, Hob only opens sites you name.</p>
          <button type="button" className="btn" disabled={pending} onClick={() => run(() => onSave(item.key, item.text))}>
            Keep
          </button>
        </div>
      ) : null}
      {!editing ? (
        <div className="row-actions">
          {confirming ? (
            <>
              <span className="confirm-text">Delete “{item.key}”?</span>
              <button
                type="button"
                className="btn btn-danger"
                disabled={pending}
                onClick={async () => {
                  if (await run(() => onDelete(item.key))) setConfirming(false);
                }}
              >
                Delete
              </button>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-quiet" onClick={() => setEditing(true)}>
                <PencilSimpleIcon size={14} aria-hidden="true" /> Edit
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => setConfirming(true)}>
                <TrashIcon size={14} aria-hidden="true" /> Delete
              </button>
            </>
          )}
        </div>
      ) : null}
      <FormError error={error} />
    </li>
  );
}

function AddMemory({ onSave, full }: { readonly onSave: Save; readonly full: boolean }) {
  const [key, setKey] = useState("");
  const [text, setText] = useState("");
  const { run, pending, error } = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || key.trim() === "" || text.trim() === "") return;
    // Clear the form only once Hob has the memory: offline, or refused, the text stays.
    if (await run(() => onSave(key, text))) {
      setKey("");
      setText("");
    }
  };
  return (
    <form className="memory-add" onSubmit={submit}>
      <h3>Add a memory</h3>
      <label>
        <span>Name</span>
        <input value={key} maxLength={64} placeholder="e.g. partner" onChange={(event) => setKey(event.target.value)} />
      </label>
      <label>
        <span>What Hob should know</span>
        <textarea
          value={text}
          maxLength={MAX_TEXT}
          rows={3}
          placeholder="e.g. Priya, birthday 14 March"
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <button type="submit" className="btn btn-primary" disabled={pending || full || key.trim() === "" || text.trim() === ""}>
        {pending ? "Saving…" : "Save memory"}
      </button>
      {full ? <p className="hint">Memory is full. Delete something first.</p> : null}
      <FormError error={error} />
    </form>
  );
}

export function MemoryDrawer({
  open,
  items,
  onClose,
  onSave,
  onDelete
}: {
  readonly open: boolean;
  readonly items: readonly MemoryItem[];
  readonly onClose: () => void;
  readonly onSave: Save;
  readonly onDelete: Delete;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const flagged = items.filter((item) => item.tainted);
  const rest = items.filter((item) => !item.tainted);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <h2 id="memory-title">Memory</h2>
            <p className="hint">
              Hob reads these before every reply. {items.length} of {MAX_MEMORIES} used.
            </p>
          </div>
          <button ref={closeRef} type="button" className="icon-btn" aria-label="Close memory" onClick={onClose}>
            <XIcon size={18} />
          </button>
        </header>
        <div className="drawer-body">
          {items.length === 0 ? (
            <p className="empty-note">Nothing saved yet. Tell Hob something about yourself, or add a memory below.</p>
          ) : (
            <ul className="memories">
              {[...flagged, ...rest].map((item) => (
                <MemoryRow key={item.key} item={item} onSave={onSave} onDelete={onDelete} />
              ))}
            </ul>
          )}
          <AddMemory onSave={onSave} full={items.length >= MAX_MEMORIES} />
        </div>
      </aside>
    </div>
  );
}
