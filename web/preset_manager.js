import { app } from "../../scripts/app.js";
import { PresetAPI, PresetStore, TYPE_MAP } from "./preset_api.mjs";
import { getPresetManager } from "./preset_modal.mjs";

const NODE_NAME = "PromptPresetManager";
const WIDGET_NAME = "preset_id";
const PROPERTY_NAME = "promptPresetId";

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

function widgetFor(node) {
  return node.widgets?.find((widget) => widget.name === WIDGET_NAME);
}

function hideSelectionWidget(node) {
  const widget = widgetFor(node);
  if (!widget) return;
  widget.hidden = true;
  widget.serialize = true;
  widget.computeSize = () => [0, -4];
}

function selectedId(node) {
  const widgetValue = String(widgetFor(node)?.value || "");
  const propertyValue = String(node.properties?.[PROPERTY_NAME] || "");
  return widgetValue || propertyValue;
}

function syncSelection(node, preferredId) {
  const id = String(preferredId ?? selectedId(node) ?? "");
  node.properties ||= {};
  node.properties[PROPERTY_NAME] = id;
  const widget = widgetFor(node);
  if (widget && widget.value !== id) widget.value = id;
  return id;
}

function setSelection(node, id) {
  const value = syncSelection(node, id || "");
  const widget = widgetFor(node);
  widget?.callback?.(value);
  node._ppmRenderSelection?.();
  node.graph?.setDirtyCanvas?.(true, true);
}

function openManager(node) {
  getPresetManager().open(node, (sourceNode, preset) => setSelection(sourceNode, preset.id));
}

