import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest


def test_overwrite_restore_chain_and_conflict(isolated_store):
    store = isolated_store
    a = store.create_preset({"name": "A", "content": " A\n", "tags": ["原始"], "isFavorite": True})
    b = store.update_preset(a["id"], {"content": "B", "expectedUpdatedAt": a["updatedAt"]})
    c = store.update_preset(a["id"], {"content": "C", "expectedUpdatedAt": b["updatedAt"]})
    with pytest.raises(ValueError, match="其他操作"):
        store.restore_preset_history(b["_undoHistoryId"], b["updatedAt"])
    restored = store.restore_preset_history(b["_undoHistoryId"], c["updatedAt"])
    assert restored["content"] == " A\n"
    assert restored["isFavorite"] is True
    entries = store.history_store.list_entries(store.history_path(), preset_id=a["id"])
    assert entries["total"] == 3
    assert {store.history_store.get(store.history_path(), item["id"])["snapshot"]["content"] for item in entries["items"]} == {" A\n", "B", "C"}
    assert "_undoHistoryId" not in store.get_preset(a["id"])


def test_archive_failure_leaves_library_unchanged(isolated_store, monkeypatch):
    store = isolated_store
    a = store.create_preset({"content": "original"})
    def fail(*args, **kwargs):
        raise OSError("disk full")
    monkeypatch.setattr(store.history_store, "append", fail)
    with pytest.raises(OSError):
        store.update_preset(a["id"], {"content": "lost"})
    assert store.get_preset(a["id"])["content"] == "original"


def test_failed_json_commit_only_archives_authentic_old_version(isolated_store, monkeypatch):
    store = isolated_store
    a = store.create_preset({"content": "old"})
    def fail(*args):
        raise OSError("interrupted")
    monkeypatch.setattr(store, "_commit", fail)
    with pytest.raises(OSError):
        store.update_preset(a["id"], {"content": "never committed"})
    assert store.get_preset(a["id"])["content"] == "old"
    item = store.history_store.list_entries(store.history_path())["items"][0]
    assert item["preview"] == "old"


def test_retention_removes_old_content_and_trash(isolated_store, monkeypatch):
    store = isolated_store
    history = store.history_store
    clock = [1800000000.0]
    monkeypatch.setattr(history.time, "time", lambda: clock[0])
    old = store.record_text_history({"content": "expired"}, scope="node")
    trash = store.record_text_history({"content": "trash"}, scope="node")
    history.manage(store.history_path(), [trash], "delete")
    clock[0] += 8 * 86400
    assert history.get(store.history_path(), trash) is None
    assert history.get(store.history_path(), old)
    clock[0] += 23 * 86400
    assert history.get(store.history_path(), old) is None
    with sqlite3.connect(store.history_path()) as db:
        assert db.execute("SELECT count(*) FROM snapshots").fetchone()[0] == 0


def test_checkpoint_is_one_recovery_point_and_expiry_is_finite(isolated_store):
    store = isolated_store
    first = store.record_text_history({"content": "draft A"}, scope="node", checkpoint=True)
    second = store.record_text_history({"content": "draft B", "tagsText": "甲, 乙"}, scope="node", checkpoint=True)
    assert first == second
    assert store.history_store.list_entries(store.history_path(), scope="node")["total"] == 1
    assert store.history_store.get(store.history_path(), first)["snapshot"]["tags"] == ["甲", "乙"]
    for invalid in [0, -1, 366, True, "30"]:
        with pytest.raises(ValueError):
            store.history_store.settings(store.history_path(), invalid)


def test_many_results_keep_every_event_and_deduplicate_retry(isolated_store):
    store = isolated_store
    for index in range(1000):
        text = f"result {index % 3}"
        entry = store.record_text_history({"content": text}, scope="one", source="external", event_key=f"run:{index}")
        assert store.record_text_history({"content": text}, scope="one", source="external", event_key=f"run:{index}") == entry
    page = store.history_store.list_entries(store.history_path(), scope="one")
    assert page["total"] == 1000
    assert len(page["items"]) == 40
    assert page["items"][0]["preview"] == "result 0"
    assert store.history_store.list_entries(store.history_path(), scope="other")["total"] == 0


