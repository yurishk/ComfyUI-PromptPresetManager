// Full preset manager modal. One shared instance is created lazily and reused
// across nodes. Builds the entire UI with vanilla DOM so it works inside the
// ComfyUI extension sandbox without any build step.

import { PresetAPI, PresetStore, PRESET_TYPES, TYPE_MAP, DEFAULT_FOLDER_COLOR, downloadJson, sanitizeFilename } from "./preset_api.mjs";
import { tr } from "./i18n.mjs";
import { buildFolderTree, collectFolderIds, filterPresets } from "./preset_model.mjs";

const PAGE_SIZE = 30;

// ---------- tiny DOM helper ----------
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "dataset") {
      for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
    } else if (k in el) {
      try { el[k] = v; } catch { el.setAttribute(k, v); }
    } else el.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(msg, type = "info") {
  const t = h("div", { class: "ppm-toast ppm-toast-" + type }, String(msg));
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add("ppm-toast-show"));
  setTimeout(() => {
    t.classList.remove("ppm-toast-show");
    setTimeout(() => t.remove(), 250);
  }, 2400);
}

// ---------- singleton manager ----------
let shared = null;

export function getPresetManager() {
  if (!shared) shared = new PresetManager();
  return shared;
}

class PresetManager {
  constructor() {
    this.root = null;
    this.state = {
      folders: [],
      presets: [],
      settings: {},
      selectedFolderId: null, // null=全部, "fav", "unfiled", or folder.id
      searchQuery: "",
      selectedType: "all",
      sortField: "custom",
      sortDir: "asc",
      currentPage: 1,
    };
    this.sourceNode = null;
    this.onSelect = null;
    this._applyOnCreate = false;
    this._unsub = null;
    this._build();
  }

  open(node, onSelect) {
    this.sourceNode = node || null;
    this.onSelect = onSelect || null;
    this.root.classList.add("ppm-open");
    document.body.classList.add("ppm-modal-open");
    this.load();
  }

  close() {
    this.root.classList.remove("ppm-open");
    document.body.classList.remove("ppm-modal-open");
  }

