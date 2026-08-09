import assert from "node:assert/strict";
import test from "node:test";

import { createPresetStore } from "./preset_store.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("parallel subscribers share one initial request", async () => {
  const pending = deferred();
  let calls = 0;
  const store = createPresetStore({
    getAll: async () => { calls += 1; return pending.promise; },
    getRevision: async () => 1,
  }, { autoPoll: false });

  const first = store.load();
  const second = store.load();
  pending.resolve({ revision: 1, folders: [], presets: [], settings: {} });

  assert.equal(await first, await second);
  assert.equal(calls, 1);
});

test("mutation reloads once and notifies all subscribers", async () => {
  let revision = 1;
  let loads = 0;
  const client = {
    getAll: async () => ({ revision, folders: [], presets: [{ id: `p${revision}` }], settings: {} }),
    getRevision: async () => revision,
  };
  const store = createPresetStore(client, { autoPoll: false });
  const snapshots = [];
  const originalGetAll = client.getAll;
  client.getAll = async () => { loads += 1; return originalGetAll(); };
  const unsubscribeA = store.subscribe((snapshot) => snapshots.push(snapshot.revision));
  const unsubscribeB = store.subscribe(() => {});

  await store.load();
  revision = 2;
  await store.mutate(async () => "saved");

  assert.equal(loads, 2);
  assert.deepEqual(snapshots, [1, 2]);
  unsubscribeA();
  unsubscribeB();
});

test("revision check only reloads when backend changed", async () => {
  let revision = 4;
  let loads = 0;
  const store = createPresetStore({
    getAll: async () => { loads += 1; return { revision, folders: [], presets: [], settings: {} }; },
    getRevision: async () => revision,
  }, { autoPoll: false });

  await store.load();
  await store.checkRevision();
  revision = 5;
  await store.checkRevision();

  assert.equal(loads, 2);
  assert.equal(store.getSnapshot().revision, 5);
});

test("mutation cannot be overwritten by an older in-flight load", async () => {
  const stale = deferred();
  let calls = 0;
  const store = createPresetStore({
    getAll: async () => {
      calls += 1;
      if (calls === 1) return stale.promise;
      return { revision: 2, folders: [], presets: [{ id: "new" }], settings: {} };
    },
    getRevision: async () => 2,
  }, { autoPoll: false });

  const initial = store.load();
  const mutation = store.mutate(async () => "saved");
  stale.resolve({ revision: 1, folders: [], presets: [{ id: "old" }], settings: {} });
  await initial;
  await mutation;

  assert.equal(calls, 2);
  assert.equal(store.getSnapshot().revision, 2);
  assert.equal(store.getSnapshot().presets[0].id, "new");
});
