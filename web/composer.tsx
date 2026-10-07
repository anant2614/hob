import { ArrowUpIcon, StopIcon } from "@phosphor-icons/react";
import { useEffect, useRef, type KeyboardEvent } from "react";

const prefersTouch = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

export function Composer({
  value,
  onChange,
  onSend,
  onSteer,
  onStop,
  running,
  disabled
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onSteer: () => void;
  readonly onStop: () => void;
  readonly running: boolean;
  readonly disabled: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const empty = value.trim() === "";

  // Grow with the text, up to a third of the screen.
  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, window.innerHeight / 3)}px`;
  }, [value]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // On a phone, Return makes a new line; the send button sends.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !prefersTouch()) {
      event.preventDefault();
      if (!empty) onSend();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty) onSend();
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={running ? "Add something for after this answer" : "Message Hob"}
        aria-label="Message Hob"
        enterKeyHint="send"
      />
      <div className="composer-actions">
        {running && !empty ? (
          <button type="button" className="btn btn-quiet" onClick={onSteer} disabled={disabled}>
            Send now
          </button>
        ) : null}
        {running ? (
          <button type="button" className="icon-btn icon-btn-solid" aria-label="Stop the answer" onClick={onStop} disabled={disabled}>
            <StopIcon size={16} weight="fill" />
          </button>
        ) : null}
        {!running || !empty ? (
          <button
            type="submit"
            className="icon-btn icon-btn-send"
            aria-label={running ? "Send after this answer" : "Send"}
            disabled={disabled || empty}
          >
            <ArrowUpIcon size={18} weight="bold" />
          </button>
        ) : null}
      </div>
    </form>
  );
}