  // ---------- build shell ----------
  _build() {
    const overlay = h("div", { class: "ppm-overlay" });
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) this.close();
    });

    const win = h("div", { class: "ppm-window" });

    // header
    const header = h("div", { class: "ppm-header" });
    const title = h("div", { class: "ppm-title" }, [
      h("span", { class: "ppm-title-icon" }, "▣"),
      h("span", {}, tr("预设管理器", "Preset Manager")),
    ]);
    const stats = h("span", { class: "ppm-stats" }, "");
    this.statsEl = stats;
    const actions = h("div", { class: "ppm-header-actions" }, [
      h("button", { class: "ppm-icon-btn ppm-close", title: tr("关闭", "Close"), onclick: () => this.close() }, "×"),
    ]);
    header.append(title, stats, actions);

    // body: sidebar + main
    this.sidebar = h("div", { class: "ppm-sidebar" });
    this.main = h("div", { class: "ppm-main" });
    this._buildToolbarOnce(this.main);
    this.listEl = h("div", { class: "ppm-list" });
    this.pagerEl = h("div", { class: "ppm-pager-wrap" });
    this.main.append(this.listEl, this.pagerEl);
    const body = h("div", { class: "ppm-body" }, [this.sidebar, this.main]);

    win.append(header, body);
    overlay.append(win);
    this.root = overlay;

    // editor + folder dialogs (nested overlays)
    this.presetDialog = this._buildPresetDialog();
    this.folderDialog = this._buildFolderDialog();
    overlay.append(this.presetDialog.root, this.folderDialog.root);

    // one global listener to close the export menu when clicking outside
    document.addEventListener("mousedown", (e) => {
      if (this._menuEl && this._menuEl.classList.contains("ppm-open") && !this._menuEl.contains(e.target)) {
        this._menuEl.classList.remove("ppm-open");
      }
    });

    this._unsub = PresetStore.subscribe((snapshot) => this._useSnapshot(snapshot));

    document.body.append(overlay);
  }

  // Build the toolbar once and reuse it; rebuilding on every keystroke would
  // steal focus from the search box, making it unusable.
  _buildToolbarOnce(root) {
    const s = this.state;
    const search = h("input", {
      class: "ppm-search", type: "text", placeholder: tr("搜索名称 / 内容 / 标签…", "Search name / content / tags…"),
      value: s.searchQuery,
      oninput: (e) => { s.searchQuery = e.target.value; s.currentPage = 1; this._renderList(); },
    });
    this.searchInput = search;
    const typeSelect = h("select", { class: "ppm-select", onchange: (e) => { s.selectedType = e.target.value; s.currentPage = 1; this._renderList(); } },
      [{ value: "all", label: tr("所有类型", "All Types") }, ...PRESET_TYPES].map((t) =>
        h("option", { value: t.value, selected: t.value === s.selectedType }, t.label))
    );
    this.typeSelect = typeSelect;
    const sortSelect = h("select", { class: "ppm-select", onchange: (e) => { s.sortField = e.target.value; s.currentPage = 1; this._renderList(); } },
      [["custom", tr("自定义排序", "Custom Order")], ["name", tr("按名称", "By Name")], ["updatedAt", tr("按时间", "By Date")]].map(([v, l]) =>
        h("option", { value: v, selected: v === s.sortField }, l))
    );
    this.sortSelect = sortSelect;
    const dirBtn = h("button", { class: "ppm-sort-dir", title: tr("切换排序方向", "Reverse sort order"), onclick: () => { s.sortDir = s.sortDir === "asc" ? "desc" : "asc"; this._renderList(); } }, s.sortDir === "asc" ? "↑" : "↓");
    this.sortDirBtn = dirBtn;
    const newBtn = h("button", { class: "ppm-new-preset", onclick: () => this.openPresetEditor(null) }, [h("span", {}, "+"), h("span", {}, tr("新建预设", "New Preset"))]);
    this.toolbar = h("div", { class: "ppm-toolbar" }, [
      h("div", { class: "ppm-search-wrap" }, [h("span", { class: "ppm-search-icon" }, "⌕"), search]),
      h("div", { class: "ppm-filters" }, [typeSelect, sortSelect, dirBtn]),
      h("div", { class: "ppm-toolbar-spacer" }),
      this._exportMenu(), newBtn,
    ]);
    root.append(this.toolbar);
  }

  // refresh select option states (keep focus) after data reloads
  _syncToolbarOptions() {
    const s = this.state;
    if (this.searchInput && document.activeElement !== this.searchInput) this.searchInput.value = s.searchQuery;
    if (this.typeSelect) this.typeSelect.value = s.selectedType;
    if (this.sortSelect) this.sortSelect.value = s.sortField;
    if (this.sortDirBtn) this.sortDirBtn.textContent = s.sortDir === "asc" ? "↑" : "↓";
  }

  // ---------- data ----------
  async load() {
    try {
      this._useSnapshot(await PresetStore.load());
    } catch (e) {
      toast(`${tr("加载预设失败", "Failed to load presets")}: ${e.message}`, "error");
    }
  }

  _refresh() {
    return PresetStore.refresh();
  }

  _useSnapshot(data) {
    this.state.folders = data.folders || [];
    this.state.presets = data.presets || [];
    this.state.settings = data.settings || {};
    const selected = this.state.selectedFolderId;
    if (selected && !["fav", "unfiled"].includes(selected) && !this.state.folders.some((folder) => folder.id === selected)) {
      this.state.selectedFolderId = null;
    }
    this._render();
  }

  // ---------- derived ----------
  _folderTree() {
    return buildFolderTree(this.state.folders);
  }

  _filtered() {
    return filterPresets(this.state.presets, this.state.folders, this.state);
  }

  // ---------- render ----------
  _render() {
    this._renderSidebar();
    this._renderList();
    this._syncToolbarOptions();
    this.statsEl.textContent = tr(
      `${this.state.presets.length} 个预设 · ${this.state.folders.length} 个文件夹`,
      `${this.state.presets.length} presets · ${this.state.folders.length} folders`,
    );
  }

  _renderList() {
    const root = this.listEl;
    root.innerHTML = "";
    const list = this._filtered();
    const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (this.state.currentPage > totalPages) this.state.currentPage = totalPages;
    const start = (this.state.currentPage - 1) * PAGE_SIZE;
    const page = list.slice(start, start + PAGE_SIZE);

    if (!page.length) {
      root.append(h("div", { class: "ppm-empty" }, [
        h("div", { class: "ppm-empty-icon" }, "—"),
        h("div", {}, tr("没有匹配的预设", "No Matching Presets")),
        h("div", { class: "ppm-empty-hint" }, tr("试试调整筛选条件或新建一个预设", "Adjust the filters or create a new preset")),
      ]));
    } else {
      for (const preset of page) root.append(this._renderPresetCard(preset, list));
    }

    // pager
    this.pagerEl.innerHTML = "";
    if (totalPages > 1) this.pagerEl.append(this._renderPager(totalPages));
  }

  _renderSidebar() {
    const root = this.sidebar;
    root.innerHTML = "";
    root.append(
      h("div", { class: "ppm-side-section" }, [
        h("div", { class: "ppm-side-title" }, tr("视图", "Views")),
        this._sideItem(tr("全部", "All"), null, this.state.presets.length, null),
        this._sideItem(tr("收藏", "Favorites"), "fav", this.state.presets.filter((p) => p.isFavorite).length, "★"),
        this._sideItem(tr("未分类", "Unfiled"), "unfiled", this.state.presets.filter((p) => !p.folderId).length, "○"),
      ])
    );

    const foldersSection = h("div", { class: "ppm-side-section ppm-folders" }, [
      h("div", { class: "ppm-side-title" }, [
        h("span", {}, tr("文件夹", "Folders")),
        h("button", { class: "ppm-mini-btn", title: tr("新建文件夹", "New folder"), onclick: () => this._openFolderEditor(null) }, "+"),
      ]),
      h("div", { class: "ppm-tree" }, this._renderTree(this._folderTree())),
      h("button", { class: "ppm-new-folder", onclick: () => this._openFolderEditor(null) }, `+ ${tr("新建文件夹", "New Folder")}`),
    ]);
    root.append(foldersSection);
  }

  _sideItem(label, id, count, icon) {
    const active = this.state.selectedFolderId === id || (id === null && this.state.selectedFolderId === null);
    return h("button", {
      class: "ppm-side-item" + (active ? " ppm-active" : ""),
      onclick: () => { this.state.selectedFolderId = id; this.state.currentPage = 1; this._render(); },
    }, [
      icon ? h("span", { class: "ppm-side-icon" }, icon) : null,
      h("span", { class: "ppm-side-name" }, label),
      h("span", { class: "ppm-side-count" }, String(count)),
    ]);
  }

  _renderTree(nodes) {
    return nodes.map((node) => this._renderTreeItem(node));
  }

  _renderTreeItem({ folder, children }) {
    const active = this.state.selectedFolderId === folder.id;
    const folderIds = collectFolderIds(this.state.folders, folder.id);
    const count = this.state.presets.filter((preset) => folderIds.has(preset.folderId)).length;
    const head = h("div", { class: "ppm-tree-head" + (active ? " ppm-active" : "") }, [
      h("span", { class: "ppm-tree-dot", style: { background: folder.color || DEFAULT_FOLDER_COLOR } }),
      h("span", { class: "ppm-tree-name", title: folder.name, onclick: () => { this.state.selectedFolderId = folder.id; this.state.currentPage = 1; this._render(); } }, folder.name),
      h("span", { class: "ppm-tree-count" }, String(count)),
      h("button", { class: "ppm-tree-edit", title: tr("编辑文件夹", "Edit folder"), onclick: (e) => { e.stopPropagation(); this._openFolderEditor(folder); } }, "✎"),
    ]);
    const wrap = h("div", { class: "ppm-tree-item" }, [head]);
    if (children && children.length) {
      const sub = h("div", { class: "ppm-tree-children" }, this._renderTree(children));
      wrap.append(sub);
    }
    return wrap;
  }

  _exportMenu() {
    const menu = h("div", { class: "ppm-menu" });
    this._menuEl = menu;
    const items = [
      { label: tr("导出全部预设", "Export All Presets"), icon: "↓", fn: () => this._exportAll() },
      { label: tr("导出当前文件夹", "Export Current Folder"), icon: "□", fn: () => this._exportFolder() },
      { label: tr("导出当前筛选结果", "Export Filtered Results"), icon: "≡", fn: () => this._exportFiltered() },
      { label: tr("从文件导入", "Import from File"), icon: "↑", fn: () => this._import() },
    ];
    const dropdown = h("div", { class: "ppm-menu-dropdown" },
      items.map((it) => h("button", { class: "ppm-menu-item", onclick: () => { menu.classList.remove("ppm-open"); it.fn(); } },
        [h("span", { class: "ppm-menu-icon" }, it.icon), h("span", {}, it.label)]))
    );
    menu.append(
      h("button", { class: "ppm-tool-btn", onclick: (e) => { e.stopPropagation(); menu.classList.toggle("ppm-open"); } },
        [h("span", { class: "ppm-tool-icon" }, "⋮"), h("span", { class: "ppm-tool-label" }, tr("导入/导出", "Import/Export"))])
    );
    menu.append(dropdown);
    return menu;
  }

  _renderPresetCard(preset, fullList) {
    const type = TYPE_MAP[preset.type] || TYPE_MAP.custom;
    const card = h("div", { class: "ppm-card" + (preset.isFavorite ? " ppm-fav" : ""), dataset: { id: preset.id } });

    const head = h("div", { class: "ppm-card-head" }, [
      h("span", { class: "ppm-badge", style: { background: type.color } }, type.label),
      h("span", { class: "ppm-card-name", title: preset.name }, preset.name),
      h("span", { class: "ppm-card-spacer" }),
      h("button", { class: "ppm-star" + (preset.isFavorite ? " ppm-star-on" : ""), title: tr("收藏", "Favorite"), onclick: () => this._toggleFav(preset) }, preset.isFavorite ? "★" : "☆"),
    ]);

    const desc = preset.description
      ? h("div", { class: "ppm-card-desc" }, preset.description)
      : null;
    const preview = preset.content
      ? h("div", { class: "ppm-card-content", title: preset.content }, this._preview(preset.content))
      : h("div", { class: "ppm-card-content ppm-mute" }, tr("（空内容）", "(Empty)"));

    const tags = (preset.tags && preset.tags.length)
      ? h("div", { class: "ppm-card-tags" }, preset.tags.map((t) => h("span", { class: "ppm-tag" }, t)))
      : null;

    const actions = h("div", { class: "ppm-card-actions" }, [
      h("button", { class: "ppm-btn ppm-btn-primary", title: tr("应用到当前节点", "Apply to current node"), onclick: () => this._apply(preset) }, tr("应用", "Apply")),
      h("button", { class: "ppm-btn", title: tr("编辑", "Edit"), onclick: () => this.openPresetEditor(preset) }, tr("编辑", "Edit")),
      h("button", { class: "ppm-btn", title: tr("复制内容到剪贴板", "Copy content to clipboard"), onclick: () => this._copy(preset) }, tr("复制", "Copy")),
      h("button", { class: "ppm-btn", title: tr("导出此预设", "Export this preset"), onclick: () => this._exportPreset(preset) }, tr("导出", "Export")),
      h("button", { class: "ppm-btn ppm-btn-danger", title: tr("删除", "Delete"), onclick: () => this._delete(preset) }, tr("删除", "Delete")),
    ]);

    card.append(...[head, desc, preview, tags, actions].filter(Boolean));

    // drag-to-reorder when in custom sort and a flat scope
    if (this.state.sortField === "custom") {
      card.draggable = true;
      card.addEventListener("dragstart", (e) => {
        this._dragId = preset.id;
        card.classList.add("ppm-dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", preset.id);
      });
      card.addEventListener("dragend", () => { card.classList.remove("ppm-dragging"); this._dragId = null; });
      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (!this._dragId || this._dragId === preset.id) return;
        const rect = card.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        card.classList.toggle("ppm-drop-before", !after);
        card.classList.toggle("ppm-drop-after", after);
      });
      card.addEventListener("dragleave", () => { card.classList.remove("ppm-drop-before", "ppm-drop-after"); });
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        card.classList.remove("ppm-drop-before", "ppm-drop-after");
        if (!this._dragId || this._dragId === preset.id) return;
        const rect = card.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        this._reorder(this._dragId, preset.id, after);
      });
    }
    return card;
  }

  _preview(text) {
    const one = String(text).replace(/\s+/g, " ").trim();
    return one.length > 160 ? one.slice(0, 160) + "…" : one;
  }

  _renderPager(totalPages) {
    const cur = this.state.currentPage;
    const btn = (label, page, disabled, active) =>
      h("button", { class: "ppm-page" + (active ? " ppm-active" : ""), disabled, onclick: () => { this.state.currentPage = page; this._renderList(); } }, label);
    const cells = [btn("‹", cur - 1, cur === 1, false)];
    const max = totalPages;
    const around = 2;
    for (let p = 1; p <= max; p++) {
      if (p === 1 || p === max || Math.abs(p - cur) <= around) {
        cells.push(btn(String(p), p, false, p === cur));
      } else if (cells[cells.length - 1] && cells[cells.length - 1].textContent !== "…") {
        cells.push(h("span", { class: "ppm-page-ellipsis" }, "…"));
      }
    }
    cells.push(btn("›", cur + 1, cur === totalPages, false));
    return h("div", { class: "ppm-pager" }, cells);
  }

  // ---------- actions ----------
  async _toggleFav(preset) {
    try { await PresetStore.mutate(() => PresetAPI.toggleFavorite(preset.id)); }
    catch (e) { toast(e.message, "error"); }
  }

  _apply(preset) {
    if (this.onSelect) this.onSelect(this.sourceNode, preset);
    toast(`${tr("已应用", "Applied")} “${preset.name}”`, "success");
  }

  async _copy(preset) {
    try {
      await navigator.clipboard.writeText(preset.content || "");
      toast(tr("内容已复制", "Content copied"), "success");
    } catch { toast(tr("复制失败", "Copy failed"), "error"); }
  }

  async _delete(preset) {
    if (!confirm(tr(
      `确定删除预设“${preset.name}”吗？此操作不可撤销。`,
      `Delete preset “${preset.name}”? This cannot be undone.`,
    ))) return;
    try { await PresetStore.mutate(() => PresetAPI.deletePreset(preset.id)); toast(tr("已删除", "Deleted"), "success"); }
    catch (e) { toast(e.message, "error"); }
  }

  async _reorder(draggedId, targetId, after) {
    const list = this._filtered();
    const ids = list.map((p) => p.id);
    const from = ids.indexOf(draggedId);
    if (from < 0) return;
    const [moved] = ids.splice(from, 1);
    let to = ids.indexOf(targetId);
    if (to < 0) return;
    if (after) to += 1;
    ids.splice(to, 0, moved);
    try { await PresetStore.mutate(() => PresetAPI.reorderPresets(ids)); }
    catch (e) { toast(e.message, "error"); }
  }

  // ---------- editor dialog ----------
  _buildPresetDialog() {
    const root = h("div", { class: "ppm-dialog-overlay" });
    const dialog = h("div", { class: "ppm-dialog" });
    const form = h("div", { class: "ppm-form" });
    const close = () => {
      root.classList.remove("ppm-open");
      this._editingPreset = null;
      this._editorOnSaved = null;
    };
    this._presetForm = {
      name: h("input", { class: "ppm-input", type: "text", placeholder: tr("预设名称", "Preset name") }),
      type: h("select", { class: "ppm-select" }, PRESET_TYPES.map((t) => h("option", { value: t.value }, t.label))),
      folder: h("select", { class: "ppm-select" }),
      content: h("textarea", { class: "ppm-input ppm-textarea", placeholder: tr("提示词内容…", "Prompt content…"), rows: 8 }),
      description: h("input", { class: "ppm-input", type: "text", placeholder: tr("描述（可选）", "Description (optional)") }),
      tags: h("input", { class: "ppm-input", type: "text", placeholder: tr("标签，逗号分隔", "Tags, separated by commas") }),
    };
    this._presetDialogTitle = h("span", { class: "ppm-dialog-title" }, tr("新建预设", "New Preset"));
    form.append(
      h("div", { class: "ppm-dialog-head" }, [
        this._presetDialogTitle,
        h("button", { class: "ppm-icon-btn", title: tr("关闭", "Close"), onclick: close }, "×"),
      ]),
      h("div", { class: "ppm-field" }, [h("label", {}, tr("名称", "Name")), this._presetForm.name]),
      h("div", { class: "ppm-grid-2" }, [
        h("div", { class: "ppm-field" }, [h("label", {}, tr("类型", "Type")), this._presetForm.type]),
        h("div", { class: "ppm-field" }, [h("label", {}, tr("文件夹", "Folder")), this._presetForm.folder]),
      ]),
      h("div", { class: "ppm-field" }, [h("label", {}, tr("内容", "Content")), this._presetForm.content]),
      h("div", { class: "ppm-grid-2" }, [
        h("div", { class: "ppm-field" }, [h("label", {}, tr("描述", "Description")), this._presetForm.description]),
        h("div", { class: "ppm-field" }, [h("label", {}, tr("标签", "Tags")), this._presetForm.tags]),
      ]),
      h("div", { class: "ppm-dialog-foot" }, [
        h("button", { class: "ppm-btn", onclick: close }, tr("取消", "Cancel")),
        h("button", { class: "ppm-btn ppm-btn-primary", onclick: () => this._savePreset(close) }, tr("保存", "Save")),
      ]),
    );
    dialog.append(form);
    root.append(dialog);
    root.addEventListener("mousedown", (e) => { if (e.target === root) close(); });
    return { root, close };
  }

  openPresetEditor(preset, options = {}) {
    const f = this._presetForm;
    const initial = options.initialDraft || preset || {};
    this._applyOnCreate = Boolean(options.applyOnCreate);
    this._editorOnSaved = typeof options.onSaved === "function" ? options.onSaved : null;
    this._presetDialogTitle.textContent = preset ? tr("编辑预设", "Edit Preset") : tr("新建预设", "New Preset");
    f.name.value = initial.name || "";
    f.type.value = initial.type || "positive";
    f.content.value = initial.content || "";
    f.description.value = initial.description || "";
    f.tags.value = Array.isArray(initial.tags) ? initial.tags.join(", ") : (initial.tags || "");
    // refresh folder options
    f.folder.innerHTML = "";
    f.folder.append(h("option", { value: "" }, tr("未分类", "Unfiled")));
    const walk = (nodes, depth) => {
      for (const { folder, children } of nodes) {
        const opt = h("option", { value: folder.id }, "  ".repeat(depth) + folder.name);
        if (initial.folderId === folder.id) opt.selected = true;
        f.folder.append(opt);
        if (children) walk(children, depth + 1);
      }
    };
    walk(this._folderTree(), 0);
    this._editingPreset = preset;
    this.presetDialog.root.classList.add("ppm-open");
    setTimeout(() => f.name.focus(), 50);
  }

  _openPresetEditor(preset) {
    this.openPresetEditor(preset);
  }

  async _savePreset(close) {
    const f = this._presetForm;
    const name = f.name.value.trim();
    if (!name) { toast(tr("请填写名称", "Enter a name"), "error"); return; }
    const tags = f.tags.value.split(",").map((t) => t.trim()).filter(Boolean);
    const payload = {
      name,
      type: f.type.value,
      content: f.content.value,
      description: f.description.value,
      tags,
      folderId: f.folder.value || null,
    };
    try {
      const onSaved = this._editorOnSaved;
      let saved;
      if (this._editingPreset) {
        saved = await PresetStore.mutate(() => PresetAPI.savePreset({ ...payload, id: this._editingPreset.id }));
        toast(tr("已更新", "Updated"), "success");
      } else {
        saved = await PresetStore.mutate(() => PresetAPI.savePreset(payload));
        toast(tr("已创建", "Created"), "success");
        if (this._applyOnCreate && this.onSelect) this.onSelect(this.sourceNode, saved);
      }
      if (onSaved) onSaved(saved);
      close();
    } catch (e) { toast(e.message, "error"); }
  }

  // ---------- folder dialog ----------
  _buildFolderDialog() {
    const root = h("div", { class: "ppm-dialog-overlay" });
    const dialog = h("div", { class: "ppm-dialog ppm-dialog-sm" });
    const close = () => { root.classList.remove("ppm-open"); this._editingFolder = null; };
    this._folderForm = {
      name: h("input", { class: "ppm-input", type: "text", placeholder: tr("文件夹名称", "Folder name") }),
      parent: h("select", { class: "ppm-select" }),
      color: h("input", { class: "ppm-color", type: "color", value: DEFAULT_FOLDER_COLOR }),
      description: h("input", { class: "ppm-input", type: "text", placeholder: tr("描述（可选）", "Description (optional)") }),
    };
    this._folderDialogTitle = h("span", { class: "ppm-dialog-title" }, tr("新建文件夹", "New Folder"));
    this._folderDeleteButton = h("button", { class: "ppm-btn ppm-btn-danger ppm-hidden", onclick: () => this._deleteFolder(close) }, tr("删除文件夹", "Delete Folder"));
    dialog.append(
      h("div", { class: "ppm-form" }, [
        h("div", { class: "ppm-dialog-head" }, [
          this._folderDialogTitle,
          h("button", { class: "ppm-icon-btn", title: tr("关闭", "Close"), onclick: close }, "×"),
        ]),
        h("div", { class: "ppm-field" }, [h("label", {}, tr("名称", "Name")), this._folderForm.name]),
        h("div", { class: "ppm-grid-2" }, [
          h("div", { class: "ppm-field" }, [h("label", {}, tr("颜色", "Color")), this._folderForm.color]),
          h("div", { class: "ppm-field" }, [h("label", {}, tr("父文件夹", "Parent Folder")), this._folderForm.parent]),
        ]),
        h("div", { class: "ppm-field" }, [h("label", {}, tr("描述", "Description")), this._folderForm.description]),
        h("div", { class: "ppm-dialog-foot" }, [
          this._folderDeleteButton,
          h("span", { class: "ppm-dialog-spacer" }),
          h("button", { class: "ppm-btn", onclick: close }, tr("取消", "Cancel")),
          h("button", { class: "ppm-btn ppm-btn-primary", onclick: () => this._saveFolder(close) }, tr("保存", "Save")),
        ]),
      ])
    );
    root.append(dialog);
    root.addEventListener("mousedown", (e) => { if (e.target === root) close(); });
    return { root, close };
  }

  _openFolderEditor(folder) {
    const f = this._folderForm;
    f.name.value = folder ? folder.name : "";
    f.color.value = folder ? (folder.color || DEFAULT_FOLDER_COLOR) : DEFAULT_FOLDER_COLOR;
    f.description.value = folder ? folder.description || "" : "";
    f.parent.innerHTML = "";
    f.parent.append(h("option", { value: "" }, tr("（无）", "(None)")));
    const walk = (nodes, depth, excludeId) => {
      for (const { folder: fld, children } of nodes) {
        if (fld.id === excludeId) continue;
        f.parent.append(h("option", { value: fld.id, selected: folder && folder.parentId === fld.id }, "  ".repeat(depth) + fld.name));
        if (children) walk(children, depth + 1, excludeId);
      }
    };
    walk(this._folderTree(), 0, folder ? folder.id : null);
    this._editingFolder = folder;
    this._folderDialogTitle.textContent = folder ? tr("编辑文件夹", "Edit Folder") : tr("新建文件夹", "New Folder");
    this._folderDeleteButton.classList.toggle("ppm-hidden", !folder);
    this.folderDialog.root.classList.add("ppm-open");
    setTimeout(() => f.name.focus(), 50);
  }

  async _saveFolder(close) {
    const f = this._folderForm;
    const name = f.name.value.trim();
    if (!name) { toast(tr("请填写文件夹名称", "Enter a folder name"), "error"); return; }
    const payload = { name, color: f.color.value, description: f.description.value, parentId: f.parent.value || null };
    try {
      if (this._editingFolder) await PresetStore.mutate(() => PresetAPI.saveFolder({ ...payload, id: this._editingFolder.id }));
      else await PresetStore.mutate(() => PresetAPI.saveFolder(payload));
      close();
      toast(tr("已保存", "Saved"), "success");
    } catch (e) { toast(e.message, "error"); }
  }

  async _deleteFolder(close) {
    const folder = this._editingFolder;
    if (!folder || !confirm(tr(
      `确定删除文件夹“${folder.name}”吗？其中的预设会移到未分类。`,
      `Delete folder “${folder.name}”? Its presets will be moved to Unfiled.`,
    ))) return;
    try {
      await PresetStore.mutate(() => PresetAPI.deleteFolder(folder.id));
      close();
      toast(tr("文件夹已删除", "Folder deleted"), "success");
    } catch (e) { toast(e.message, "error"); }
  }

  // ---------- import / export ----------
  async _exportAll() {
    try {
      const bundle = await PresetAPI.exportAll();
      downloadJson(`presets_all.json`, bundle);
      const count = bundle.extendedPresets?.length || 0;
      toast(tr(`已导出 ${count} 个预设`, `Exported ${count} presets`), "success");
    } catch (e) { toast(e.message, "error"); }
  }

  async _exportFolder() {
    const id = this.state.selectedFolderId;
    if (!id || id === "fav" || id === "unfiled") {
      toast(tr("请先在左侧选择一个文件夹", "Select a folder in the sidebar first"), "info");
      return;
    }
    try {
      const bundle = await PresetAPI.exportFolder(id);
      const folder = this.state.folders.find((f) => f.id === id);
      downloadJson(`presets_${sanitizeFilename(folder?.name || "folder")}.json`, bundle);
      const count = bundle.extendedPresets?.length || 0;
      toast(tr(`已导出 ${count} 个预设`, `Exported ${count} presets`), "success");
    } catch (e) { toast(e.message, "error"); }
  }

  async _exportPreset(preset) {
    try {
      const bundle = await PresetAPI.exportPreset(preset.id);
      downloadJson(`preset_${sanitizeFilename(preset.name)}.json`, bundle);
      toast(tr("已导出", "Exported"), "success");
    } catch (e) { toast(e.message, "error"); }
  }

  async _exportFiltered() {
    const list = this._filtered();
    if (!list.length) { toast(tr("没有可导出的预设", "No presets to export"), "info"); return; }
    try {
      const bundle = await PresetAPI.exportSelection(list.map((preset) => preset.id));
      downloadJson("presets_filtered.json", bundle);
      toast(tr(`已导出 ${list.length} 个预设`, `Exported ${list.length} presets`), "success");
    } catch (e) { toast(e.message, "error"); }
  }

  _import() {
    const input = h("input", { type: "file", accept: ".json,application/json" });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const result = await PresetStore.mutate(() => PresetAPI.importFile(file));
        toast(tr(
          `导入完成：新增 ${result.added}，更新 ${result.updated}`,
          `Import complete: ${result.added} added, ${result.updated} updated`,
        ), "success");
      } catch (e) { toast(`${tr("导入失败", "Import failed")}: ${e.message}`, "error"); }
    });
    input.click();
  }
}
