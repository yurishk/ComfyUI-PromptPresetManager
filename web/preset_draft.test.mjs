import assert from "node:assert/strict";
import test from "node:test";

import {
  draftFromPreset,
  draftMetadata,
  growNodeToMinimum,
  isDraftDirty,
  migrateNodeState,
  payloadFromDraft,
  variantName,
} from "./preset_draft.mjs";

const preset = {
  id: "p1",
  name: "Portrait",
  type: "positive",
  content: "soft light",
  description: "base",
  tags: ["face", "light"],
  folderId: "folder_a",
  isFavorite: true,
};

test("draft detects content and compact metadata changes", () => {
  const clean = draftFromPreset(preset, preset.content);
  assert.equal(isDraftDirty(preset, clean), false);

  assert.equal(isDraftDirty(preset, { ...clean, content: "hard light" }), true);
  assert.equal(isDraftDirty(preset, { ...clean, name: "Portrait 2" }), true);
  assert.equal(isDraftDirty(preset, { ...clean, type: "style" }), true);
  assert.equal(isDraftDirty(preset, { ...clean, folderId: null }), true);
});

test("quick payload contains every editable field without erasing favorite state", () => {
  const draft = {
    name: "Portrait edit",
    type: "style",
    content: "rim light",
    description: "variant",
    tagsText: "face, cinematic, face",
    folderId: "folder_b",
  };

  assert.deepEqual(payloadFromDraft(draft, preset), {
    id: "p1",
    name: "Portrait edit",
    type: "style",
    content: "rim light",
    description: "variant",
    tags: ["face", "cinematic"],
    folderId: "folder_b",
  });
});

test("variant names stay concise", () => {
  assert.equal(variantName("Portrait"), "Portrait - 变体");
  assert.equal(variantName(""), "新预设 - 变体");
});

test("legacy one-widget workflows migrate their preset id into node properties", () => {
  assert.deepEqual(
    migrateNodeState(["preset_123"], { promptPresetId: "preset_123" }),
    { presetId: "preset_123", content: "", dirty: false, needsPresetSync: true },
  );
});

test("intermediate three-widget workflows keep their native prompt draft", () => {
  assert.deepEqual(
    migrateNodeState(["preset_123", "edited locally", true], { promptPresetDirty: true }),
    { presetId: "preset_123", content: "edited locally", dirty: true, needsPresetSync: false },
  );
});

test("current workflows treat the single widget as prompt content", () => {
  assert.deepEqual(
    migrateNodeState(["preset-like text"], { promptPresetSchema: 2, promptPresetId: "preset_123" }),
    { presetId: "preset_123", content: "preset-like text", dirty: false, needsPresetSync: false },
  );
});

test("schema 2 recovers prompt text written after a sparse panel slot", () => {
  assert.deepEqual(
    migrateNodeState([null, "saved draft"], {
      promptPresetSchema: 2,
      promptPresetId: "preset_123",
      promptPresetDirty: true,
    }),
    { presetId: "preset_123", content: "saved draft", dirty: true, needsPresetSync: false },
  );
});

test("schema 3 reads prompt text from the stable slot after the panel", () => {
  assert.deepEqual(
    migrateNodeState(["ppm-panel-v1", "local draft"], {
      promptPresetSchema: 3,
      promptPresetId: "preset_123",
      promptPresetDirty: true,
    }),
    { presetId: "preset_123", content: "local draft", dirty: true, needsPresetSync: false },
  );
});

test("schema 4 uses the durable prompt property instead of an empty widget slot", () => {
  assert.deepEqual(
    migrateNodeState(["", ""], {
      promptPresetSchema: 4,
      promptPresetId: "preset_123",
      promptPresetText: "durable local draft",
      promptPresetDirty: true,
    }),
    { presetId: "preset_123", content: "durable local draft", dirty: true, needsPresetSync: false },
  );
});

test("schema 3 selected presets recover from the known double-empty serialization bug", () => {
  assert.deepEqual(
    migrateNodeState(["", ""], {
      promptPresetSchema: 3,
      promptPresetId: "preset_123",
      promptPresetDirty: true,
    }),
    { presetId: "preset_123", content: "", dirty: false, needsPresetSync: true },
  );
});

test("automatic layout never shrinks a user-resized editor", () => {
  assert.deepEqual(growNodeToMinimum([520, 860], [370, 420]), [520, 860]);
  assert.deepEqual(growNodeToMinimum([320, 260], [370, 420]), [370, 420]);
});

test("automatic layout accepts ComfyUI's typed node size", () => {
  const comfyNodeSize = new Float64Array([520, 860]);

  assert.deepEqual(growNodeToMinimum(comfyNodeSize, [370, 420]), [520, 860]);
});

test("node properties keep editable metadata without duplicating prompt content", () => {
  const metadata = draftMetadata({
    name: "  Variant  ", type: "style", content: "large prompt", description: " note ",
    tagsText: "tag-a, tag-b", folderId: "folder_1",
  });
  assert.deepEqual(metadata, {
    name: "Variant", type: "style", description: "note", tagsText: "tag-a, tag-b", folderId: "folder_1",
  });
  assert.equal("content" in metadata, false);
});
