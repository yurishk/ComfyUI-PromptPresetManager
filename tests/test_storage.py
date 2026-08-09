from __future__ import annotations

import pytest


def _preset(name="Preset", content="original", **overrides):
    return {
        "name": name,
        "type": "positive",
        "content": content,
        "description": "description",
        "tags": ["tag-a"],
        "isFavorite": True,
        **overrides,
    }


def test_legacy_default_limit_does_not_lock_an_oversized_library(isolated_store):
    state = isolated_store.get_all()
    state["settings"]["maxPresets"] = 1000
    state["presets"] = [
        {
            "id": f"preset_{index}",
            "name": f"Preset {index}",
            "type": "positive",
            "content": "text",
            "createdAt": "2026-01-01T00:00:00+00:00",
            "updatedAt": "2026-01-01T00:00:00+00:00",
            "sortOrder": index,
        }
        for index in range(1001)
    ]
    isolated_store._write_state(state)

    normalized = isolated_store.get_all()
    created = isolated_store.create_preset(_preset(name="Still writable"))

    assert normalized["settings"]["maxPresets"] == 0
    assert created["name"] == "Still writable"
    assert list((isolated_store.Path(isolated_store._BACKUP_DIR)).glob("presets_backup_*.json"))


def test_partial_preset_update_preserves_unspecified_fields(isolated_store):
    created = isolated_store.create_preset(_preset())

    updated = isolated_store.update_preset(created["id"], {"name": "Renamed"})

    assert updated["name"] == "Renamed"
    assert updated["content"] == "original"
    assert updated["description"] == "description"
    assert updated["tags"] == ["tag-a"]
    assert updated["isFavorite"] is True


def test_folder_parent_cannot_create_a_cycle(isolated_store):
    parent = isolated_store.create_folder({"name": "Parent"})
    child = isolated_store.create_folder({"name": "Child", "parentId": parent["id"]})

    with pytest.raises(ValueError, match="循环"):
        isolated_store.update_folder(parent["id"], {"parentId": child["id"]})


def test_single_preset_export_keeps_ancestor_folders_and_management(isolated_store):
    parent = isolated_store.create_folder({"name": "Parent"})
    child = isolated_store.create_folder({"name": "Child", "parentId": parent["id"]})
    preset = isolated_store.create_preset(_preset(folderId=child["id"]))

    bundle = isolated_store.export_preset(preset["id"])

    assert {folder["id"] for folder in bundle["presetFolders"]} == {parent["id"], child["id"]}
    assert bundle["presetManagement"]["settings"]["defaultFolder"]
    assert bundle["type"] == "presets"


def test_duplicate_legacy_entries_import_once(isolated_store):
    bundle = {
        "version": 1,
        "type": "presets",
        "presets": [
            {"name": "Legacy", "text": "same"},
            {"name": "Legacy", "text": "same"},
        ],
    }

    result = isolated_store.import_bundle(bundle)
    matches = [p for p in isolated_store.get_all()["presets"] if p["name"] == "Legacy"]

    assert result == {"added": 1, "updated": 0}
    assert len(matches) == 1


def test_node_cache_fingerprint_changes_when_shared_preset_changes(isolated_store, node_module):
    created = isolated_store.create_preset(_preset())

    first = node_module.PromptPresetManager.IS_CHANGED(created["id"])
    isolated_store.update_preset(created["id"], {"content": "changed"})
    second = node_module.PromptPresetManager.IS_CHANGED(created["id"])

    assert first != second


def test_vue_bundle_round_trip_preserves_folder_tree_and_preset_content(isolated_store):
    parent = isolated_store.create_folder({"name": "Characters"})
    child = isolated_store.create_folder({"name": "Heroes", "parentId": parent["id"]})
    isolated_store.create_preset(_preset(name="Hero", content="silver armor", folderId=child["id"]))
    bundle = isolated_store.export_all()

    isolated_store._write_state(isolated_store._default_state())
    result = isolated_store.import_bundle(bundle)
    restored = isolated_store.get_all()
    by_name = {folder["name"]: folder for folder in restored["folders"]}
    hero = next(preset for preset in restored["presets"] if preset["name"] == "Hero")

    assert result["added"] == 1
    assert by_name["Heroes"]["parentId"] == by_name["Characters"]["id"]
    assert hero["folderId"] == by_name["Heroes"]["id"]
    assert hero["content"] == "silver armor"
