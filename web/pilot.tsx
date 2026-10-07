export type PilotState = "out" | "connecting" | "lit" | "working" | "resuming";

const LABELS: Record<PilotState, string> = {
  out: "Hob is offline",
  connecting: "Connecting to Hob",
  lit: "Hob is here",
  working: "Hob is working",
  resuming: "Hob is resuming"
};

/** Hob's pilot light: the only flourish in the interface, and its status. */
export function PilotLight({ state, size = 18 }: { readonly state: PilotState; readonly size?: number }) {
  return (
    <span className="pilot" data-state={state} role="img" aria-label={LABELS[state]}>
      <svg viewBox="0 0 16 22" width={size * (16 / 22)} height={size} aria-hidden="true">
        <path className="pilot-outer" d="M8 1C11 6 15 9.2 15 14.2a7 7 0 0 1-14 0C1 9.2 5 6 8 1Z" />
        <path className="pilot-core" d="M8 9.2c1.5 2.3 3.4 3.7 3.4 6.1a3.4 3.4 0 0 1-6.8 0c0-2.4 1.9-3.8 3.4-6.1Z" />
      </svg>
    </span>
  );
}
