import test from "node:test";
import assert from "node:assert/strict";
import { createHistoryGuard } from "./preset_history_guard.mjs";

test("replacement protects both sides in order, including final result", async () => {
  let current = { content: "A" };
  const archived = [];
  const guard = createHistoryGuard({ read: () => ({ ...current }), capture: async (s) => archived.push(s.content), apply: (s) => { current = s; }, status() {} });
  await Promise.all([guard.replace({ content: "B" }), guard.replace({ content: "C" })]);
  assert.equal(current.content, "C");
  assert.deepEqual(archived, ["A", "B", "B", "C"]);
});

test("typing during archive never gets overwritten", async () => {
  let current = { content: "A" }, release;
  const archived = [];
  const pending = new Promise((resolve) => { release = resolve; });
  const guard = createHistoryGuard({ read: () => ({ ...current }), capture: async (s) => { archived.push(s.content); if (s.content === "A") await pending; }, apply: (s) => { current = s; }, status() {} });
  const replacement = guard.replace({ content: "B" });
  await Promise.resolve();
  current = { content: "new edit" }; guard.changed(); release();
  assert.equal(await replacement, false);
  assert.equal(current.content, "new edit");
  assert.deepEqual(archived, ["A", "B"]);
});

test("failed capture and removal cannot discard the draft; queue recovers", async () => {
  let current = { content: "A" }, fail = true;
  const guard = createHistoryGuard({ read: () => ({ ...current }), capture: async () => { if (fail) throw Error("disk full"); }, apply: (s) => { current = s; }, status() {} });
  await assert.rejects(guard.replace({ content: "B" }), /disk full/);
  assert.equal(current.content, "A"); fail = false;
  await guard.replace({ content: "C" }); assert.equal(current.content, "C");
  guard.dispose(); await guard.replace({ content: "D" }); assert.equal(current.content, "C");
});
