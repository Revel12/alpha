import assert from "node:assert/strict";
import test from "node:test";
import {
  alphaToolRegistry,
  getAdvertisedAlphaLanguageModelTools,
  getAdvertisedAlphaTools,
  getAlphaToolRegistration,
} from "../out/toolRegistry.js";

test("public tools are advertised by default", () => {
  const names = getAdvertisedAlphaLanguageModelTools().map((tool) => tool.name);

  assert.deepEqual(names, ["read", "search", "find", "diff", "edit", "write", "todo"]);
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

test("registry names are unique", () => {
  const names = alphaToolRegistry.map((tool) => tool.name);

  assert.equal(new Set(names).size, names.length);
});
