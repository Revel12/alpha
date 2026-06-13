import * as vscode from "vscode";
import {
  type ApprovalSubject,
  formatApprovalPrompt,
  normalizeApprovalMode,
  resolveApproval,
} from "./approvalCore";
import type { AlphaContext, PermissionPersistence } from "./types";

type PermissionChoice = "Allow once" | "Always allow" | "Reject" | "Always reject";

const ALLOW_ONCE: PermissionChoice = "Allow once";
const ALLOW_ALWAYS: PermissionChoice = "Always allow";
const REJECT_ONCE: PermissionChoice = "Reject";
const REJECT_ALWAYS: PermissionChoice = "Always reject";

export async function ensureToolPermission(tool: ApprovalSubject, args: unknown, ctx: AlphaContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("alpha");
  const mode = normalizeApprovalMode(config.get("tools.approvalMode", "yolo"));
  const userConfig = config.get<Record<string, unknown>>("tools.approval", {});
  const resolved = resolveApproval(tool, args, mode, userConfig);

  if (resolved.policy === "deny") {
    throw new Error(`Tool "${tool.name}" is blocked by user policy.`);
  }
  if (resolved.policy === "allow") return;

  const cacheKey = permissionCacheKey(tool, args);
  const persisted = ctx.permissionDecisions.get(cacheKey);
  if (persisted === "allow_always") return;
  if (persisted === "reject_always") {
    throw new Error(`Tool call rejected by user preference (${tool.name}).`);
  }

  const selected = await vscode.window.showWarningMessage(
    formatApprovalPrompt(tool, args, resolved.reason),
    { modal: true },
    ALLOW_ONCE,
    ALLOW_ALWAYS,
    REJECT_ONCE,
    REJECT_ALWAYS,
  );

  if (selected === ALLOW_ALWAYS) {
    ctx.permissionDecisions.set(cacheKey, "allow_always");
    return;
  }
  if (selected === ALLOW_ONCE) return;

  if (selected === REJECT_ALWAYS) {
    ctx.permissionDecisions.set(cacheKey, "reject_always");
  }
  throw new Error(`Tool call rejected by user (${tool.name}).`);
}

function permissionCacheKey(tool: ApprovalSubject, args: unknown): string {
  const details = tool.formatApprovalDetails?.(args);
  const detailText = Array.isArray(details) ? details.join("\n") : details ?? "";
  return `${tool.name}\0${detailText}`;
}

export function permissionLabel(value: PermissionPersistence): string {
  return value === "allow_always" ? "Always allow" : "Always reject";
}
