import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerBusyError } from "./computer-lifecycle.js";
import {
  desktopProtectionGuardMessage,
  protectedComputerLifecycleRefusal,
} from "./desktop-command-guard.js";
import { lazyRunComputer } from "./run-computer.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { computerTools } from "./run-tools-computer.js";
import { appendToolCompletionAudit, toolErrorCode } from "./tool-completion-audit.js";

const graphical = {
  graphical: true,
  stored: { kind: "docker" },
} as RunContext["computer"];

function shellCall(command: string): ToolCall {
  return {
    name: "shell",
    args: { command },
    finish: async (result: unknown) => result,
  } as unknown as ToolCall;
}

const shell = computerTools.shell;
if (!shell) throw new Error("shell handler missing");

describe("shell fast failure", () => {
  it("refuses a protected command before the computer is created", async () => {
    const get = vi.fn();
    const started = performance.now();
    const result = await shell(
      { computer: { ...graphical, get } } as unknown as RunContext,
      shellCall("pkill chromium"),
    );
    const elapsedMs = performance.now() - started;
    expect(get).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: desktopProtectionGuardMessage("protected command pkill"),
    });
    expect(elapsedMs).toBeLessThan(50);
    expect(toolErrorCode((result as { error: string }).error)).toBe(
      "desktop_protection:protected_command",
    );
  });

  it("keeps ordinary commands and the documented background form off the guard", () => {
    for (const command of [
      "",
      "pwd && ls -la",
      "nohup python3 server.py < /dev/null > server.log 2>&1 &",
    ]) {
      expect(protectedComputerLifecycleRefusal(command)).toBeUndefined();
    }
    expect(protectedComputerLifecycleRefusal("echo $(date)")).toBe("command substitution");
  });

  it("does not start the computer again after a failed start", async () => {
    const start = vi.fn(async () => {
      throw new ComputerBusyError();
    });
    const computer = lazyRunComputer(start);
    await expect(computer.get()).rejects.toThrow("Computer is busy");
    await expect(computer.get()).rejects.toThrow("Computer is busy");
    expect(start).toHaveBeenCalledOnce();
  });

  it("starts a computer once and reuses it", async () => {
    const ready = { id: "computer-1", kind: "docker" };
    const start = vi.fn(async () => ready as never);
    const computer = lazyRunComputer(start);
    await expect(computer.get()).resolves.toBe(ready);
    await expect(computer.get()).resolves.toBe(ready);
    expect(start).toHaveBeenCalledOnce();
  });
});

describe("tool error codes", () => {
  afterEach(() => installLogger(createLogger({ service: "test", level: "off", sinks: [] })));

  it("classifies a failure without copying the command or a secret", async () => {
    const command = "printf secret-token-value";
    const secret = "secret-token-value";
    expect(toolErrorCode(desktopProtectionGuardMessage("command substitution"))).toBe(
      "desktop_protection:command_substitution",
    );
    expect(toolErrorCode(desktopProtectionGuardMessage(`unresolved variable $${secret}`))).toBe(
      "desktop_protection:unresolved_variable",
    );
    expect(toolErrorCode(new ComputerBusyError())).toBe("computer_busy");
    expect(toolErrorCode(`command failed: ${command}`)).toBe("unclassified");

    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const started = performance.now();
    for (let index = 0; index < 1000; index += 1) {
      toolErrorCode(desktopProtectionGuardMessage("command substitution"));
    }
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(100);
    await appendToolCompletionAudit(
      { events: { append: vi.fn(async () => undefined) } } as never,
      { spaceId: "space-1", threadId: "thread-1", botId: "bot-1", runId: "run-1" },
      {
        name: "shell",
        executionId: "call-1",
        durationMs: 17,
        error: desktopProtectionGuardMessage("command substitution"),
      },
    );
    expect(sink.events).toEqual([
      expect.objectContaining({
        message: "agent.tool.completed",
        tool: "shell",
        "tool.outcome": "error",
        "tool.duration_ms": 17,
        "tool.error_code": "desktop_protection:command_substitution",
      }),
    ]);
    expect(JSON.stringify(sink.events)).not.toContain(command);
    expect(JSON.stringify(sink.events)).not.toContain(secret);
  });
});
