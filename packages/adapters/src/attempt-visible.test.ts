import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import type { ReplyState, RunContext } from "./run-context.js";
import { noteAttemptFirstVisible } from "./run-progress.js";

function context(options: { startedAt?: Date; firstResponseAt?: Date | null }): RunContext {
  const reply = { attemptFirstVisibleLogged: false } as ReplyState;
  return {
    runId: "run-1",
    run: { firstResponseAt: options.firstResponseAt ?? null },
    attempt: { id: "attempt-1", ...(options.startedAt ? { startedAt: options.startedAt } : {}) },
    state: { reply },
  } as RunContext;
}

describe("attempt first visible text", () => {
  afterEach(() => installLogger(createLogger({ service: "test", level: "off", sinks: [] })));

  it("measures this attempt from its own start and does not repeat", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const startedAt = new Date(Date.now() - 40);
    const ctx = context({ startedAt, firstResponseAt: new Date("2026-01-01T00:00:00Z") });
    noteAttemptFirstVisible(ctx);
    noteAttemptFirstVisible(ctx);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      message: "attempt.first_visible",
      "run.id": "run-1",
      "attempt.id": "attempt-1",
      "run.first_response_prior": true,
    });
    const visibleMs = sink.events[0]?.["attempt.first_visible_ms"];
    expect(visibleMs).toEqual(expect.any(Number));
    expect(visibleMs).toBeGreaterThanOrEqual(40);
    expect(visibleMs).toBeLessThan(5_000);
  });

  it("leaves the run's first response unmarked when this attempt has not answered yet", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    noteAttemptFirstVisible(context({ startedAt: new Date(), firstResponseAt: null }));
    expect(sink.events[0]).toMatchObject({ "run.first_response_prior": false });
  });

  it("does not invent a timestamp when the attempt start is unknown", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    noteAttemptFirstVisible(context({}));
    expect(sink.events).toEqual([]);
  });
});
