import type { Scheme } from "../types";

export interface SchemeInfo {
  id: Scheme;
  label: string;
  hint: string;
  /** Swatch colours for the picker: [light accent, dark accent, light ground]. */
  swatch: [string, string, string];
}

/**
 * The five palettes. `slate` is the default and what an unset preference
 * falls back to, so its values are also the ones on bare `:root`.
 */
export const SCHEMES: SchemeInfo[] = [
  {
    id: "slate",
    label: "Slate",
    hint: "Cool grey, indigo",
    swatch: ["#5b56e0", "#8480f5", "#f5f6f9"],
  },
  {
    id: "ember",
    label: "Ember",
    hint: "Warm paper, terracotta",
    swatch: ["#c05621", "#e0805a", "#f8f6f3"],
  },
  {
    id: "forest",
    label: "Forest",
    hint: "Green-grey, deep teal",
    swatch: ["#0f766e", "#4fc4b4", "#f3f7f4"],
  },
  {
    id: "plum",
    label: "Plum",
    hint: "Mauve grey, magenta",
    swatch: ["#a21f7a", "#e072bd", "#f8f5f9"],
  },
  {
    id: "mono",
    label: "Mono",
    hint: "No hue at all",
    swatch: ["#1c1c1c", "#ededed", "#f6f6f6"],
  },
];

export const DEFAULT_SCHEME: Scheme = "slate";

export function isScheme(value: unknown): value is Scheme {
  return SCHEMES.some((s) => s.id === value);
}
