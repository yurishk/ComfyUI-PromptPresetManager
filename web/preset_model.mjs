export function buildFolderTree(folders) {
  const valid = Array.isArray(folders) ? folders : [];
  const ids = new Set(valid.map((folder) => folder.id));
  const byParent = new Map();
  for (const folder of valid) {
    const parent = folder.parentId && ids.has(folder.parentId) && folder.parentId !== folder.id
      ? folder.parentId
      : null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(folder);
  }
  const seen = new Set();
  const build = (parentId) => (byParent.get(parentId) || [])
    .slice()
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh"))
    .filter((folder) => !seen.has(folder.id))
    .map((folder) => {
      seen.add(folder.id);
      return { folder, children: build(folder.id) };
    });
  const roots = build(null);
  for (const folder of valid) {
    if (!seen.has(folder.id)) roots.push({ folder, children: [] });
  }
  return roots;
}

export function collectFolderIds(folders, rootId) {
  const result = new Set();
  if (!rootId) return result;
  const pending = [rootId];
  while (pending.length) {
    const current = pending.pop();
    if (result.has(current)) continue;
    result.add(current);
    for (const folder of folders || []) {
      if (folder.parentId === current) pending.push(folder.id);
    }
  }
  return result;
}

export function quickSearchPresets(presets, query, limit = 60) {
  const normalized = String(query || "").trim().toLocaleLowerCase();
  const result = (Array.isArray(presets) ? presets : []).filter((preset) => (
    !normalized
    || [preset.name, preset.content, preset.description, ...(preset.tags || [])]
      .some((value) => String(value || "").toLocaleLowerCase().includes(normalized))
  ));

  if (!normalized) {
    result.sort((a, b) => (
      (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
      || (b.sortOrder ?? 0) - (a.sortOrder ?? 0)
    ));
  }
  return result.slice(0, Math.max(0, limit));
}

export function filterPresets(presets, folders, options = {}) {
  const selectedFolderId = options.selectedFolderId ?? null;
  const selectedType = options.selectedType ?? "all";
  const searchQuery = String(options.searchQuery || "").trim().toLocaleLowerCase();
  const sortField = options.sortField ?? "custom";
  const sortDir = options.sortDir === "desc" ? -1 : 1;
  let result = Array.isArray(presets) ? presets.slice() : [];

  if (selectedFolderId === "fav") result = result.filter((preset) => preset.isFavorite);
  else if (selectedFolderId === "unfiled") result = result.filter((preset) => !preset.folderId);
  else if (selectedFolderId) {
    const included = collectFolderIds(folders, selectedFolderId);
    result = result.filter((preset) => included.has(preset.folderId));
  }

  if (selectedType !== "all") result = result.filter((preset) => preset.type === selectedType);
  if (searchQuery) {
    result = result.filter((preset) => [
      preset.name,
      preset.content,
      preset.description,
      ...(Array.isArray(preset.tags) ? preset.tags : []),
    ].some((value) => String(value || "").toLocaleLowerCase().includes(searchQuery)));
  }

  if (sortField === "name") {
    result.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh") * sortDir);
  } else if (sortField === "updatedAt") {
    result.sort((a, b) => ((Date.parse(a.updatedAt) || 0) - (Date.parse(b.updatedAt) || 0)) * sortDir);
  } else {
    result.sort((a, b) => ((a.sortOrder ?? 0) - (b.sortOrder ?? 0)) || ((Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)));
    if (sortDir < 0) result.reverse();
  }
  return result;
}