def test_backend_records_last_result_without_browser(isolated_store, node_module):
    props = {"promptPresetHistoryScope": "workflow-node", "promptPresetText": "{red|blue}",
             "promptPresetDraft": {"name": "unsaved", "tagsText": "a,b"}}
    extra = {"workflow": {"nodes": [{"id": 7, "properties": props}]}}
    result = node_module.PromptPresetManager().get_text("red", "last result", unique_id="7", extra_pnginfo=extra)
    history = isolated_store.history_store
    entries = history.list_entries(isolated_store.history_path(), scope="workflow-node")["items"]
    assert {entry["preview"] for entry in entries} == {"{red|blue}", "last result"}
    assert history.get(isolated_store.history_path(), result["ui"]["history_id"][0])["snapshot"]["tags"] == ["a", "b"]


def test_external_failure_preserves_output_and_reports_error(isolated_store, node_module, monkeypatch):
    def fail(*args, **kwargs):
        raise OSError("readonly")
    monkeypatch.setattr(isolated_store, "record_text_history", fail)
    result = node_module.PromptPresetManager().get_text("local", "external")
    assert result["result"] == ("external",)
    assert result["ui"]["history_error"] == ["readonly"]


def test_import_and_unchanged_updates_are_protected(isolated_store):
    store = isolated_store
    a = store.create_preset({"name": "A", "content": "A"})
    store.update_preset(a["id"], {"content": "A"})
    assert store.history_store.list_entries(store.history_path())["total"] == 0
    store.import_bundle({"extendedPresets": [{**a, "content": "imported"}]})
    assert store.history_store.list_entries(store.history_path())["items"][0]["preview"] == "A"


def test_concurrent_writers_and_soft_delete(isolated_store):
    store = isolated_store
    def write(index):
        return store.record_text_history({"content": str(index)}, scope="parallel", event_key=f"parallel:{index}")
    with ThreadPoolExecutor(max_workers=4) as pool:
        ids = list(pool.map(write, range(40)))
    store.history_store.manage(store.history_path(), ids[:2], "delete")
    assert store.history_store.list_entries(store.history_path(), trash=True)["total"] == 2
    store.history_store.manage(store.history_path(), ids[:1], "restore")
    assert store.history_store.list_entries(store.history_path())["total"] == 39
    assert store.history_store.get(store.history_path(), ids[0])["snapshot"]["content"] == "0"


def test_saved_preset_does_not_create_redundant_text_history(isolated_store):
    store = isolated_store
    preset = store.create_preset({"name": "Saved", "content": "saved text", "tags": ["a"]})
    snapshot = {**preset, "presetId": preset["id"]}
    for source in ("draft", "queued", "checkpoint", "switch", "restore"):
        assert store.record_text_history(snapshot, scope="node", source=source,
                                         checkpoint=source == "checkpoint") == ""
    assert store.history_store.list_entries(store.history_path())["total"] == 0
    # An external original that is already saved need not be archived again.
    assert store.record_text_history(snapshot, scope="node", source="external") == ""
    # Metadata-only edits and literal whitespace changes are unsaved states too.
    for change in ({"description": "unsaved"}, {"tags": ["b"]}, {"content": "saved text\n"}):
        assert store.record_text_history({**snapshot, **change}, scope="node", source="draft")
    assert store.history_store.list_entries(store.history_path())["total"] == 3


def test_saved_preset_backend_baseline_is_skipped_but_new_result_is_recorded(isolated_store, node_module):
    store = isolated_store
    preset = store.create_preset({"name": "Saved", "content": "{red|blue}"})
    props = {"promptPresetHistoryScope": "node", "promptPresetText": preset["content"],
             "promptPresetId": preset["id"]}
    result = node_module.PromptPresetManager().get_text("red", "new result", unique_id="7",
        extra_pnginfo={"workflow": {"nodes": [{"id": 7, "properties": props}]}})
    entries = store.history_store.list_entries(store.history_path(), scope="node")["items"]
    assert [(entry["source"], entry["preview"]) for entry in entries] == [("external", "new result")]
    assert result["ui"]["history_id"][0]
    updated = store.update_preset(preset["id"], {"content": "overwritten"})
    assert store.history_store.get(store.history_path(), updated["_undoHistoryId"])["snapshot"]["content"] == "{red|blue}"


