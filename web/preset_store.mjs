const EMPTY_SNAPSHOT = Object.freeze({
  version: 2,
  revision: 0,
  folders: [],
  presets: [],
  settings: {},
});

function normalizeSnapshot(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...source,
    revision: Number.isFinite(Number(source.revision)) ? Number(source.revision) : 0,
    folders: Array.isArray(source.folders) ? source.folders : [],
    presets: Array.isArray(source.presets) ? source.presets : [],
    settings: source.settings && typeof source.settings === "object" ? source.settings : {},
  };
}

export function createPresetStore(client, options = {}) {
  const pollMs = options.pollMs ?? 5000;
  const autoPoll = options.autoPoll ?? true;
  const isVisible = options.isVisible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const listeners = new Set();
  let snapshot = null;
  let loading = null;
  let pollTimer = null;

  function notify() {
    for (const listener of listeners) {
      try {
        listener(snapshot || EMPTY_SNAPSHOT);
      } catch (error) {
        console.error("PromptPresetManager store listener failed", error);
      }
    }
  }

  async function load({ force = false } = {}) {
    if (loading) return loading;
    if (snapshot && !force) return snapshot;
    loading = Promise.resolve(client.getAll())
      .then((data) => {
        snapshot = normalizeSnapshot(data);
        notify();
        return snapshot;
      })
      .finally(() => { loading = null; });
    return loading;
  }

  async function checkRevision() {
    if (!isVisible()) return snapshot || EMPTY_SNAPSHOT;
    const remote = Number(await client.getRevision());
    if (!snapshot || !Number.isFinite(remote) || remote !== snapshot.revision) {
      return refresh();
    }
    return snapshot;
  }

  async function refresh() {
    if (loading) {
      try { await loading; }
      catch { /* The forced request below gets a clean retry. */ }
    }
    return load({ force: true });
  }

  function startPolling() {
    if (!autoPoll || pollTimer || !listeners.size) return;
    pollTimer = setInterval(() => {
      checkRevision().catch((error) => console.warn("PromptPresetManager version check failed", error));
    }, pollMs);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function subscribe(listener) {
    listeners.add(listener);
    if (snapshot) listener(snapshot);
    else load().catch((error) => console.warn("PromptPresetManager initial load failed", error));
    startPolling();
    return () => {
      listeners.delete(listener);
      if (!listeners.size) stopPolling();
    };
  }

  async function mutate(operation) {
    const result = await operation();
    await refresh();
    return result;
  }

  return {
    load,
    refresh,
    checkRevision,
    mutate,
    subscribe,
    getSnapshot: () => snapshot || EMPTY_SNAPSHOT,
    destroy() {
      listeners.clear();
      stopPolling();
      snapshot = null;
      loading = null;
    },
  };
}
