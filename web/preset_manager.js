import { app } from "../../scripts/app.js";
import { PRESET_TYPES, PresetAPI, PresetStore, TYPE_MAP } from "./preset_api.mjs";
import { draftMetadata, isDraftDirty, migrateNodeState, payloadFromDraft, variantName } from "./preset_draft.mjs";
import { buildFolderTree } from "./preset_model.mjs";
import { getPresetManager } from "./preset_modal.mjs";

const NODE_NAME = "PromptPresetManager";
const PROMPT_WIDGET = "prompt_text";
const PROPERTY_ID = "promptPresetId";
const PROPERTY_DIRTY = "promptPresetDirty";
const PROPERTY_REVISION = "promptPresetRevision";
const PROPERTY_SCHEMA = "promptPresetSchema";
const PROPERTY_DRAFT = "promptPresetDraft";

function ensureStyles() {
  if (document.getElementById("prompt-preset-manager-css")) return;
  const link = document.createElement("link");
  link.id = "prompt-preset-manager-css";
  link.rel = "stylesheet";
  link.href = new URL("./preset_manager.css", import.meta.url).href;
  document.head.append(link);
}

function element(tag, className = "", children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null || child === false) continue;
    node.append(child?.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function widgetFor(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function selectedId(node) {
  return String(node.properties?.[PROPERTY_ID] || "");
}

function syncSelectionId(node, preferredId) {
  const id = String(preferredId ?? selectedId(node) ?? "");
  node.properties ||= {};
  node.properties[PROPERTY_ID] = id;
  return id;
}

function setWidgetValue(node, name, value, notify = true) {
  const widget = widgetFor(node, name);
  if (!widget || widget.value === value) return;
  widget.value = value;
  if (notify) widget.callback?.(value);
}

function moveWidgetAfter(node, widget, anchor) {
  if (!widget || !anchor || widget === anchor || !Array.isArray(node.widgets)) return;
  const widgetIndex = node.widgets.indexOf(widget);
  if (widgetIndex < 0) return;
  node.widgets.splice(widgetIndex, 1);
  const anchorIndex = node.widgets.indexOf(anchor);
  node.widgets.splice(anchorIndex < 0 ? node.widgets.length : anchorIndex + 1, 0, widget);
}

function applyPresetToNode(node, preset) {
  node._ppmApplyPreset?.(preset);
}

function openManager(node) {
  getPresetManager().open(node, (sourceNode, preset) => applyPresetToNode(sourceNode, preset));
}

function buildQuickSelect(node, context) {
  const wrapper = element("div", "ppm-qs");
  const input = element("input", "ppm-qs-input");
  input.type = "search";
  input.placeholder = "搜索并载入预设";
  input.autocomplete = "off";
  const list = element("div", "ppm-qs-list");

  function close() {
    list.classList.remove("ppm-qs-open");
  }

  function render() {
    list.replaceChildren();
    const query = input.value.trim().toLocaleLowerCase();
    const matches = context.presets
      .filter((preset) => !query || [preset.name, preset.content, preset.description, ...(preset.tags || [])]
        .some((value) => String(value || "").toLocaleLowerCase().includes(query)))
      .slice(0, 60);
    if (!matches.length) {
      list.append(element("div", "ppm-qs-empty", "没有匹配的预设"));
      return;
    }
    for (const preset of matches) {
      const type = TYPE_MAP[preset.type] || TYPE_MAP.custom;
      const badge = element("span", "ppm-badge ppm-badge-sm", type.label);
      badge.style.background = type.color;
      const item = element("button", "ppm-qs-item", [
        element("span", "ppm-qs-name", preset.name || "未命名预设"),
        badge,
      ]);
      item.type = "button";
      item.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        applyPresetToNode(node, preset);
        input.value = "";
        close();
      });
      list.append(item);
    }
  }

  input.addEventListener("focus", () => { render(); list.classList.add("ppm-qs-open"); });
  input.addEventListener("input", render);
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") input.blur();
    if (event.key === "Enter") list.querySelector(".ppm-qs-item")?.dispatchEvent(new PointerEvent("pointerdown"));
  });
  wrapper.append(input, list);
  return wrapper;
}