def test_saving_external_original_permanently_removes_only_matching_external(isolated_store):
    store = isolated_store
    first = store.record_text_history({"content": "result", "name": "old name"}, source="external", scope="one")
    repeated = store.record_text_history({"content": "result"}, source="external", scope="two")
    different = store.record_text_history({"content": "result\n"}, source="external")
    draft = store.record_text_history({"content": "draft not saved"}, source="draft")
    store.history_store.manage(store.history_path(), [repeated], "delete")
    store.create_preset({"name": "new name", "content": "result"})
    assert store.history_store.get(store.history_path(), first) is None
    assert store.history_store.get(store.history_path(), repeated) is None
    assert store.history_store.get(store.history_path(), different)
    assert store.history_store.get(store.history_path(), draft)
    assert store.history_store.list_entries(store.history_path(), trash=True)["total"] == 0
    assert store.record_text_history({"content": "result"}, source="external") == ""


def test_saving_edited_variant_keeps_original_and_failed_save_keeps_result(isolated_store, monkeypatch):
    store = isolated_store
    original = store.record_text_history({"content": "original result"}, source="external")
    store.create_preset({"content": "edited result"})
    assert store.history_store.get(store.history_path(), original)
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr(store, "_commit", fail)
    with pytest.raises(OSError):
        store.create_preset({"content": "original result"})
    assert store.history_store.get(store.history_path(), original)


def test_overwrite_and_import_remove_saved_external_but_keep_preset_versions(isolated_store):
    store = isolated_store
    preset = store.create_preset({"name": "preset", "content": "old"})
    result = store.record_text_history({"content": "new"}, source="external")
    updated = store.update_preset(preset["id"], {"content": "new"})
    assert store.history_store.get(store.history_path(), result) is None
    assert store.history_store.get(store.history_path(), updated["_undoHistoryId"])["snapshot"]["content"] == "old"
    imported = store.record_text_history({"content": "imported"}, source="external")
    store.import_bundle({"extendedPresets": [{**preset, "content": "imported"}]})
    assert store.history_store.get(store.history_path(), imported) is None


def test_deleted_preset_can_be_restored_with_id_and_metadata(isolated_store):
    store = isolated_store
    folder = store.create_folder({"name": "folder"})
    preset = store.create_preset({"name": "Keep me", "content": "original", "isFavorite": True,
        "folderId": folder["id"], "tags": ["tag"], "description": "notes"})
    assert store.delete_preset(preset["id"])
    assert store.get_preset(preset["id"]) is None
    trash = store.history_store.list_entries(store.history_path(), trash=True)["items"]
    assert len(trash) == 1 and trash[0]["source"] == "deleted"
    restored = store.restore_deleted_preset_history(trash[0]["id"])
    for key in ("id", "name", "content", "isFavorite", "folderId", "tags", "description", "createdAt"):
        assert restored[key] == preset[key]
    assert store.history_store.list_entries(store.history_path(), trash=True)["total"] == 0


def test_deleted_preset_expires_and_archive_failure_prevents_deletion(isolated_store, monkeypatch):
    store = isolated_store
    history = store.history_store
    clock = [1800000000.0]
    monkeypatch.setattr(history.time, "time", lambda: clock[0])
    preset = store.create_preset({"content": "to trash"})
    store.delete_preset(preset["id"])
    clock[0] += 8 * 86400
    assert history.list_entries(store.history_path(), trash=True)["total"] == 0
    kept = store.create_preset({"content": "must remain"})
    def fail(*args, **kwargs):
        raise OSError("archive failed")
    monkeypatch.setattr(history, "append", fail)
    with pytest.raises(OSError):
        store.delete_preset(kept["id"])
    assert store.get_preset(kept["id"])["content"] == "must remain"
