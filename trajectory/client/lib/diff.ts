export type DiffLine = { t: " " | "-" | "+"; s: string };

/** Line-level LCS diff — enough to show what an Edit actually changed. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) out.push({ t: " ", s: A[i++] }), j++;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ t: "-", s: A[i++] });
    else out.push({ t: "+", s: B[j++] });
  }
  while (i < n) out.push({ t: "-", s: A[i++] });
  while (j < m) out.push({ t: "+", s: B[j++] });
  return out;
}

/** Collapse long runs of unchanged lines, keeping `ctx` on either side of a change. */
export function trimContext(d: DiffLine[], ctx = 3): (DiffLine | { t: "…"; s: string })[] {
  const keep = new Set<number>();
  d.forEach((l, i) => {
    if (l.t === " ") return;
    for (let k = Math.max(0, i - ctx); k <= Math.min(d.length - 1, i + ctx); k++) keep.add(k);
  });
  const out: (DiffLine | { t: "…"; s: string })[] = [];
  let gap = 0;
  d.forEach((l, i) => {
    if (keep.has(i)) {
      if (gap) out.push({ t: "…", s: `${gap} unchanged lines` });
      gap = 0;
      out.push(l);
    } else gap++;
  });
  if (gap) out.push({ t: "…", s: `${gap} unchanged lines` });
  return out;
}
