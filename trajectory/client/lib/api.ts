declare global { interface Window { trajectory?: { desktop: boolean } } }

/**
 * Same origin, always: the page's own server forwards /api/* (and the SSE run streams) to the
 * Python API, so the browser only ever needs the one port it loaded the page from.
 */
export const API = "";

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + path, { cache: "no-store", ...init });
  if (!r.ok) {
    // FastAPI wraps the message in {"detail": …}; an error a person reads should not show that
    const body = await r.text().catch(() => "");
    let msg = body;
    try { msg = JSON.parse(body).detail ?? body; } catch {}
    throw new Error(msg || `${r.status} ${r.statusText}`);
  }
  return r.json();
}

export const api = {
  health: () => j<{ ok: boolean; fixtures: string[] }>("/api/health"),
  list: (path: string) => j<any>(`/api/fs/list?path=${encodeURIComponent(path)}`),
  tree: (path: string, depth = 3) => j<any>(`/api/fs/tree?path=${encodeURIComponent(path)}&depth=${depth}`),
  file: (path: string) => j<{ path: string; text: string; lines: number }>(`/api/fs/file?path=${encodeURIComponent(path)}`),
  projects: () => j<any[]>("/api/projects"),
  addProject: (path: string) => j<any>("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }),
  dropProject: (path: string) => j<any>(`/api/projects?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
  caps: (cwd: string) => j<any>(`/api/capabilities?cwd=${encodeURIComponent(cwd)}`),
  startRun: (body: any) => j<{ run_id: string }>("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  cancel: (id: string) => j<any>(`/api/runs/${id}/cancel`, { method: "POST" }),
  run: (id: string) => j<any>(`/api/runs/${id}`),
  runs: (qs: string) => j<any[]>(`/api/runs?${qs}`),
  tool: (runId: string, toolId: string) => j<any>(`/api/runs/${runId}/tool/${toolId}`),
  metrics: (qs: string) => j<any>(`/api/metrics?${qs}`),
  edits: (cwd: string) => j<any>(`/api/edits?cwd=${encodeURIComponent(cwd)}`),
  doc: (path: string) => j<{ path: string; text: string; exists: boolean }>(`/api/doc?path=${encodeURIComponent(path)}`),
  putDoc: (path: string, text: string) => j<any>("/api/doc", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, text }) }),
  specs: (cwd: string) => j<any[]>(`/api/specs?cwd=${encodeURIComponent(cwd)}`),
  sessions: (cwd?: string) => j<any[]>(`/api/sessions${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`),
  session: (id: string) => j<any>(`/api/sessions/${id}`),
  files: (cwd: string, depth = 4) => j<any>(`/api/files?cwd=${encodeURIComponent(cwd)}&depth=${depth}`),
  versions: (path: string) => j<any>(`/api/versions?path=${encodeURIComponent(path)}`),
  version: (id: number) => j<any>(`/api/versions/${id}`),
  diff: (id: number, against?: number) => j<any>(`/api/versions/${id}/diff${against ? `?against=${against}` : ""}`),
  exportUrl: (id: string, format: string) => `${API}/api/runs/${id}/export?format=${format}`,
};
