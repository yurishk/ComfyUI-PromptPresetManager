// Full preset manager modal. One shared instance is created lazily and reused
// across nodes. Builds the entire UI with vanilla DOM so it works inside the
// ComfyUI extension sandbox without any build step.

import { PresetAPI, PresetStore, PRESET_TYPES, TYPE_MAP, DEFAULT_FOLDER_COLOR, downloadJson, sanitizeFilename } from "./preset_api.mjs";
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
      h("span", {}, "预设管理器"),
    ]);
    const stats = h("span", { class: "ppm-stats" }, "");
    this.statsEl = stats;
    const actions = h("div", { class: "ppm-header-actions" }, [
      h("button", { class: "ppm-icon-btn ppm-close", title: "关闭", onclick: () => this.close() }, "×"),
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
      class: "ppm-search", type: "text", placeholder: "搜索名称 / 内容 / 标签…",
      value: s.searchQuery,
      oninput: (e) => { s.searchQuery = e.target.value; s.currentPage = 1; this._renderList(); },
    });
    this.searchInput = search;
    const typeSelect = h("select", { class: "ppm-select", onchange: (e) => { s.selectedType = e.target.value; s.currentPage = 1; this._renderList(); } },
      [{ value: "all", label: "所有类型" }, ...PRESET_TYPES].map((t) =>
        h("option", { value: t.value, selected: t.value === s.selectedType }, t.label))
    );
    this.typeSelect = typeSelect;
    const sortSelect = h("select", { class: "ppm-select", onchange: (e) => { s.sortField = e.target.value; s.currentPage = 1; this._renderList(); } },
      [["custom", "自定义排序"], ["name", "按名称"], ["updatedAt", "按时间"]].map(([v, l]) =>
        h("option", { value: v, selected: v === s.sortField }, l))
    );
    this.sortSelect = sortSelect;
    const dirBtn = h("button", { class: "ppm-sort-dir", title: "切换排序方向", onclick: () => { s.sortDir = s.sortDir === "asc" ? "desc" : "asc"; this._renderList(); } }, s.sortDir === "asc" ? "↑" : "↓");
    this.sortDirBtn = dirBtn;
    const newBtn = h("button", { class: "ppm-new-preset", onclick: () => this.openPresetEditor(null) }, [h("span", {}, "+"), h("span", {}, "新建预设")]);
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
      toast("加载预设失败: " + e.message, "error");
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
    this.statsEl.textContent = `${this.state.presets.length} 个预设 · ${this.state.folders.length} 个文件夹`;
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
        h("div", {}, "没有匹配的预设"),
        h("div", { class: "ppm-empty-hint" }, "试试调整筛选条件或新建一个预设"),
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
        h("div", { class: "ppm-side-title" }, "视图"),
        this._sideItem("全部", null, this.state.presets.length, null),
        this._sideItem("收藏", "fav", this.state.presets.filter((p) => p.isFavorite).length, "★"),
        this._sideItem("未分类", "unfiled", this.state.presets.filter((p) => !p.folderId).length, "○"),
      ])
    );

    const foldersSection = h("div", { class: "ppm-side-section ppm-folders" }, [
      h("div", { class: "ppm-side-title" }, [
        h("span", {}, "文件夹"),
        h("button", { class: "ppm-mini-btn", title: "新建文件夹", onclick: () => this._openFolderEditor(null) }, "+"),
      ]),
      h("div", { class: "ppm-tree" }, this._renderTree(this._folderTree())),
      h("button", { class: "ppm-new-folder", onclick: () => this._openFolderEditor(null) }, "+ 新建文件夹"),
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
      h("button", { class: "ppm-tree-edit", title: "编辑文件夹", onclick: (e) => { e.stopPropagation(); this._openFolderEditor(folder); } }, "✎"),
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
      { label: "导出全部预设", icon: "↓", fn: () => this._exportAll() },
      { label: "导出当前文件夹", icon: "□", fn: () => this._exportFolder() },
      { label: "导出当前筛选结果", icon: "≡", fn: () => this._exportFiltered() },
      { label: "从文件导入", icon: "↑", fn: () => this._import() },
    ];
    const dropdown = h("div", { class: "ppm-menu-dropdown" },
      items.map((it) => h("button", { class: "ppm-menu-item", onclick: () => { menu.classList.remove("ppm-open"); it.fn(); } },
        [h("span", { class: "ppm-menu-icon" }, it.icon), h("span", {}, it.label)]))
    );
    menu.append(
      h("button", { class: "ppm-tool-btn", onclick: (e) => { e.stopPropagation(); menu.classList.toggle("ppm-open"); } },
        [h("span", { class: "ppm-tool-icon" }, "⋮"), h("span", { class: "ppm-tool-label" }, "导入/导出")])
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
      h("button", { class: "ppm-star" + (preset.isFavorite ? " ppm-star-on" : ""), title: "收藏", onclick: () => this._toggleFav(preset) }, preset.isFavorite ? "★" : "☆"),
    ]);

    const desc = preset.description
      ? h("div", { class: "ppm-card-desc" }, preset.description)
      : null;
    const preview = preset.content
      ? h("div", { class: "ppm-card-content", title: preset.content }, this._preview(preset.content))
      : h("div", { class: "ppm-card-content ppm-mute" }, "（空内容）");

    const tags = (preset.tags && preset.tags.length)
      ? h("div", { class: "ppm-card-tags" }, preset.tags.map((t) => h("span", { class: "ppm-tag" }, t)))
      : null;

    const actions = h("div", { class: "ppm-card-actions" }, [
      h("button", { class: "ppm-btn ppm-btn-primary", title: "应用到当前节点", onclick: () => this._apply(preset) }, "应用"),
      h("button", { class: "ppm-btn", title: "编辑", onclick: () => this.openPresetEditor(preset) }, "编辑"),
      h("button", { class: "ppm-btn", title: "复制内容到剪贴板", onclick: () => this._copy(preset) }, "复制"),
      h("button", { class: "ppm-btn", title: "导出此预设", onclick: () => this._exportPreset(preset) }, "导出"),
      h("button", { class: "ppm-btn ppm-btn-danger", title: "删除", onclick: () => this._delete(preset) }, "删除"),
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
    toast(`已应用「${preset.name}」`, "success");
  }

  async _copy(preset) {
    try {
      await navigator.clipboard.writeText(preset.content || "");
      toast("内容已复制", "success");
    } catch { toast("复制失败", "error"); }
  }

  async _delete(preset) {
    if (!confirm(`确定删除预设「${preset.name}」吗？此操作不可撤销。`)) return;
    try { await PresetStore.mutate(() => PresetAPI.deletePreset(preset.id)); toast("已删除", "success"); }
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
    const close = () => { root.classList.remove("ppm-open"); this._editingPreset = null; };
    this._presetForm = {
      name: h("input", { class: "ppm-input", type: "text", placeholder: "预设名称" }),
      type: h("select", { class: "ppm-select" }, PRESET_TYPES.map((t) => h("option", { value: t.value }, t.label))),
      folder: h("select", { class: "ppm-select" }),
      content: h("textarea", { class: "ppm-input ppm-textarea", placeholder: "提示词内容…", rows: 8 }),
      description: h("input", { class: "ppm-input", type: "text", placeholder: "描述（可选）" }),
      tags: h("input", { class: "ppm-input", type: "text", placeholder: "标签，逗号分隔" }),
    };
    this._presetDialogTitle = h("span", { class: "ppm-dialog-title" }, "新建预设");
    form.append(
      h("div", { class: "ppm-dialog-head" }, [
        this._presetDialogTitle,
        h("button", { class: "ppm-icon-btn", title: "关闭", onclick: close }, "×"),
      ]),
      h("div", { class: "ppm-field" }, [h("label", {}, "名称"), this._presetForm.name]),
      h("div", { class: "ppm-grid-2" }, [
        h("div", { class: "ppm-field" }, [h("label", {}, "类型"), this._presetForm.type]),
        h("div", { class: "ppm-field" }, [h("label", {}, "文件夹"), this._presetForm.folder]),
      ]),
      h("div", { class: "ppm-field" }, [h("label", {}, "内容"), this._presetForm.content]),
      h("div", { class: "ppm-grid-2" }, [
        h("div", { class: "ppm-field" }, [h("label", {}, "描述"), this._presetForm.description]),
        h("div", { class: "ppm-field" }, [h("label", {}, "标签"), this._presetForm.tags]),
      ]),
      h("div", { class: "ppm-dialog-foot" }, [
        h("button", { class: "ppm-btn", onclick: close }, "取消"),
        h("button", { class: "ppm-btn ppm-btn-primary", onclick: () => this._savePreset(close) }, "保存"),
      ]),
    );
    dialog.append(form);
    root.append(dialog);
    root.addEventListener("mousedown", (e) => { if (e.target === root) close(); });
    return { root, close };
  }

  openPresetEditor(preset, options = {}) {
    const f = this._presetForm;
    this._applyOnCreate = Boolean(options.applyOnCreate);
    this._presetDialogTitle.textContent = preset ? "编辑预设" : "新建预设";
    f.name.value = preset ? preset.name : "";
    f.type.value = preset ? preset.type : "positive";
    f.content.value = preset ? preset.content || "" : "";
    f.description.value = preset ? preset.description || "" : "";
    f.tags.value = preset ? (preset.tags || []).join(", ") : "";
    // refresh folder options
    f.folder.innerHTML = "";
    f.folder.append(h("option", { value: "" }, "未分类"));
    const walk = (nodes, depth) => {
      for (const { folder, children } of nodes) {
        const opt = h("option", { value: folder.id }, "  ".repeat(depth) + folder.name);
        if (preset && preset.folderId === folder.id) opt.selected = true;
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
    if (!name) { toast("请填写名称", "error"); return; }
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
      if (this._editingPreset) {
        await PresetStore.mutate(() => PresetAPI.savePreset({ ...payload, id: this._editingPreset.id }));
        toast("已更新", "success");
      } else {
        const created = await PresetStore.mutate(() => PresetAPI.savePreset(payload));
        toast("已创建", "success");
        if (this._applyOnCreate && this.onSelect) this.onSelect(this.sourceNode, created);
      }
      close();
    } catch (e) { toast(e.message, "error"); }
  }

  // ---------- folder dialog ----------
  _buildFolderDialog() {
    const root = h("div", { class: "ppm-dialog-overlay" });
    const dialog = h("div", { class: "ppm-dialog ppm-dialog-sm" });
    const close = () => { root.classList.remove("ppm-open"); this._editingFolder = null; };
    this._folderForm = {
      name: h("input", { class: "ppm-input", type: "text", placeholder: "文件夹名称" }),
      parent: h("select", { class: "ppm-select" }),
      color: h("input", { class: "ppm-color", type: "color", value: DEFAULT_FOLDER_COLOR }),
      description: h("input", { class: "ppm-input", type: "text", placeholder: "描述（可选）" }),
    };
    this._folderDialogTitle = h("span", { class: "ppm-dialog-title" }, "新建文件夹");
    this._folderDeleteButton = h("button", { class: "ppm-btn ppm-btn-danger ppm-hidden", onclick: () => this._deleteFolder(close) }, "删除文件夹");
    dialog.append(
      h("div", { class: "ppm-form" }, [
        h("div", { class: "ppm-dialog-head" }, [
          this._folderDialogTitle,
          h("button", { class: "ppm-icon-btn", title: "关闭", onclick: close }, "×"),
        ]),
        h("div", { class: "ppm-field" }, [h("label", {}, "名称"), this._folderForm.name]),
        h("div", { class: "ppm-grid-2" }, [
          h("div", { class: "ppm-field" }, [h("label", {}, "颜色"), this._folderForm.color]),
          h("div", { class: "ppm-field" }, [h("label", {}, "父文件夹"), this._folderForm.parent]),
        ]),
        h("div", { class: "ppm-field" }, [h("label", {}, "描述"), this._folderForm.description]),
        h("div", { class: "ppm-dialog-foot" }, [
          this._folderDeleteButton,
          h("span", { class: "ppm-dialog-spacer" }),
          h("button", { class: "ppm-btn", onclick: close }, "取消"),
          h("button", { class: "ppm-btn ppm-btn-primary", onclick: () => this._saveFolder(close) }, "保存"),
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
    f.parent.append(h("option", { value: "" }, "（无）"));
    const walk = (nodes, depth, excludeId) => {
      for (const { folder: fld, children } of nodes) {
        if (fld.id === excludeId) continue;
        f.parent.append(h("option", { value: fld.id, selected: folder && folder.parentId === fld.id }, "  ".repeat(depth) + fld.name));
        if (children) walk(children, depth + 1, excludeId);
      }
    };
    walk(this._folderTree(), 0, folder ? folder.id : null);
    this._editingFolder = folder;
    this._folderDialogTitle.textContent = folder ? "编辑文件夹" : "新建文件夹";
    this._folderDeleteButton.classList.toggle("ppm-hidden", !folder);
    this.folderDialog.root.classList.add("ppm-open");
    setTimeout(() => f.name.focus(), 50);
  }

  async _saveFolder(close) {
    const f = this._folderForm;
    const name = f.name.value.trim();
    if (!name) { toast("请填写文件夹名称", "error"); return; }
    const payload = { name, color: f.color.value, description: f.description.value, parentId: f.parent.value || null };
    try {
      if (this._editingFolder) await PresetStore.mutate(() => PresetAPI.saveFolder({ ...payload, id: this._editingFolder.id }));
      else await PresetStore.mutate(() => PresetAPI.saveFolder(payload));
      close();
      toast("已保存", "success");
    } catch (e) { toast(e.message, "error"); }
  }

  async _deleteFolder(close) {
    const folder = this._editingFolder;
    if (!folder || !confirm(`确定删除文件夹「${folder.name}」吗？其中的预设会移到未分类。`)) return;
    try {
      await PresetStore.mutate(() => PresetAPI.deleteFolder(folder.id));
      close();
      toast("文件夹已删除", "success");
    } catch (e) { toast(e.message, "error"); }
  }

  // ---------- import / export ----------
  async _exportAll() {
    try {
      const bundle = await PresetAPI.exportAll();
      downloadJson(`presets_all.json`, bundle);
      toast(`已导出 ${bundle.extendedPresets?.length || 0} 个预设`, "success");
    } catch (e) { toast(e.message, "error"); }
  }

  async _exportFolder() {
    const id = this.state.selectedFolderId;
    if (!id || id === "fav" || id === "unfiled") {
      toast("请先在左侧选择一个文件夹", "info");
      return;
    }
    try {
      const bundle = await PresetAPI.exportFolder(id);
      const folder = this.state.folders.find((f) => f.id === id);
      downloadJson(`presets_${sanitizeFilename(folder?.name || "folder")}.json`, bundle);
      toast(`已导出 ${bundle.extendedPresets?.length || 0} 个预设`, "success");
    } catch (e) { toast(e.message, "error"); }
  }

  async _exportPreset(preset) {
    try {
      const bundle = await PresetAPI.exportPreset(preset.id);
      downloadJson(`preset_${sanitizeFilename(preset.name)}.json`, bundle);
      toast("已导出", "success");
    } catch (e) { toast(e.message, "error"); }
  }

  async _exportFiltered() {
    const list = this._filtered();
    if (!list.length) { toast("没有可导出的预设", "info"); return; }
    try {
      const bundle = await PresetAPI.exportSelection(list.map((preset) => preset.id));
      downloadJson("presets_filtered.json", bundle);
      toast(`已导出 ${list.length} 个预设`, "success");
    } catch (e) { toast(e.message, "error"); }
  }

  _import() {
    const input = h("input", { type: "file", accept: ".json,application/json" });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const result = await PresetStore.mutate(() => PresetAPI.importFile(file));
        toast(`导入完成：新增 ${result.added}，更新 ${result.updated}`, "success");
      } catch (e) { toast("导入失败: " + e.message, "error"); }
    });
    input.click();
  }
}
