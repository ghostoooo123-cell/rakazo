import type { AgentToolCompletion } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import type { ThreadEvents } from "@rakazo/db";
import { RunHistoryWriteError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isToolPauseResult } from "./approval-effect.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import { isFailedToolResult, toolResultError } from "./tool-result-error.js";

const GUARD_REASONS = new Set([
  "uninspectable shell syntax",
  "heredoc",
  "command substitution",
  "backtick",
  "herestring",
  "subshell",
  "comment",
  "unsupported shell syntax",
  "coproc",
  "function",
  "eval",
  "source",
  "browser profile path",
  "X11 path",
]);

const NAMED_ERRORS: Record<string, string> = {
  ComputerBusyError: "computer_busy",
  SandboxAllowanceUsedError: "sandbox_allowance",
  SandboxUnavailableError: "sandbox_unavailable",
  SandboxRateLimitError: "sandbox_rate_limit",
  SandboxSizeUnavailableError: "sandbox_size",
  SandboxUnresponsiveError: "sandbox_unresponsive",
};

function guardErrorCode(reason: string): string {
  if (GUARD_REASONS.has(reason)) return reason.replaceAll(" ", "_");
  if (reason.startsWith("unresolved variable")) return "unresolved_variable";
  if (reason.startsWith("protected command")) return "protected_command";
  if (reason.startsWith("systemctl ") || reason.startsWith("service ")) return "service_lifecycle";
  return "other";
}

/**
 * Stable class for a failed tool. The code never includes the command, output, or secret values.
 */
export function toolErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const named = NAMED_ERRORS[error.name];
    if (named) return named;
  }
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const guard = /^This command was not run: desktop-protection guard: ([^.]+)\./.exec(message);
  if (guard?.[1]) return `desktop_protection:${guardErrorCode(guard[1])}`;
  if (message.startsWith("This tool is disabled")) return "tool_disabled";
  if (/^[A-Za-z0-9_]+ is blocked in this space/.test(message)) return "approval_blocked";
  if (
    /^[A-Za-z0-9_]+ needs the owner's approval/.test(message) ||
    message.includes("needs the user's approval")
  )
    return "approval_required";
  if (message.startsWith("This tool is unavailable")) return "tool_unavailable";
  if (message.startsWith("The user's computer is not available"))
    return "user_computer_unavailable";
  if (message.startsWith("Helpers cannot")) return "helper_forbidden";
  if (message.startsWith("Daily check-ins can only")) return "tool_forbidden";
  if (message.startsWith("This stage was handed off")) return "stage_handed_off";
  if (message.startsWith("Computer is busy")) return "computer_busy";
  if (message.startsWith("Computer requires recovery")) return "computer_recovery";
  if (message.startsWith("Enter top-level computer mode")) return "computer_mode_required";
  if (message.startsWith("Page browser is unavailable")) return "page_browser_unavailable";
  if (error instanceof Error && error.name !== "Error") {
    const name = error.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 80);
    if (name) return `exception:${name}`;
  }
  return message ? "unclassified" : "unknown";
}

function isAuditableToolResult(value: unknown): value is {
  kind: "agent_tool_result";
  content: unknown[];
  details: unknown;
} {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "agent_tool_result" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export function toolCompletionFromResult(
  base: Pick<AgentToolCompletion, "name" | "executionId" | "durationMs">,
  result: unknown,
): AgentToolCompletion {
  const paused = isToolPauseResult(result);
  if (isFailedToolResult(result)) return { ...base, error: result.error, paused };
  return { ...base, result, paused };
}

export function toolCompletionAuditPayload(
  completion: AgentToolCompletion,
  secrets: string[] = [],
): Record<string, unknown> {
  const durationMs = Number.isFinite(completion.durationMs)
    ? Math.max(0, Math.round(completion.durationMs))
    : 0;
  const error =
    completion.error === undefined ? toolResultError(completion.result) : completion.error;
  const payload: Record<string, unknown> = {
    name: redactSecrets(completion.name, secrets),
    executionId: redactSecrets(completion.executionId, secrets),
    durationMs,
    outcome: completion.paused ? "paused" : error === undefined ? "succeeded" : "error",
  };
  if (error !== undefined) {
    payload.error = sanitizeConnectorError(error, secrets);
    payload.errorCode = toolErrorCode(error);
  }
  if (!isAuditableToolResult(completion.result)) return payload;

  payload.contentTypes = completion.result.content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const type = (part as { type?: unknown }).type;
    return type === "text" || type === "image" ? [type] : [];
  });
  const details = completion.result.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return payload;
  }
  const record = details as Record<string, unknown>;
  if (typeof record.frameId === "string") {
    payload.frameId = redactSecrets(record.frameId, secrets);
  }
  if (typeof record.capturedAt === "string") {
    payload.capturedAt = record.capturedAt;
  }
  if (typeof record.width === "number" && Number.isFinite(record.width)) {
    payload.width = record.width;
  }
  if (typeof record.height === "number" && Number.isFinite(record.height)) {
    payload.height = record.height;
  }
  return payload;
}

export async function appendToolCompletionAudit(
  deps: { events: Pick<ThreadEvents, "append"> },
  target: { spaceId: string; threadId: string; botId: string; runId: string },
  completion: AgentToolCompletion,
  secrets: string[] = [],
): Promise<void> {
  const payload = toolCompletionAuditPayload(completion, secrets);
  getLogger().info("agent.tool.completed", {
    "run.id": target.runId,
    "space.id": target.spaceId,
    "thread.id": target.threadId,
    "bot.id": target.botId,
    tool: payload.name,
    "tool.outcome": payload.outcome,
    "tool.duration_ms": payload.durationMs,
    ...(typeof payload.errorCode === "string" ? { "tool.error_code": payload.errorCode } : {}),
  });
  try {
    await deps.events.append({
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      runId: target.runId,
      type: "agent.tool.completed",
      payload,
    });
  } catch (error) {
    // A tool that finishes after its run was cancelled has no history to join.
    if (error instanceof RunHistoryWriteError) return;
    // Audit persistence must not change the tool result or strand the run.
    getLogger().warn("agent tool completion audit append failed", {
      "error.detail": sanitizeConnectorError(error, secrets),
      tool: redactSecrets(completion.name, secrets),
      executionId: redactSecrets(completion.executionId, secrets),
    });
  }
}
