import { PencilSimpleIcon, TrashIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MemoryItem } from "../src/shared/protocol";

const MAX_MEMORIES = 100;
const MAX_TEXT = 1000;

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
  readonly onSave: (key: string, text: string) => void;
  readonly onDelete: (key: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(item.text);

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
          onSubmit={(event) => {
            event.preventDefault();
            onSave(item.key, draft);
            setEditing(false);
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
            <button type="submit" className="btn btn-primary" disabled={draft.trim() === ""}>
              Save
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
          <p>Saved after reading a web page. Keep it only if it's true.</p>
          <button type="button" className="btn" onClick={() => onSave(item.key, item.text)}>
            Keep
          </button>
        </div>
      ) : null}
      {!editing ? (
        <div className="row-actions">
          {confirming ? (
            <>
              <span className="confirm-text">Delete “{item.key}”?</span>
              <button type="button" className="btn btn-danger" onClick={() => onDelete(item.key)}>
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
    </li>
  );
}

function AddMemory({ onSave, full }: { readonly onSave: (key: string, text: string) => void; readonly full: boolean }) {
  const [key, setKey] = useState("");
  const [text, setText] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (key.trim() === "" || text.trim() === "") return;
    onSave(key, text);
    setKey("");
    setText("");
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
      <button type="submit" className="btn btn-primary" disabled={full || key.trim() === "" || text.trim() === ""}>
        Save memory
      </button>
      {full ? <p className="hint">Memory is full. Delete something first.</p> : null}
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
  readonly onSave: (key: string, text: string) => void;
  readonly onDelete: (key: string) => void;
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
