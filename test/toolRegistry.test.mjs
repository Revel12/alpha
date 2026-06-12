import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ESSENTIAL_TOOL_NAMES,
  alphaToolRegistry,
  getAdvertisedAlphaLanguageModelTools,
  getAdvertisedAlphaTools,
  getDiscoverableAlphaToolNames,
  getEssentialAlphaToolNames,
  getAlphaToolRegistration,
} from "../out/toolRegistry.js";
import { buildAlphaSystemPrompt } from "../out/promptBuilder.js";
import { InMemoryFileSnapshotStore } from "../out/store.js";

test("public tools are advertised by default", () => {
  const names = getAdvertisedAlphaLanguageModelTools().map((tool) => tool.name);

  assert.deepEqual(names, ["read", "bash", "search", "find", "edit", "write", "todo"]);
});

test("hidden tools are registered but not advertised by default", () => {
  assert.equal(getAlphaToolRegistration("resolve")?.visibility, "hidden");

  const advertisedNames = new Set(getAdvertisedAlphaTools().map((tool) => tool.name));
  assert.equal(advertisedNames.has("resolve"), false);
});

test("hidden tools can be forced for a workflow", () => {
  const advertisedNames = getAdvertisedAlphaLanguageModelTools({ forceTools: ["resolve"] }).map((tool) => tool.name);

  assert.equal(advertisedNames.includes("resolve"), true);
});

test("hidden tools can be selected as the only forced workflow tool", () => {
  const advertisedNames = getAdvertisedAlphaLanguageModelTools({ forceTools: ["resolve"], onlyForced: true }).map((tool) => tool.name);

  assert.deepEqual(advertisedNames, ["resolve"]);
});

test("essential-only selection follows OMP-style load modes", () => {
  assert.deepEqual(DEFAULT_ESSENTIAL_TOOL_NAMES, ["read", "bash", "edit"]);
  assert.deepEqual(getEssentialAlphaToolNames(), ["read", "bash", "edit"]);

  const advertisedNames = getAdvertisedAlphaLanguageModelTools({ includeDiscoverable: false }).map((tool) => tool.name);
  assert.deepEqual(advertisedNames, ["read", "bash", "edit"]);
});

test("discoverable public tools are classified separately from essentials", () => {
  assert.deepEqual(getDiscoverableAlphaToolNames(), ["search", "find", "write", "todo"]);
});

test("registry names are unique", () => {
  const names = alphaToolRegistry.map((tool) => tool.name);

  assert.equal(new Set(names).size, names.length);
});

test("registered tools carry lazy handlers", () => {
  for (const tool of alphaToolRegistry) {
    assert.equal(typeof tool.loadTool, "function");
  }
});

test("edit uses the OMP-style input field", () => {
  const edit = getAlphaToolRegistration("edit");

  assert.deepEqual(edit.inputSchema.required, ["input"]);
  assert.equal(edit.inputSchema.properties.input.type, "string");
});

test("bash uses the OMP-style command contract", () => {
  const bash = getAlphaToolRegistration("bash");

  assert.equal(bash.loadMode, "essential");
  assert.deepEqual(bash.inputSchema.required, ["command"]);
  assert.equal(bash.inputSchema.properties.command.type, "string");
  assert.equal(bash.inputSchema.properties.cwd.type, "string");
  assert.equal(bash.inputSchema.properties.timeout.type, "number");
  assert.equal(bash.inputSchema.properties.async.type, "boolean");
  assert.equal(bash.inputSchema.properties.pty.type, "boolean");
});

test("resolve uses the hidden OMP-style action contract", () => {
  const resolve = getAlphaToolRegistration("resolve");

  assert.deepEqual(resolve.inputSchema.required, ["action", "reason"]);
  assert.deepEqual(resolve.inputSchema.properties.action.enum, ["apply", "discard"]);
});

test("tool descriptions steer existing-file changes to edit over write", () => {
  const edit = getAlphaToolRegistration("edit");
  const write = getAlphaToolRegistration("write");

  assert.match(edit.description, /Default tool for modifying existing files/);
  assert.match(write.description, /Do not use for routine edits/);
});

test("system prompt includes OMP-style tool priority", () => {
  const prompt = buildAlphaSystemPrompt();

  assert.match(prompt, /# Tool Priority/);
  assert.match(prompt, /terminal work.*`bash`/);
  assert.match(prompt, /artifact:\/\/\.\.\./);
  assert.match(prompt, /surgical existing-file edits -> `edit`, not `write`/);
  assert.match(prompt, /file\/dir reads -> `read`/);
});

test("file snapshot store records four-character tags", () => {
  const snapshots = new InMemoryFileSnapshotStore();
  const first = snapshots.record("src/a.ts", "export const value = 1;\n");

  assert.match(first.tag, /^[A-F0-9]{4}$/);
  assert.equal(snapshots.has("src/a.ts", first.tag), true);
  assert.equal(snapshots.get("src/a.ts", first.tag)?.content, "export const value = 1;\n");
});
