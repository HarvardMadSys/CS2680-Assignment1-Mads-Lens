/**
 * Shared Chrome DevTools Protocol client. Zero dependencies — node's global
 * WebSocket and fetch. Used by the screenshot scripts beside it.
 *
 * Start a browser for these to attach to:
 *   google-chrome --headless=new --disable-gpu --no-sandbox \
 *     --remote-debugging-port=9222 --user-data-dir=/tmp/cc-shot about:blank
 */

export async function attach(port = 9222) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("No page target — is Chrome running with --remote-debugging-port?");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));

  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });

  return { send, close: () => ws.close() };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fill the composer and submit, the way React expects. */
export const submitPrompt = (prompt) => `(() => {
  const ta = document.querySelector('.composer__input');
  if (!ta) return 'no composer';
  const set = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value').set;
  set.call(ta, ${JSON.stringify(prompt)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.form.requestSubmit();
  return 'submitted';
})()`;