function fillFolderOptions(select, folders, selected) {
  select.replaceChildren(element("option", "", "未分类"));
  select.options[0].value = "";
  const walk = (nodes, depth) => {
    for (const { folder, children } of nodes) {
      const option = element("option", "", `${"  ".repeat(depth)}${folder.name}`);
      option.value = folder.id;
      select.append(option);
      walk(children || [], depth + 1);
    }
  };
  walk(buildFolderTree(folders), 0);
  select.value = selected || "";
}

function buildPanel(node) {
  if (node._ppmPanelBuilt) return;
  node._ppmPanelBuilt = true;
  node.serialize_widgets = true;
  node.properties ||= {};
  node.properties[PROPERTY_DIRTY] = Boolean(node.properties[PROPERTY_DIRTY]);
  syncSelectionId(node);

  const promptWidget = widgetFor(node, PROMPT_WIDGET);
  if (promptWidget) promptWidget.label = "提示词内容";

  const context = { folders: [], presets: [], loaded: false };
  const root = element("div", "ppm-panel ppm-quick-editor");
  const libraryButton = element("button", "ppm-link-btn", "管理预设库");
  libraryButton.type = "button";
  libraryButton.addEventListener("click", () => openManager(node));
  const header = element("div", "ppm-panel-header", [
    element("div", "ppm-panel-heading", [
      element("span", "ppm-panel-title", "预设快速编辑"),
      element("span", "ppm-panel-shared", "全局共享"),
    ]),
    libraryButton,
  ]);

  const badge = element("span", "ppm-badge ppm-hidden");
  const selectionName = element("span", "ppm-sel-name", "本地草稿");
  const syncState = element("span", "ppm-sync-state", "未选择");
  const favorite = element("button", "ppm-star", "☆");
  favorite.type = "button";
  favorite.title = "收藏或取消收藏";
  const detach = element("button", "ppm-icon-btn ppm-detach", "×");
  detach.type = "button";
  detach.title = "解除预设关联并保留当前内容";
  const selection = element("div", "ppm-sel", [badge, selectionName, syncState, favorite, detach]);
  const quickSelect = buildQuickSelect(node, context);

  const nameInput = element("input", "ppm-meta-input ppm-name-input");
  nameInput.type = "text";
  nameInput.placeholder = "预设名称";
  const typeSelect = element("select", "ppm-meta-select");
  for (const type of PRESET_TYPES) {
    const option = element("option", "", type.label);
    option.value = type.value;
    typeSelect.append(option);
  }
  const primaryFields = element("div", "ppm-primary-fields", [nameInput, typeSelect]);

  const folderSelect = element("select", "ppm-meta-select ppm-folder-select");
  const tagsInput = element("input", "ppm-meta-input");
  tagsInput.type = "text";
  tagsInput.placeholder = "标签，逗号分隔";
  const descriptionInput = element("input", "ppm-meta-input");
  descriptionInput.type = "text";
  descriptionInput.placeholder = "描述（可选）";
  const moreFields = element("div", "ppm-more-fields ppm-hidden", [
    element("label", "ppm-compact-field", [element("span", "", "文件夹"), folderSelect]),
    element("label", "ppm-compact-field", [element("span", "", "标签"), tagsInput]),
    element("label", "ppm-compact-field ppm-field-wide", [element("span", "", "描述"), descriptionInput]),
  ]);
  const moreButton = element("button", "ppm-more-btn", "更多 ▾");
  moreButton.type = "button";
  moreButton.addEventListener("click", () => {
    const open = moreFields.classList.toggle("ppm-hidden") === false;
    moreButton.textContent = open ? "收起 ▴" : "更多 ▾";
    requestAnimationFrame(() => requestAnimationFrame(fitNode));
  });

  const saveButton = element("button", "ppm-btn ppm-btn-primary", "新增预设");
  saveButton.type = "button";
  const variantButton = element("button", "ppm-btn", "另存变体");
  variantButton.type = "button";
  const advancedButton = element("button", "ppm-btn ppm-btn-compact", "高级");
  advancedButton.type = "button";
  advancedButton.title = "在完整编辑器中修改全部字段";
  const actions = element("div", "ppm-panel-actions ppm-editor-actions", [saveButton, variantButton, advancedButton]);
  const feedback = element("div", "ppm-node-feedback", "内容请直接在上方原生文本框中编辑");

  root.append(header, selection, quickSelect, primaryFields, moreButton, moreFields, actions, feedback);

  function currentPreset() {
    const id = selectedId(node);
    return context.presets.find((preset) => preset.id === id) || null;
  }

  function readDraft() {
    return {
      name: nameInput.value,
      type: typeSelect.value || "custom",
      content: String(promptWidget?.value ?? ""),
      description: descriptionInput.value,
      tagsText: tagsInput.value,
      folderId: folderSelect.value || null,
    };
  }

  function persistMetadata() {
    const metadata = draftMetadata(readDraft());
    node.properties[PROPERTY_DRAFT] = metadata;
    return metadata;
  }

  function hydrateMetadata(metadata = {}) {
    const wasSyncing = node._ppmSyncingDraft;
    node._ppmSyncingDraft = true;
    try {
      const normalized = draftMetadata({
        ...metadata,
        tagsText: metadata.tagsText ?? (metadata.tags || []).join(", "),
      });
      nameInput.value = normalized.name;
      typeSelect.value = normalized.type;
      tagsInput.value = normalized.tagsText;
      descriptionInput.value = normalized.description;
      node._ppmPendingFolderId = normalized.folderId;
      if (context.loaded) {
        fillFolderOptions(folderSelect, context.folders, node._ppmPendingFolderId);
        node._ppmPendingFolderId = null;
      }
      node._ppmMetadataInitialized = true;
      node.properties[PROPERTY_DRAFT] = normalized;
    } finally {
      node._ppmSyncingDraft = wasSyncing;
    }
  }
  node._ppmHydrateMetadata = hydrateMetadata;
  node._ppmReadDraftMetadata = () => draftMetadata(readDraft());

  function setFeedback(message, kind = "info") {
    feedback.textContent = message;
    feedback.dataset.kind = kind;
  }

  function writeDraft(preset, content = preset?.content ?? "") {
    const wasSyncing = node._ppmSyncingDraft;
    node._ppmSyncingDraft = true;
    try {
      hydrateMetadata(preset);
      setWidgetValue(node, PROMPT_WIDGET, String(content ?? ""), true);
    } finally {
      node._ppmSyncingDraft = wasSyncing;
    }
  }

  function refreshState({ allowLibrarySync = false } = {}) {
    const id = syncSelectionId(node);
    let preset = currentPreset();
    let dirty = Boolean(node.properties[PROPERTY_DIRTY]);

    if (id && !preset && context.loaded) {
      node.properties[PROPERTY_DIRTY] = true;
      dirty = true;
    } else if (preset) {
      if (!node._ppmMetadataInitialized) hydrateMetadata(preset);
      if (allowLibrarySync && !dirty) {
        const revisionChanged = node.properties[PROPERTY_REVISION] !== preset.updatedAt;
        if (revisionChanged || node._ppmNeedsPresetSync) {
          writeDraft(preset);
          node.properties[PROPERTY_REVISION] = preset.updatedAt || "";
          node._ppmNeedsPresetSync = false;
        }
      }
    }

    if (preset) {
      dirty = isDraftDirty(preset, readDraft());
      node.properties[PROPERTY_DIRTY] = dirty;
      const type = TYPE_MAP[preset.type] || TYPE_MAP.custom;
      badge.textContent = type.label;
      badge.style.background = type.color;
      badge.classList.remove("ppm-hidden");
      selectionName.textContent = preset.name;
      syncState.textContent = dirty ? "有修改" : "已同步";
      syncState.dataset.state = dirty ? "dirty" : "clean";
      favorite.textContent = preset.isFavorite ? "★" : "☆";
      favorite.classList.toggle("ppm-star-on", Boolean(preset.isFavorite));
    } else {
      badge.classList.add("ppm-hidden");
      selectionName.textContent = id ? "原预设已不存在" : "本地草稿";
      dirty = isDraftDirty(null, readDraft());
      node.properties[PROPERTY_DIRTY] = dirty;
      syncState.textContent = dirty ? "待新增" : "未选择";
      syncState.dataset.state = dirty ? "dirty" : "idle";
      favorite.textContent = "☆";
      favorite.classList.remove("ppm-star-on");
    }

    favorite.disabled = !preset;
    detach.disabled = !id;
    saveButton.textContent = preset ? "覆盖当前" : "新增预设";
    saveButton.disabled = preset ? !dirty : !nameInput.value.trim();
    variantButton.classList.toggle("ppm-hidden", !preset);
    variantButton.disabled = !preset;
    advancedButton.textContent = preset ? "高级" : "高级添加";
    node.graph?.setDirtyCanvas?.(true, true);
  }

  function markDraftChanged() {
    if (node._ppmSyncingDraft) return;
    persistMetadata();
    node.properties[PROPERTY_DIRTY] = isDraftDirty(currentPreset(), readDraft());
    refreshState();
  }

  function applyPreset(preset) {
    if (!preset) return;
    node._ppmSyncingDraft = true;
    try {
      syncSelectionId(node, preset.id);
      writeDraft(preset);
      node.properties[PROPERTY_DIRTY] = false;
      node.properties[PROPERTY_REVISION] = preset.updatedAt || "";
    } finally {
      node._ppmSyncingDraft = false;
    }
    refreshState();
    setFeedback(`已载入「${preset.name}」`, "success");
  }
  node._ppmApplyPreset = applyPreset;

  const originalPromptCallback = promptWidget?.callback;
  if (promptWidget) {
    promptWidget.callback = function (value, ...args) {
      const result = originalPromptCallback?.call(this, value, ...args);
      if (!node._ppmSyncingDraft) markDraftChanged();
      return result;
    };
  }

  for (const input of [nameInput, typeSelect, folderSelect, tagsInput, descriptionInput]) {
    input.addEventListener("input", markDraftChanged);
    input.addEventListener("change", markDraftChanged);
  }

  detach.addEventListener("click", () => {
    const preset = currentPreset();
    syncSelectionId(node, "");
    node.properties[PROPERTY_REVISION] = "";
    if (preset && nameInput.value.trim() === preset.name) nameInput.value = variantName(preset.name);
    node.properties[PROPERTY_DIRTY] = true;
    refreshState();
    setFeedback("已解除关联，当前内容仍保留在节点中", "info");
  });

  favorite.addEventListener("click", async () => {
    const preset = currentPreset();
    if (!preset) return;
    favorite.disabled = true;
    try {
      await PresetStore.mutate(() => PresetAPI.toggleFavorite(preset.id));
    } catch (error) {
      setFeedback(`收藏失败：${error.message}`, "error");
    } finally {
      favorite.disabled = false;
    }
  });

  async function saveDraft(mode) {
    const preset = currentPreset();
    const draft = readDraft();
    if (!draft.name.trim()) {
      setFeedback("请先填写预设名称", "error");
      nameInput.focus();
      return;
    }
    saveButton.disabled = true;
    variantButton.disabled = true;
    try {
      let payload;
      if (mode === "overwrite" && preset) {
        payload = payloadFromDraft(draft, preset);
      } else {
        const name = preset && draft.name.trim() === preset.name ? variantName(preset.name) : draft.name;
        payload = payloadFromDraft({ ...draft, name });
      }
      const saved = await PresetStore.mutate(() => PresetAPI.savePreset(payload));
      applyPreset(saved);
      setFeedback(mode === "overwrite" ? "已覆盖当前预设" : "已保存并切换到新预设", "success");
    } catch (error) {
      setFeedback(`保存失败：${error.message}`, "error");
    } finally {
      refreshState();
    }
  }

  saveButton.addEventListener("click", () => saveDraft(currentPreset() ? "overwrite" : "create"));
  variantButton.addEventListener("click", () => saveDraft("variant"));
  advancedButton.addEventListener("click", () => {
    const preset = currentPreset();
    const manager = getPresetManager();
    manager.open(node, (sourceNode, selected) => applyPresetToNode(sourceNode, selected));
    manager.openPresetEditor(preset, {
      initialDraft: readDraft(),
      onSaved: (saved) => applyPreset(saved),
    });
  });

  const unsubscribe = PresetStore.subscribe((snapshot) => {
    const selectedFolder = node._ppmPendingFolderId ?? folderSelect.value ?? null;
    context.loaded = true;
    context.folders = snapshot.folders;
    context.presets = snapshot.presets;
    fillFolderOptions(folderSelect, context.folders, selectedFolder);
    node._ppmPendingFolderId = null;
    if (node._ppmMetadataInitialized) persistMetadata();
    refreshState({ allowLibrarySync: true });
  });

  const panelHeight = () => Math.max(210, Math.ceil(root.scrollHeight + 4));
  const domWidget = node.addDOMWidget("preset_panel", "prompt-preset", root, {
    serialize: false,
    getMinHeight: panelHeight,
    getMaxHeight: panelHeight,
  });
  domWidget.serialize = false;
  moveWidgetAfter(node, promptWidget, domWidget);
  root.style.height = "auto";
  root.style.alignSelf = "flex-start";

  function fitNode() {
    root.style.setProperty("height", "auto", "important");
    root.style.setProperty("align-self", "flex-start", "important");
    const metadataExpanded = !moreFields.classList.contains("ppm-hidden");
    const desiredHeight = metadataExpanded
      ? Math.max(600, root.scrollHeight + 230)
      : Math.max(420, root.scrollHeight + 175);
    const width = Math.max(370, node.size?.[0] || 370);
    if (Math.abs((node.size?.[1] || 0) - desiredHeight) > 2 || (node.size?.[0] || 0) < 370) {
      node.setSize([width, desiredHeight]);
      app.graph?.setDirtyCanvas?.(true, true);
    }
  }
  const resizeObserver = new ResizeObserver(() => requestAnimationFrame(fitNode));
  resizeObserver.observe(root);

  const originalRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    unsubscribe();
    resizeObserver.disconnect();
    this._ppmPanelBuilt = false;
    return originalRemoved?.apply(this, args);
  };

  requestAnimationFrame(() => {
    fitNode();
    refreshState({ allowLibrarySync: true });
  });
}

