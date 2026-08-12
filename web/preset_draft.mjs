function cleanText(value) {
  return String(value ?? "").trim();
}

export function normalizeTags(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const tag = cleanText(value);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

export function draftFromPreset(preset, promptText) {
  const source = preset || {};
  return {
    name: source.name || "",
    type: source.type || "positive",
    content: String(promptText ?? source.content ?? ""),
    description: source.description || "",
    tagsText: normalizeTags(source.tags).join(", "),
    folderId: source.folderId || null,
  };
}

export function payloadFromDraft(draft, preset = null) {
  const payload = {
    name: cleanText(draft.name) || "未命名预设",
    type: draft.type || "custom",
    content: String(draft.content ?? ""),
    description: cleanText(draft.description),
    tags: normalizeTags(draft.tagsText),
    folderId: draft.folderId || null,
  };
  if (preset?.id) payload.id = preset.id;
  return payload;
}

export function draftMetadata(draft) {
  return {
    name: cleanText(draft.name),
    type: draft.type || "custom",
    description: cleanText(draft.description),
    tagsText: normalizeTags(draft.tagsText).join(", "),
    folderId: draft.folderId || null,
  };
}

export function isDraftDirty(preset, draft) {
  if (!preset) return Boolean(
    cleanText(draft.name)
    || String(draft.content ?? "")
    || cleanText(draft.description)
    || normalizeTags(draft.tagsText).length,
  );
  return (
    cleanText(draft.name) !== cleanText(preset.name)
    || (draft.type || "custom") !== (preset.type || "custom")
    || String(draft.content ?? "") !== String(preset.content ?? "")
    || cleanText(draft.description) !== cleanText(preset.description)
    || (draft.folderId || null) !== (preset.folderId || null)
    || JSON.stringify(normalizeTags(draft.tagsText)) !== JSON.stringify(normalizeTags(preset.tags))
  );
}

export function variantName(name, suffix = "变体", fallback = "新预设") {
  return `${cleanText(name) || fallback} - ${suffix}`;
}

export function growNodeToMinimum(currentSize, minimumSize) {
  const readSize = (size, index) => {
    const value = Number(size?.[index]);
    return Number.isFinite(value) ? value : 0;
  };
  return [
    Math.max(readSize(currentSize, 0), readSize(minimumSize, 0)),
    Math.max(readSize(currentSize, 1), readSize(minimumSize, 1)),
  ];
}

export function migrateNodeState(widgetValues, properties = {}) {
  const values = Array.isArray(widgetValues) ? widgetValues : [];
  const propertyId = String(properties.promptPresetId || "");
  const dirty = Boolean(properties.promptPresetDirty);
  const schema = Number(properties.promptPresetSchema || 0);

  if (values.length >= 3) {
    return {
      presetId: String(values[0] || propertyId),
      content: String(values[1] ?? ""),
      dirty,
      needsPresetSync: false,
    };
  }

  if (schema >= 3) {
    return {
      presetId: propertyId,
      content: String(values[1] ?? values[0] ?? ""),
      dirty,
      needsPresetSync: false,
    };
  }

  if (schema >= 2) {
    const content = values.length > 1 && values[0] == null ? values[1] : values[0];
    return {
      presetId: propertyId,
      content: String(content ?? ""),
      dirty,
      needsPresetSync: false,
    };
  }

  const first = String(values[0] ?? "");
  const legacyId = propertyId || (first.startsWith("preset_") ? first : "");
  if (legacyId) {
    return {
      presetId: legacyId,
      content: "",
      dirty: false,
      needsPresetSync: true,
    };
  }

  return { presetId: "", content: first, dirty, needsPresetSync: false };
}