function buildQuickSelect(node, context) {
  const wrapper = element("div", "ppm-qs");
  const input = element("input", "ppm-qs-input");
  input.type = "search";
  input.placeholder = "搜索名称、内容或标签";
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
      const name = element("span", "ppm-qs-name", preset.name || "未命名预设");
      const badge = element("span", "ppm-badge ppm-badge-sm", type.label);
      badge.style.background = type.color;
      const item = element("button", "ppm-qs-item", [name, badge]);
      item.type = "button";
      item.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        setSelection(node, preset.id);
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

function buildPanel(node) {
  if (node._ppmPanelBuilt) return;
  node._ppmPanelBuilt = true;
  node.serialize_widgets = true;
  hideSelectionWidget(node);
  syncSelection(node);

  const context = { presets: [] };
  const root = element("div", "ppm-panel");
  const libraryBtn = element("button", "ppm-link-btn", "管理预设库");
  libraryBtn.type = "button";
  libraryBtn.addEventListener("click", () => openManager(node));
  const header = element("div", "ppm-panel-header", [
    element("div", "ppm-panel-heading", [
      element("span", "ppm-panel-title", "提示词预设"),
      element("span", "ppm-panel-shared", "全局共享"),
    ]),
    libraryBtn,
  ]);

  const badge = element("span", "ppm-badge ppm-hidden");
  const name = element("span", "ppm-sel-name", "未选择预设");
  const favorite = element("button", "ppm-star", "☆");
  favorite.type = "button";
  favorite.title = "收藏或取消收藏";
  const selection = element("div", "ppm-sel", [badge, name, favorite]);
  const quickSelect = buildQuickSelect(node, context);
  const preview = element("div", "ppm-preview ppm-mute", "选择一个预设后在这里预览输出内容");

  const edit = element("button", "ppm-btn", "编辑");
  edit.type = "button";
  edit.addEventListener("click", () => {
    const preset = context.presets.find((item) => item.id === selectedId(node));
    const manager = getPresetManager();
    manager.open(node, (sourceNode, selected) => setSelection(sourceNode, selected.id));
    if (preset) manager.openPresetEditor(preset);
  });

  const create = element("button", "ppm-btn", "新建并使用");
  create.type = "button";
  create.addEventListener("click", () => {
    const manager = getPresetManager();
    manager.open(node, (sourceNode, selected) => setSelection(sourceNode, selected.id));
    manager.openPresetEditor(null, { applyOnCreate: true });
  });
  const clear = element("button", "ppm-icon-btn ppm-clear", "×");
  clear.type = "button";
  clear.title = "清除当前选择";
  clear.addEventListener("click", () => setSelection(node, ""));
  const actions = element("div", "ppm-panel-actions", [edit, create, clear]);

  favorite.addEventListener("click", async () => {
    const id = selectedId(node);
    if (!id) return;
    favorite.disabled = true;
    try { await PresetStore.mutate(() => PresetAPI.toggleFavorite(id)); }
    catch (error) { console.warn("收藏预设失败", error); }
    finally { favorite.disabled = false; }
  });

  root.append(header, selection, quickSelect, preview, actions);

  function renderSelection() {
    const id = syncSelection(node);
    const preset = context.presets.find((item) => item.id === id);
    const missing = id && !preset;
    name.textContent = preset?.name || (missing ? "预设已不存在" : "未选择预设");
    badge.classList.toggle("ppm-hidden", !preset);
    edit.disabled = !preset;
    favorite.disabled = !preset;
    clear.disabled = !id;
    if (preset) {
      const type = TYPE_MAP[preset.type] || TYPE_MAP.custom;
      badge.textContent = type.label;
      badge.style.background = type.color;
      favorite.textContent = preset.isFavorite ? "★" : "☆";
      favorite.classList.toggle("ppm-star-on", Boolean(preset.isFavorite));
      preview.textContent = preset.content || "（空内容）";
      preview.title = preset.content || "";
      preview.classList.toggle("ppm-mute", !preset.content);
    } else {
      favorite.textContent = "☆";
      favorite.classList.remove("ppm-star-on");
      preview.textContent = missing
        ? "这个工作流引用的预设已被删除，请重新选择。"
        : "选择一个预设后在这里预览输出内容";
      preview.title = "";
      preview.classList.add("ppm-mute");
    }
  }

  node._ppmRenderSelection = renderSelection;
  const unsubscribe = PresetStore.subscribe((snapshot) => {
    context.presets = snapshot.presets;
    renderSelection();
  });

  const domWidget = node.addDOMWidget("preset_panel", "prompt-preset", root, {
    serialize: false,
    getMinHeight: () => 238,
    getMaxHeight: () => 420,
  });
  domWidget.serialize = false;

  const resizeObserver = new ResizeObserver(() => {
    const height = Math.max(278, Math.ceil(root.scrollHeight + 36));
    const width = Math.max(340, node.size?.[0] || 340);
    if (Math.abs((node.size?.[1] || 0) - height) > 2) node.setSize([width, height]);
  });
  resizeObserver.observe(root);

  const originalRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    unsubscribe();
    resizeObserver.disconnect();
    this._ppmPanelBuilt = false;
    return originalRemoved?.apply(this, args);
  };

  requestAnimationFrame(() => {
    node.setSize([Math.max(340, node.size?.[0] || 340), Math.max(278, node.size?.[1] || 278)]);
    renderSelection();
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
      const result = originalConfigure?.apply(this, arguments);
      const widgetId = String(widgetFor(this)?.value || "");
      const propertyId = String(info?.properties?.[PROPERTY_NAME] || this.properties?.[PROPERTY_NAME] || "");
      syncSelection(this, widgetId || propertyId);
      requestAnimationFrame(() => this._ppmRenderSelection?.());
      return result;
    };

    const originalSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (info) {
      const id = syncSelection(this);
      info.properties ||= {};
      info.properties[PROPERTY_NAME] = id;
      return originalSerialize?.apply(this, arguments);
    };

    const originalAdded = nodeType.prototype.onAdded;
    nodeType.prototype.onAdded = function (...args) {
      const result = originalAdded?.apply(this, args);
      syncSelection(this);
      requestAnimationFrame(() => this._ppmRenderSelection?.());
      return result;
    };
  },
});