app.registerExtension({
  name: "Comfy.PromptPresetManager",
  init: ensureStyles,
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalCreated?.apply(this, args);
      buildPanel(this);
      return result;
    };

    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const migrated = migrateNodeState(info?.widgets_values, info?.properties);
      this._ppmSyncingDraft = true;
      let result;
      try {
        result = originalConfigure?.apply(this, arguments);
        this.properties ||= {};
        syncSelectionId(this, migrated.presetId);
        this.properties[PROPERTY_DIRTY] = migrated.dirty;
        this.properties[PROPERTY_SCHEMA] = 2;
        this._ppmNeedsPresetSync = migrated.needsPresetSync;
        setWidgetValue(this, PROMPT_WIDGET, migrated.content, true);
        const savedDraft = info?.properties?.[PROPERTY_DRAFT];
        if (savedDraft && typeof savedDraft === "object") {
          this.properties[PROPERTY_DRAFT] = savedDraft;
          this._ppmHydrateMetadata?.(savedDraft);
        }
      } finally {
        this._ppmSyncingDraft = false;
      }
      requestAnimationFrame(() => {
        const preset = PresetStore.getSnapshot().presets.find((item) => item.id === selectedId(this));
        if (preset && this._ppmNeedsPresetSync && !this.properties?.[PROPERTY_DIRTY]) {
          this._ppmApplyPreset?.(preset);
        }
      });
      return result;
    };

    const originalSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (info) {
      const id = syncSelectionId(this);
      info.properties ||= {};
      info.properties[PROPERTY_ID] = id;
      info.properties[PROPERTY_DIRTY] = Boolean(this.properties?.[PROPERTY_DIRTY]);
      info.properties[PROPERTY_REVISION] = this.properties?.[PROPERTY_REVISION] || "";
      info.properties[PROPERTY_SCHEMA] = 2;
      info.properties[PROPERTY_DRAFT] = this._ppmReadDraftMetadata?.() || this.properties?.[PROPERTY_DRAFT] || {};
      return originalSerialize?.apply(this, arguments);
    };

    const originalAdded = nodeType.prototype.onAdded;
    nodeType.prototype.onAdded = function (...args) {
      const result = originalAdded?.apply(this, args);
      syncSelectionId(this);
      return result;
    };
  },
});
