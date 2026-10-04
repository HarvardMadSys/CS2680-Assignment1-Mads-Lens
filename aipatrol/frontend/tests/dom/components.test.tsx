import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/components/Composer";
import { CwdField } from "../../src/components/CwdField";
import { EventList } from "../../src/components/EventNode";
import { Outline } from "../../src/components/Outline";
import { Round } from "../../src/components/Round";
import { buildTree } from "../../src/lib/tree";
import type { FlowItem } from "../../src/lib/tree";
import { round, text, tool } from "../helpers";

afterEach(cleanup);

const type = (el: HTMLElement, value: string) =>
  fireEvent.change(el, { target: { value } });

describe("Composer", () => {
  const box = () => screen.getByRole("textbox");

  it("sends on Enter, trimmed, and empties the box", () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);

    type(box(), "  fix the parser  ");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("fix the parser");
    expect(box()).toHaveValue("");
  });

  // Shift+Enter is how you write a multi-line prompt.
  it("does not send on Shift+Enter", () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);

    type(box(), "first line");
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(box()).toHaveValue("first line");
  });

  it("refuses to send nothing", () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    type(box(), "   ");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  // A run in flight must not cost you the draft you are part-way through:
  // the box stays live, only the send is held back.
  it("lets you keep typing while a round is running, but will not send", () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} locked lockedReason="Still going." />);

    expect(box()).not.toBeDisabled();

    type(box(), "the next thing");
    expect(box()).toHaveValue("the next thing");

    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box()).toHaveValue("the next thing");

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("says why a draft is held back, but only once there is one", () => {
    const { rerender } = render(
      <Composer onSubmit={vi.fn()} locked lockedReason="Still going." />,
    );
    expect(screen.queryByText("Still going.")).not.toBeInTheDocument();

    type(box(), "queued up");
    expect(screen.getByText("Still going.")).toBeInTheDocument();

    // Unlocking releases the same draft, untouched.
    rerender(<Composer onSubmit={vi.fn()} lockedReason="Still going." />);
    expect(screen.queryByText("Still going.")).not.toBeInTheDocument();
    expect(box()).toHaveValue("queued up");
    expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();
  });
});

