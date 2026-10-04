import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { useCollapsible } from "../../src/hooks/useCollapsible";

afterEach(cleanup);

/**
 * A section that grows while you watch it. This is the shape of a lane during
 * a live run: children keep arriving, and the fold threshold it was measured
 * against gets crossed partway through.
 */
function Growing({
  start,
  threshold,
  expandAll = false,
}: {
  start: number;
  threshold: number;
  expandAll?: boolean;
}) {
  const [children, setChildren] = useState(start);
  const [open, setOpen] = useCollapsible({
    initiallyOpen: children <= threshold,
    expandAll,
    revealed: false,
    revealNonce: 0,
  });

  return (
    <div>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <span data-testid="children">{children}</span>
      <button onClick={() => setChildren((n) => n + 1)}>add child</button>
      <button onClick={() => setOpen((v) => !v)}>toggle</button>
    </div>
  );
}

const state = () => screen.getByTestId("state").textContent;
const addChild = () => act(() => screen.getByText("add child").click());
const toggle = () => act(() => screen.getByText("toggle").click());

describe("useCollapsible", () => {
  it("opens or closes once, from what it finds on arrival", () => {
    const { unmount } = render(<Growing start={2} threshold={8} />);
    expect(state()).toBe("open");
    unmount();

    render(<Growing start={30} threshold={8} />);
    expect(state()).toBe("closed");
  });

  /**
   * The bug this hook exists for: a lane open at three children used to snap
   * shut the moment a ninth arrived, because the threshold was re-evaluated
   * on every change rather than once.
   */
  it("stays open as children arrive past the fold threshold", () => {
    render(<Growing start={3} threshold={8} />);
    expect(state()).toBe("open");

    for (let i = 0; i < 12; i++) addChild();

    expect(screen.getByTestId("children").textContent).toBe("15");
    expect(state()).toBe("open");
  });

  it("keeps a closed section closed as it grows", () => {
    render(<Growing start={20} threshold={8} />);
    expect(state()).toBe("closed");
    addChild();
    expect(state()).toBe("closed");
  });

  /**
   * A choice the reader made by hand outranks anything arriving afterwards.
   * Opening a lane that arrived folded is the case that matters: every new
   * child re-crosses the threshold, so a re-derived state would shut it again
   * on the very next event.
   */
  it("does not discard a manual toggle when a child arrives", () => {
    render(<Growing start={20} threshold={8} />);
    expect(state()).toBe("closed");

    toggle();
    expect(state()).toBe("open");

    addChild();
    addChild();
    expect(state()).toBe("open");
  });

  describe("expand all", () => {
    it("opens a folded section when switched on", () => {
      const { rerender } = render(<Growing start={30} threshold={8} />);
      expect(state()).toBe("closed");

      rerender(<Growing start={30} threshold={8} expandAll />);
      expect(state()).toBe("open");
    });

    it("collapses everything when switched off", () => {
      const { rerender } = render(<Growing start={2} threshold={8} expandAll />);
      expect(state()).toBe("open");

      rerender(<Growing start={2} threshold={8} />);
      expect(state()).toBe("closed");
    });

    // Mounting with it already on must not be read as it having just changed.
    it("leaves the initial state alone on mount", () => {
      render(<Growing start={30} threshold={8} />);
      expect(state()).toBe("closed");
    });
  });
});
