import { PresetAPI, PresetStore, TYPE_MAP, downloadJson } from "./preset_api.mjs?v=8";
import { tr } from "./i18n.mjs";
export { createHistoryGuard } from "./preset_history_guard.mjs?v=6";

const SCOPE = "promptPresetHistoryScope";
export const newHistoryId = () => crypto.randomUUID();

export function historyScope(node) {
  node.properties ||= {};
  return node.properties[SCOPE] ||= newHistoryId();
}

const labels = () => ({
  external: tr("外部输入", "External input"), queued: tr("运行前草稿", "Queued draft"),
  draft: tr("本地草稿", "Local draft"), checkpoint: tr("草稿恢复点", "Draft recovery point"),
  switch: tr("切换预设", "Preset switch"), restore: tr("历史恢复", "History restored"),
  preset: tr("预设旧版本", "Preset version"),
  deleted: tr("已删除预设", "Deleted preset"),
});

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function button(text, action, className = "ppm-btn") {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

let active = null;

export function openHistory({ node = null, edit, focusId = "" } = {}) {
  active?.close();
  const opener = document.activeElement;
  const overlay = el("div", "ppm-overlay ppm-open ppm-history-overlay");
  const win = el("div", "ppm-window ppm-history-window");
  win.setAttribute("role", "dialog");
  win.setAttribute("aria-modal", "true");
  win.setAttribute("aria-label", tr("历史记录", "History"));
  const title = el("strong", "ppm-title", tr("历史记录", "History"));
  const header = el("div", "ppm-header");
  const message = el("div", "ppm-history-message");
  message.setAttribute("role", "status");
  const state = { page: 1, scope: node ? "node" : "all", trash: false, query: "", source: "", selected: new Set(), selectedId: "", total: 0, days: 30 };
  let loadGeneration = 0, detailGeneration = 0, timer, closed = false, busy = false;
  const report = (error) => { message.textContent = error?.message || String(error); message.dataset.kind = "error"; };
  const run = async (operation) => {
    if (busy || closed) return;
    busy = true;
    win.setAttribute("aria-busy", "true");
    message.textContent = "";
    try { await operation(); } catch (error) { report(error); }
    finally { busy = false; win.removeAttribute("aria-busy"); }
  };
  function close() {
    closed = true;
    clearTimeout(timer);
    document.removeEventListener("keydown", keys, true);
    overlay.remove();
    if (active?.close === close) active = null;
    if (!document.querySelector(".ppm-overlay.ppm-open")) document.body.classList.remove("ppm-modal-open");
    if (opener?.isConnected) opener.focus();
  }
  const closeButton = button(tr("关闭", "Close"), close, "ppm-link-btn");
  header.append(title, closeButton);
  const toolbar = el("div", "ppm-history-toolbar");
  const scope = el("select", "ppm-select");
  const choices = [["all", tr("全部历史", "All history")]];
  if (node) choices.unshift(["node", tr("本节点文本", "This node's text")]);
  if (node?.properties?.promptPresetId) choices.splice(1, 0, ["preset", tr("关联预设版本", "Linked preset versions")]);
  for (const [value, label] of choices) { const option = el("option", "", label); option.value = value; scope.append(option); }
  scope.value = state.scope;
  scope.setAttribute("aria-label", tr("历史范围", "History scope"));
  const search = el("input", "ppm-search");
  search.type = "search";
  search.placeholder = tr("搜索正文、名称、备注…", "Search text, names, notes…");
  search.setAttribute("aria-label", search.placeholder);
  const source = el("select", "ppm-select");
  for (const [value, label] of [["", tr("所有来源", "All sources")], ...Object.entries(labels())]) {
    const option = el("option", "", label); option.value = value; source.append(option);
  }
  source.setAttribute("aria-label", tr("记录来源", "Record source"));
  const trashButton = button(tr("回收站", "Trash"), () => {
    state.trash = !state.trash;
    if (state.trash) { state.scope = "all"; scope.value = "all"; state.source = ""; source.value = ""; }
    trashButton.setAttribute("aria-pressed", String(state.trash)); reset();
  });
  trashButton.setAttribute("aria-pressed", "false");
  toolbar.append(scope, search, source, button(tr("刷新", "Refresh"), () => load()), trashButton);
  const body = el("div", "ppm-history-body");
  const list = el("div", "ppm-history-list");
  const detail = el("div", "ppm-history-detail");
  body.append(list, detail);
  const bulk = el("div", "ppm-history-bulk");
  const count = el("span", "ppm-mute");
  const footer = el("div", "ppm-history-footer");
  const pageLabel = el("span", "ppm-mute");
  const retention = button("", () => run(async () => {
    const value = prompt(tr("历史保留天数（1–365），过期记录将永久删除：", "Retention days (1–365). Expired records are permanently deleted:"), String(state.days));
    if (value === null) return;
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error(tr("请输入 1–365 的整数", "Enter an integer from 1 to 365"));
    if (days < state.days && !confirm(tr("缩短期限会立即删除更早的记录，继续？", "Shortening retention immediately deletes older records. Continue?"))) return;
    await PresetAPI.historySettings(days); await load();
  }), "ppm-link-btn");
  const prev = button(tr("上一页", "Previous"), () => { state.page--; load(); });
  const next = button(tr("下一页", "Next"), () => { state.page++; load(); });
  footer.append(retention, pageLabel, prev, next);
  win.append(header, toolbar, message, bulk, body, footer);
  overlay.append(win);
  document.body.append(overlay);
  document.body.classList.add("ppm-modal-open");
  active = { close };
  overlay.addEventListener("pointerdown", (event) => { if (event.target === overlay) close(); });
  function keys(event) {
    // A reused preset editor may sit above this panel.
    if (document.querySelector(".ppm-dialog-overlay.ppm-open")) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== "Tab") return;
    const focusable = [...win.querySelectorAll("button,input,select,textarea,[tabindex]")].filter((item) => !item.disabled && item.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  document.addEventListener("keydown", keys, true);
  scope.addEventListener("change", () => { state.scope = scope.value; reset(); });
  source.addEventListener("change", () => { state.source = source.value; reset(); });
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { state.query = search.value; reset(); }, 220); });
  function filters() {
    return { page: state.page, query: state.query, source: state.source, trash: state.trash,
      scope: state.scope === "node" ? historyScope(node) : "",
      presetId: state.scope === "preset" ? node.properties.promptPresetId : "",
      kind: state.scope === "preset" ? "preset" : state.scope === "node" ? "text" : "" };
  }
  function reset() { state.page = 1; state.selected.clear(); state.selectedId = ""; load(); }
  function updateBulk() { count.textContent = tr(`已选 ${state.selected.size} 条`, `${state.selected.size} selected`); bulk.hidden = !state.selected.size; }
  async function manage(action) {
    const ids = [...state.selected];
    if (!ids.length) return;
    if (action === "purge" && !confirm(tr(`永久删除 ${ids.length} 条历史？无法恢复。`, `Permanently delete ${ids.length} records? This cannot be undone.`))) return;
    await PresetAPI.manageHistory(ids, action);
    if (action === "restore") await PresetStore.refresh();
    state.selected.clear(); state.selectedId = ""; await load();
  }
  bulk.append(count,
    button(tr("移入回收站", "Move to trash"), () => run(() => manage("delete"))),
    button(tr("还原记录", "Restore records"), () => run(() => manage("restore"))),
    button(tr("永久删除", "Delete permanently"), () => run(() => manage("purge")), "ppm-btn ppm-btn-danger"),
    button(tr("导出所选", "Export selected"), () => run(async () => {
      const entries = await Promise.all([...state.selected].map((id) => PresetAPI.historyEntry(id)));
      downloadJson("prompt-history.json", { version: 1, exportedAt: new Date().toISOString(), entries });
    })),
    button(tr("所选另存为预设", "Save selected as presets"), () => run(async () => {
      if (!confirm(tr(`将 ${state.selected.size} 条历史另存为新预设？`, `Save ${state.selected.size} records as new presets?`))) return;
      // Saving one result can discard other external entries with identical
      // text. Resolve the selected snapshots before saving the first one.
      const entries = await Promise.all([...state.selected].map((id) => PresetAPI.historyEntry(id)));
      for (const entry of entries) {
        const snapshot = entry.snapshot;
        const folderId = PresetStore.getSnapshot().folders.some((folder) => folder.id === snapshot.folderId) ? snapshot.folderId : null;
        await PresetAPI.savePreset({ ...snapshot, folderId, name: snapshot.name || tr("历史预设", "Recovered preset") });
      }
      await PresetStore.refresh();
      state.selected.clear(); state.selectedId = "";
      await load();
      message.textContent = tr("已另存为新预设", "Saved as new presets");
    })));

  async function load() {
    const ticket = ++loadGeneration;
    try {
      list.setAttribute("aria-busy", "true");
      const data = await PresetAPI.history(filters());
      if (closed || ticket !== loadGeneration) return;
      state.total = data.total; state.days = data.retentionDays;
      retention.textContent = tr(`保留 ${state.days} 天 · 更改`, `Keep ${state.days} days · Change`);
      pageLabel.textContent = tr(`${state.total} 条 · 第 ${state.page} 页`, `${state.total} records · Page ${state.page}`);
      prev.disabled = state.page <= 1; next.disabled = state.page * 40 >= data.total;
      for (const [index, control] of [...bulk.querySelectorAll("button")].entries()) {
        control.hidden = index === 0 ? state.trash : index === 1 || index === 2 ? !state.trash : false;
      }
      list.replaceChildren();
      if (!data.items.length) list.append(el("div", "ppm-empty", tr("暂无历史记录", "No history records")));
      if (data.items.length) {
        const selectPage = button(tr("全选 / 取消本页", "Select / clear this page"), () => {
          const allSelected = data.items.every((item) => state.selected.has(item.id));
          for (const item of data.items) allSelected ? state.selected.delete(item.id) : state.selected.add(item.id);
          for (const check of list.querySelectorAll('input[type="checkbox"]')) check.checked = !allSelected;
          updateBulk();
        }, "ppm-link-btn ppm-history-select-page");
        list.append(selectPage);
      }
      for (const item of data.items) {
        const row = el("div", "ppm-history-row");
        row.dataset.id = item.id;
        const check = el("input"); check.type = "checkbox"; check.checked = state.selected.has(item.id);
        check.setAttribute("aria-label", tr("选择此记录", "Select record"));
        check.addEventListener("change", () => { check.checked ? state.selected.add(item.id) : state.selected.delete(item.id); updateBulk(); });
        const choose = button("", () => show(item.id), "ppm-history-choose");
        const date = new Date(item.created * 1000).toLocaleString();
        choose.append(el("span", "ppm-history-row-meta", `${date} · ${labels()[item.source] || item.source}`),
          el("strong", "", item.note || item.snapshot.name || tr("未命名文本", "Untitled text")),
          el("span", "ppm-history-preview", item.preview || tr("空文本", "Empty text")));
        row.append(check, choose); list.append(row);
      }
      updateBulk();
      const chosen = state.selectedId || data.items[0]?.id;
      if (chosen) await show(chosen);
      else detail.replaceChildren(el("div", "ppm-empty", tr("选择记录查看、恢复或另存", "Select a record to preview, restore or save")));
    } catch (error) { if (!closed && ticket === loadGeneration) report(error); }
    finally { if (ticket === loadGeneration) list.removeAttribute("aria-busy"); }
  }

  async function show(id) {
    const ticket = ++detailGeneration;
    state.selectedId = id;
    for (const row of list.children) row.classList.toggle("ppm-active", row.dataset.id === id);
    try {
      const entry = await PresetAPI.historyEntry(id);
      if (closed || ticket !== detailGeneration) return;
      const snapshot = entry.snapshot;
      detail.replaceChildren();
      const heading = el("h3", "", snapshot.name || tr("未命名文本", "Untitled text"));
      const meta = el("p", "ppm-mute", `${new Date(entry.created * 1000).toLocaleString()} · ${labels()[entry.source] || entry.source} · ${entry.length} ${tr("字", "characters")}`);
      const text = el("textarea", "ppm-input ppm-textarea ppm-history-text");
      text.value = snapshot.content; text.readOnly = true;
      text.setAttribute("aria-label", tr("历史原文", "Historical text"));
      const fields = el("p", "ppm-history-fields", [TYPE_MAP[snapshot.type]?.label, (snapshot.tags || []).join(", "), snapshot.description].filter(Boolean).join(" · "));
      const actions = el("div", "ppm-history-actions");
      if (node && !state.trash) actions.append(button(tr("恢复到节点", "Restore to node"), () => run(async () => {
        const restored = await node._ppmRestoreHistory?.(snapshot);
        if (restored) message.textContent = tr("已恢复；外部输入仍连接时，下次运行会继续接收外部文本", "Restored. A connected external input still takes priority on the next run.");
      }), "ppm-btn ppm-btn-primary"));
      if (!state.trash || entry.source === "deleted") {
        actions.append(button(tr("另存 / 编辑副本", "Save / edit a copy"), () => { close(); edit?.(snapshot); }));
        if (entry.kind === "preset" && !state.trash) actions.append(button(tr("恢复到预设库", "Restore library version"), () => run(async () => {
          await PresetStore.refresh();
          const current = PresetStore.getSnapshot().presets.find((preset) => preset.id === entry.preset_id);
          if (!current) throw new Error(tr("原预设已删除，请另存副本", "Original preset deleted; save a copy instead"));
          if (!confirm(tr(`恢复共享预设“${current.name}”？当前库版本也会留存。`, `Restore shared preset “${current.name}”? Its current version will also be archived.`))) return;
          await PresetStore.mutate(() => PresetAPI.restorePresetHistory(id, current.updatedAt));
          message.textContent = tr("已恢复预设库版本", "Library version restored");
          await load();
        })));
      }
      actions.append(button(tr("复制", "Copy"), () => run(async () => { await navigator.clipboard.writeText(snapshot.content); message.textContent = tr("已复制", "Copied"); })),
        button(tr("备注", "Note"), () => run(async () => {
          const note = prompt(tr("记录备注（不修改原文）：", "Note (original text stays unchanged):"), entry.note);
          if (note !== null) { await PresetAPI.manageHistory([id], "note", note); await load(); }
        })),
        button(state.trash ? (entry.source === "deleted" ? tr("恢复预设", "Restore preset") : tr("还原记录", "Restore record")) : tr("删除", "Delete"), () => run(async () => {
          await PresetAPI.manageHistory([id], state.trash ? "restore" : "delete");
          if (state.trash) await PresetStore.refresh();
          state.selectedId = ""; await load();
        }), "ppm-btn ppm-btn-danger"));
      const compare = button(tr("与当前比较", "Compare with current"), () => {
        const current = entry.kind === "preset"
          ? PresetStore.getSnapshot().presets.find((preset) => preset.id === entry.preset_id)
          : node?._ppmReadHistorySnapshot?.();
        comparison.hidden = !comparison.hidden;
        currentText.value = current?.content ?? tr("当前内容不存在", "Current content unavailable");
      });
      const comparison = el("div", "ppm-history-comparison"); comparison.hidden = true;
      const currentText = el("textarea", "ppm-input ppm-textarea ppm-history-text"); currentText.readOnly = true;
      currentText.setAttribute("aria-label", tr("当前正文", "Current text"));
      comparison.append(el("strong", "", tr("当前正文", "Current text")), currentText);
      detail.append(heading, meta, fields, text, compare, comparison, actions);
    } catch (error) { if (ticket === detailGeneration) report(error); }
  }
  run(async () => {
    await load();
    if (focusId) await show(focusId);
    search.focus();
  });
  return active;
}