describe("CwdField", () => {
  it("is a button until you click it", () => {
    render(<CwdField cwd="/home/you/scratch" onChange={vi.fn()} />);

    expect(screen.getByText("scratch")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByLabelText("Working directory")).toHaveValue(
      "/home/you/scratch",
    );
  });

  it("commits a new directory on Enter", () => {
    const onChange = vi.fn();
    render(<CwdField cwd="/home/you/scratch" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByLabelText("Working directory");
    type(input, "  /tmp/other  ");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("/tmp/other");
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("commits on blur too, since clicking away is a decision", () => {
    const onChange = vi.fn();
    render(<CwdField cwd="/home/you/scratch" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByLabelText("Working directory");
    type(input, "/tmp/other");
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith("/tmp/other");
  });

  it("abandons the edit on Escape", () => {
    const onChange = vi.fn();
    render(<CwdField cwd="/home/you/scratch" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByLabelText("Working directory");
    type(input, "/tmp/other");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("scratch")).toBeInTheDocument();
  });

  it("says nothing changed when nothing changed", () => {
    const onChange = vi.fn();
    render(<CwdField cwd="/home/you/scratch" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button"));
    fireEvent.keyDown(screen.getByLabelText("Working directory"), { key: "Enter" });

    expect(onChange).not.toHaveBeenCalled();
  });

  // A run's own directory is fixed: it is where the subprocess was spawned.
  it("is not editable when locked", () => {
    render(<CwdField cwd="/home/you/scratch" onChange={vi.fn()} locked />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("/home/you/scratch")).toBeInTheDocument();
  });
});

describe("ToolCall", () => {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  const renderCall = (event: ReturnType<typeof tool>, expandAll = false) =>
    render(<EventList nodes={buildTree([event])} expandAll={expandAll} />);

  it("names the tool and the thing it acted on", () => {
    renderCall(tool({ name: "Bash", input: { command: "pytest -q" }, result: "ok" }));
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("pytest -q")).toBeInTheDocument();
  });

  // Head-only truncation would throw away the last line, which is the one
  // that says whether the command worked.
  it("shows a long result folded, head and tail, with a way in", () => {
    const { container } = renderCall(tool({ name: "Bash", result: lines(100) }));
    const shown = container.querySelector("pre")?.textContent ?? "";

    expect(shown).toContain("line 1\n");
    expect(shown).toContain("line 100");
    expect(shown).not.toContain("line 50");
    expect(screen.getByText(/⋯ 84 more lines — show all/)).toBeInTheDocument();
  });

  it("shows the whole result and the full input once expanded", () => {
    renderCall(tool({ name: "Bash", input: { command: "ls" }, result: lines(100) }));

    fireEvent.click(screen.getByText(/show all/));

    expect(screen.getByText(/line 50/)).toBeInTheDocument();
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("100 lines")).toBeInTheDocument();
  });

  it("opens every call when the run header says expand all", () => {
    renderCall(tool({ name: "Bash", result: lines(100) }), true);
    expect(screen.getByText(/line 50/)).toBeInTheDocument();
  });

  it("spins while a call is still running, with no result pane", () => {
    renderCall(tool({ status: "pending", result: undefined }));
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.queryByText("Result")).toBeNull();
  });

  // A failure is why you are looking, so its output is not tucked away.
  it("shows a failure as failed, with its output", () => {
    renderCall(tool({ status: "error", result: "ENOENT: no such file" }));
    expect(screen.getByLabelText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/ENOENT: no such file/)).toBeInTheDocument();
  });
});

describe("Round", () => {
  const worked = round({
    events: [
      text({ text: "looking now" }),
      tool({ name: "Bash", input: { command: "pytest" }, result: "ok" }),
      text({ text: "all done" }),
    ],
    costUsd: 0.06,
    durationMs: 2_800,
    numTurns: 2,
  });

  it("shows the prompt and everything the agent did", () => {
    render(<Round round={worked} foldByDefault={false} expandAll={false} />);

    expect(screen.getByText("do the thing")).toBeInTheDocument();
    expect(screen.getByText("looking now")).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("all done")).toBeInTheDocument();
  });

  // What you want back from an old round is what it decided, not the steps.
  it("folds the work but keeps the conclusion", () => {
    render(<Round round={worked} foldByDefault expandAll={false} />);

    expect(screen.getByText(/2 events, folded/)).toBeInTheDocument();
    expect(screen.queryByText("looking now")).toBeNull();
    expect(screen.getByText("all done")).toBeInTheDocument();

    fireEvent.click(screen.getByText(/2 events, folded/));
    expect(screen.getByText("looking now")).toBeInTheDocument();
  });

  it("unfolds when the run header says expand all", () => {
    render(<Round round={worked} foldByDefault expandAll />);
    expect(screen.getByText("looking now")).toBeInTheDocument();
  });

  it("has nothing to fold when the round is all conclusion", () => {
    const r = round({ events: [text({ text: "nothing to do" })] });
    render(<Round round={r} foldByDefault expandAll={false} />);
    expect(screen.queryByText(/folded/)).toBeNull();
    expect(screen.getByText("nothing to do")).toBeInTheDocument();
  });

  it("closes with the numbers the CLI reported", () => {
    render(<Round round={worked} foldByDefault={false} expandAll={false} />);

    expect(screen.getByText("finished")).toBeInTheDocument();
    expect(screen.getByText("$0.06")).toBeInTheDocument();
    expect(screen.getByText("2.8s")).toBeInTheDocument();
    expect(screen.getByText(/2 turns/)).toBeInTheDocument();
  });

  it("shows a failure as an alert carrying its message", () => {
    const failed = round({ status: "error", error: "Turn limit reached." });
    render(<Round round={failed} foldByDefault={false} expandAll={false} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Turn limit reached.");
  });

  it("says which session a resumed round continues", () => {
    const resumed = round({ resumedFrom: "9cc3f365-aaaa", status: "done" });
    render(<Round round={resumed} foldByDefault={false} expandAll={false} />);

    expect(screen.getByText(/continues session/)).toBeInTheDocument();
    expect(screen.getByText("9cc3f365…")).toBeInTheDocument();
  });
});

describe("Outline", () => {
  const items: FlowItem[] = [
    {
      kind: "call",
      id: "c1",
      call: tool({
        id: "c1",
        name: "Agent",
        input: { description: "Summarise the docs" },
      }),
    },
    { kind: "call", id: "c2", call: tool({ id: "c2", name: "Read" }) },
  ];

  const outline = (over: Partial<Parameters<typeof Outline>[0]> = {}) =>
    render(
      <Outline
        items={items}
        callCount={2}
        failureCount={0}
        folded={false}
        onToggleFold={vi.fn()}
        onResize={vi.fn()}
        onResetWidth={vi.fn()}
        onHide={vi.fn()}
        onReveal={vi.fn()}
        expandAll={false}
        showNames
        onToggleNames={vi.fn()}
        {...over}
      />,
    );

  /**
   * Two lanes both reading "Agent" say nothing about which is which, so a
   * delegation is labelled by what it was asked to do.
   */
  it("labels a delegation by its description", () => {
    outline();
    expect(screen.getByText("Summarise the docs")).toBeInTheDocument();
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
  });

  it("falls back to the tool name when names are off", () => {
    outline({ showNames: false });
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.queryByText("Summarise the docs")).not.toBeInTheDocument();
  });

  // Only delegations are renamed; a Read is identified by its tool.
  it("leaves ordinary calls named after their tool either way", () => {
    const { rerender } = outline();
    expect(screen.getByText("Read")).toBeInTheDocument();

    rerender(
      <Outline
        items={items}
        callCount={2}
        failureCount={0}
        folded={false}
        onToggleFold={vi.fn()}
        onResize={vi.fn()}
        onResetWidth={vi.fn()}
        onHide={vi.fn()}
        onReveal={vi.fn()}
        expandAll={false}
        showNames={false}
        onToggleNames={vi.fn()}
      />,
    );
    expect(screen.getByText("Read")).toBeInTheDocument();
  });

  it("says which way the switch is set", () => {
    const onToggleNames = vi.fn();
    outline({ onToggleNames });

    const button = screen.getByRole("button", { name: /Names/ });
    expect(button).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(button);
    expect(onToggleNames).toHaveBeenCalled();
  });
});
