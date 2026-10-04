import '@testing-library/jest-dom/vitest'

// jsdom doesn't implement ResizeObserver; Radix primitives (e.g. ScrollArea, used to wrap the
// chat list) use it in a layout effect that would otherwise throw during tests.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
