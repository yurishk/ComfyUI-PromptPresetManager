import { tr } from "./i18n.mjs";

// One queue per node; only the exact protected draft may be replaced.
export function createHistoryGuard({ read, capture, apply, status }) {
  let tail = Promise.resolve();
  let generation = 0;
  let disposed = false;
  const enqueue = (operation) => {
    const result = tail.then(() => disposed ? undefined : operation());
    tail = result.catch(() => {});
    return result;
  };
  return {
    changed() { generation += 1; },
    run: enqueue,
    replace(snapshot, source = "restore", receiptId = "") {
      const requestedGeneration = generation;
      return enqueue(async () => {
        const before = read();
        const fingerprint = JSON.stringify(before);
        await capture(before, "draft");
        await capture(snapshot, source, receiptId);
        if (disposed || generation !== requestedGeneration || JSON.stringify(read()) !== fingerprint) {
          status(tr("内容已留存；当前有新编辑，请从历史载入", "Saved to history; newer edits kept. Load the result from History."));
          return false;
        }
        apply(snapshot);
        return true;
      });
    },
    dispose() { disposed = true; },
  };
}
