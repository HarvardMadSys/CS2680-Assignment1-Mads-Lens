import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { httpDriver } from "../../src/agent/httpDriver";
import { handlers } from "../helpers";

/** A response whose body yields exactly these byte chunks, in order. */
function streaming(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  } as unknown as Response;
}

/** Let the driver's async reader loop drain. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const start = { prompt: "go", cwd: "/tmp", sessionId: null };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the request", () => {
  it("posts the prompt, the directory and the session to resume", async () => {
    fetchMock.mockResolvedValue(streaming([]));
    httpDriver({ prompt: "go", cwd: "/tmp/scratch", sessionId: "s1" }, handlers());
    await settle();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/run");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      prompt: "go",
      cwd: "/tmp/scratch",
      sessionId: "s1",
    });
  });
});

describe("reading the stream", () => {
  it("dispatches each complete line as it arrives", async () => {
    const h = handlers();
    fetchMock.mockResolvedValue(
      streaming([
        `${JSON.stringify({ type: "system", subtype: "init", session_id: "s1" })}\n`,
        `${JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "on it" }] },
        })}\n`,
        `${JSON.stringify({ type: "result", subtype: "success", session_id: "s1" })}\n`,
      ]),
    );

    httpDriver(start, h);
    await settle();

    expect(h.onSession).toHaveBeenCalledWith("s1");
    expect(h.onText).toHaveBeenCalledWith("on it", null);
    expect(h.onDone).toHaveBeenCalledOnce();
  });

  // A chunk boundary lands wherever the socket says; a line split across two
  // reads must not be parsed as two.
  it("reassembles a line split across chunks", async () => {
    const h = handlers();
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "split" }] },
    });
    fetchMock.mockResolvedValue(
      streaming([line.slice(0, 20), line.slice(20, 40), `${line.slice(40)}\n`]),
    );

    httpDriver(start, h);
    await settle();

    expect(h.onText).toHaveBeenCalledWith("split", null);
  });

  it("handles several lines arriving in one chunk", async () => {
    const h = handlers();
    const text = (t: string) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
    fetchMock.mockResolvedValue(streaming([`${text("one")}\n${text("two")}\n`]));

    httpDriver(start, h);
    await settle();

    expect(h.onText.mock.calls.map((c) => c[0])).toEqual(["one", "two"]);
  });

  // The last event of a run may not be newline-terminated.
  it("flushes a trailing line with no newline", async () => {
    const h = handlers();
    fetchMock.mockResolvedValue(
      streaming([JSON.stringify({ type: "result", subtype: "success" })]),
    );

    httpDriver(start, h);
    await settle();

    expect(h.onDone).toHaveBeenCalledOnce();
  });

  it("skips blank lines and keeps going past an unparseable one", async () => {
    const h = handlers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(
      streaming([
        "\n  \n",
        "{not json}\n",
        `${JSON.stringify({ type: "result", subtype: "success" })}\n`,
      ]),
    );

    httpDriver(start, h);
    await settle();

    expect(warn).toHaveBeenCalledOnce();
    expect(h.onDone).toHaveBeenCalledOnce();
  });

  it("reports a stream that dies mid-run", async () => {
    const h = handlers();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error("socket hang up"));
        },
      }),
    } as unknown as Response);

    httpDriver(start, h);
    await settle();

    expect(h.onError.mock.calls[0][0]).toContain("socket hang up");
  });
});

describe("when the run never starts", () => {
  it("uses the server's own message for a rejected run", async () => {
    const h = handlers();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Not a directory: /bad/path" }),
    } as unknown as Response);

    httpDriver(start, h);
    await settle();

    expect(h.onError).toHaveBeenCalledWith("Not a directory: /bad/path");
  });

  it("falls back to the status when the error body is not JSON", async () => {
    const h = handlers();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not JSON");
      },
    } as unknown as Response);

    httpDriver(start, h);
    await settle();

    expect(h.onError).toHaveBeenCalledWith("Server returned 500.");
  });

  it("says the server is unreachable when the fetch itself fails", async () => {
    const h = handlers();
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    httpDriver(start, h);
    await settle();

    expect(h.onError.mock.calls[0][0]).toContain("Could not reach the server");
    expect(h.onError.mock.calls[0][0]).toContain("ECONNREFUSED");
  });
});

describe("cancelling", () => {
  it("aborts the request, which is what stops the subprocess", async () => {
    fetchMock.mockImplementation((_url, init) => new Promise(() => init.signal));
    const cancel = httpDriver(start, handlers());
    await settle();

    cancel();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  // Stopping a run is not an error to report back to the user.
  it("stays quiet when the abort is the reason the fetch failed", async () => {
    const h = handlers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

    const cancel = httpDriver(start, h);
    cancel();
    await settle();

    expect(h.onError).not.toHaveBeenCalled();
  });
});
