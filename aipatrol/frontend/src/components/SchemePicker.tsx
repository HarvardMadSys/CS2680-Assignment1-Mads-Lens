import { useEffect, useRef, useState } from "react";
import { SCHEMES } from "../lib/schemes";
import type { Scheme, Theme } from "../types";

interface Props {
  scheme: Scheme;
  onChange: (scheme: Scheme) => void;
  /** Which half of each swatch to show — the one you are actually looking at. */
  resolved: Theme;
}

export function SchemePicker({ scheme, onChange, resolved }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Click-away and Escape, the two ways anyone expects a menu to close.
  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = SCHEMES.find((s) => s.id === scheme) ?? SCHEMES[0];

  return (
    <div className="picker" ref={ref}>
      <button
        type="button"
        className="icon-button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Colour scheme: ${current.label}`}
        title={`Colour scheme: ${current.label}`}
      >
        <Swatch scheme={current.swatch} resolved={resolved} />
      </button>

      {open && (
        <div className="picker__menu" role="menu">
          <p className="picker__label">Colour scheme</p>
          {SCHEMES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={option.id === scheme}
              className={`picker__item${
                option.id === scheme ? " picker__item--on" : ""
              }`}
              onClick={() => {
                onChange(option.id);
                setOpen(false);
              }}
            >
              <Swatch scheme={option.swatch} resolved={resolved} />
              <span className="picker__name">{option.label}</span>
              <span className="picker__hint">{option.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A disc of the scheme's ground with its accent inside. */
function Swatch({
  scheme,
  resolved,
}: {
  scheme: [string, string, string];
  resolved: Theme;
}) {
  const [lightAccent, darkAccent, lightGround] = scheme;
  const accent = resolved === "dark" ? darkAccent : lightAccent;
  const ground = resolved === "dark" ? "#16181d" : lightGround;

  return (
    <span
      className="swatch"
      style={{ background: ground, borderColor: accent }}
      aria-hidden="true"
    >
      <span className="swatch__dot" style={{ background: accent }} />
    </span>
  );
}
