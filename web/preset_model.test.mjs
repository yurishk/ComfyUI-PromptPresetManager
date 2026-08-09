import assert from "node:assert/strict";
import test from "node:test";

import { collectFolderIds, filterPresets } from "./preset_model.mjs";

const folders = [
  { id: "root", name: "Root", parentId: null },
  { id: "child", name: "Child", parentId: "root" },
  { id: "grand", name: "Grand", parentId: "child" },
  { id: "other", name: "Other", parentId: null },
];

const presets = [
  { id: "a", name: "Alpha", content: "red apple", tags: [], folderId: "root", type: "positive", sortOrder: 1 },
  { id: "b", name: "Beta", content: "blue sky", tags: ["nature"], folderId: "grand", type: "scene", sortOrder: 2 },
  { id: "c", name: "Gamma", content: "plain", tags: [], folderId: "other", type: "custom", sortOrder: 3 },
];

test("folder selection includes all descendants", () => {
  assert.deepEqual([...collectFolderIds(folders, "root")].sort(), ["child", "grand", "root"]);
  const result = filterPresets(presets, folders, { selectedFolderId: "root" });
  assert.deepEqual(result.map((item) => item.id), ["a", "b"]);
});

test("search covers content and tags", () => {
  assert.deepEqual(filterPresets(presets, folders, { searchQuery: "nature" }).map((item) => item.id), ["b"]);
  assert.deepEqual(filterPresets(presets, folders, { searchQuery: "apple" }).map((item) => item.id), ["a"]);
});
