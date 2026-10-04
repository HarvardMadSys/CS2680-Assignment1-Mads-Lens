import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  onSubmit: (text: string) => void;
  /**
   * Blocks sending, not typing. A run in flight must not cost you the draft
   * you are part-way through, or the focus you are typing into — so the box
   * stays live and only the send is held back.
   */
  locked?: boolean;
  /** Why sending is held back; shown once there is something to send. */
  lockedReason?: string;
  placeholder?: string;
  /** Rendered under the box, left of the key hint — the directory control. */
  accessory?: ReactNode;
  /**
   * A draft to drop into the box. `at` is a nonce — loading the same text
   * twice still refills the box, which is what pressing the shortcut again
   * should do.
   */
  preset?: { text: string; at: number };
}

const MAX_HEIGHT = 200;

export function Composer({
  onSubmit,
  locked,
  lockedReason,
  placeholder,
  accessory,
  preset,
}: Props) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the content, then scroll internally past MAX_HEIGHT.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  // Load a preset draft and put the cursor in it, ready to edit or send.
  useEffect(() => {
    if (!preset) return;
    setValue(preset.text);
    ref.current?.focus();
  }, [preset]);

  const hasDraft = value.trim().length > 0;
  const canSend = hasDraft && !locked;

  function send() {
    if (!canSend) return;
    onSubmit(value.trim());
    setValue("");
    ref.current?.focus();
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div className="composer__box">
        <textarea
          ref={ref}
          className="composer__input"
          rows={1}
          value={value}
          placeholder={placeholder ?? "Ask the agent to do something…"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter makes a new line. While locked, Enter
            // does nothing rather than quietly adding a line you did not want.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="submit"
          className="composer__send"
          disabled={!canSend}
          aria-label="Send"
          title={locked ? (lockedReason ?? "Not ready to send") : "Send  (Enter)"}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
            fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>

      <div className="composer__under">
        <div className="composer__accessory">{accessory}</div>

        {/* Only explain the block once there is a draft being held back —
            before that it is a warning about nothing. */}
        {locked && hasDraft ? (
          <p className="composer__held" role="status">
            {lockedReason ?? "Not ready to send"}
          </p>
        ) : (
          <p className="composer__hint">
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new
          line · <kbd>Ctrl</kbd>+<kbd>B</kbd> test prompt
          </p>
        )}
      </div>
    </form>
  );
}
