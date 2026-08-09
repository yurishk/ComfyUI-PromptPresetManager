import { api } from "../../scripts/api.js";
import { createPresetStore } from "./preset_store.mjs";

const PREFIX = "/promptpreset";

async function call(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await api.fetchApi(`${PREFIX}${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = text; }
  }
  if (!response.ok) throw new Error(data?.error || `请求失败 (${response.status})`);
  return data;
}

export const PresetAPI = {
  getAll: () => call("/all").then((result) => result.data),
  getRevision: () => call("/revision").then((result) => result.revision),
  getContent: (id) => call(`/content?id=${encodeURIComponent(id || "")}`).then((result) => result.content || ""),
  savePreset: (preset) => call("/preset", { method: "POST", body: JSON.stringify(preset) }).then((result) => result.preset),
  deletePreset: (id) => call("/preset/delete", { method: "POST", body: JSON.stringify({ id }) }),
  toggleFavorite: (id) => call("/preset/favorite", { method: "POST", body: JSON.stringify({ id }) }).then((result) => result.preset),
  reorderPresets: (orderedIds) => call("/preset/reorder", { method: "POST", body: JSON.stringify({ orderedIds }) }),
  saveFolder: (folder) => call("/folder", { method: "POST", body: JSON.stringify(folder) }).then((result) => result.folder),
  deleteFolder: (id) => call("/folder/delete", { method: "POST", body: JSON.stringify({ id }) }),
  patchSettings: (patch) => call("/settings", { method: "POST", body: JSON.stringify(patch) }).then((result) => result.settings),
  exportAll: () => call("/export/all"),
  exportFolder: (id) => call(`/export/folder?id=${encodeURIComponent(id)}`),
  exportPreset: (id) => call(`/export/preset?id=${encodeURIComponent(id)}`),
  exportSelection: (ids) => call("/export/selection", { method: "POST", body: JSON.stringify({ ids }) }),
  importBundle: (bundle) => call("/import", { method: "POST", body: JSON.stringify(bundle) }),
  async importFile(file) {
    const text = (await file.text()).replace(/^\uFEFF/, "");
    return this.importBundle(JSON.parse(text));
  },
};

export const PresetStore = createPresetStore(PresetAPI, { pollMs: 5000 });

export const PRESET_TYPES = [
  { value: "positive", label: "正面提示词", color: "#169b62" },
  { value: "negative", label: "负面提示词", color: "#d95050" },
  { value: "setting", label: "设定标签", color: "#7c6bc4" },
  { value: "style", label: "风格样式", color: "#c58a25" },
  { value: "character", label: "角色人物", color: "#c45382" },
  { value: "scene", label: "场景环境", color: "#168ea0" },
  { value: "custom", label: "自定义", color: "#58769b" },
];

export const TYPE_MAP = Object.fromEntries(PRESET_TYPES.map((type) => [type.value, type]));
export const DEFAULT_FOLDER_COLOR = "#58769b";

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function sanitizeFilename(name) {
  return String(name || "presets").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
}
