"""Thread-safe local repository for PromptPresetManager.

The on-disk state is private to this ComfyUI plugin. Import/export bundles keep
the standalone Vue application's version-1 preset format so files can travel in
both directions without browser storage being involved.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PRESET_TYPES = (
    "positive",
    "negative",
    "setting",
    "style",
    "character",
    "scene",
    "custom",
)

PRESET_TYPE_LABELS = {
    "positive": "正面提示词",
    "negative": "负面提示词",
    "setting": "设定标签",
    "style": "风格样式",
    "character": "角色人物",
    "scene": "场景环境",
    "custom": "自定义",
}

DEFAULT_FOLDER_COLOR = "#6366f1"
STORE_VERSION = 2
BUNDLE_VERSION = 1
DEFAULT_MAX_PRESETS = 0  # 0 means unlimited.
MAX_BACKUPS = 12

_HERE = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR = os.path.join(_HERE, "data")
_DATA_FILE = os.path.join(_DATA_DIR, "presets.json")
_BACKUP_DIR = os.path.join(_HERE, "backups")
_LOCK = threading.RLock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _gen_id(prefix: str) -> str:
    return f"{prefix}_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"


def _default_folder() -> dict[str, Any]:
    now = _now_iso()
    return {
        "id": _gen_id("folder"),
        "name": "默认文件夹",
        "description": "系统默认预设文件夹",
        "color": DEFAULT_FOLDER_COLOR,
        "parentId": None,
        "createdAt": now,
        "updatedAt": now,
    }


def _default_state() -> dict[str, Any]:
    folder = _default_folder()
    return {
        "version": STORE_VERSION,
        "revision": 0,
        "folders": [folder],
        "presets": [],
        "settings": {
            "defaultFolder": folder["id"],
            "autoBackup": True,
            "maxPresets": DEFAULT_MAX_PRESETS,
        },
    }


def _clean_text(value: Any, fallback: str = "") -> str:
    return str(value).strip() if value is not None else fallback


def _clean_tags(value: Any) -> list[str]:
    if isinstance(value, str):
        values = value.split(",")
    elif isinstance(value, (list, tuple, set)):
        values = value
    else:
        values = []
    result: list[str] = []
    seen: set[str] = set()
    for tag in values:
        cleaned = _clean_text(tag)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            result.append(cleaned)
    return result


def _as_int(value: Any, fallback: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _find(state: dict, collection: str, item_id: str):
    return next((item for item in state.get(collection, []) if item.get("id") == item_id), None)


def _break_folder_cycles(folders: list[dict]) -> bool:
    changed = False
    by_id = {folder["id"]: folder for folder in folders}
    for folder in folders:
        seen = {folder["id"]}
        current = folder
        while current.get("parentId"):
            parent_id = current.get("parentId")
            parent = by_id.get(parent_id)
            if parent is None or parent_id in seen:
                folder["parentId"] = None
                changed = True
                break
            seen.add(parent_id)
            current = parent
    return changed


def _normalize_state(raw: Any) -> tuple[dict[str, Any], bool]:
    source = raw if isinstance(raw, dict) else {}
    state = copy.deepcopy(source)
    changed = not isinstance(raw, dict)
    now = _now_iso()

    folders: list[dict[str, Any]] = []
    folder_ids: set[str] = set()
    for item in state.get("folders") or []:
        if not isinstance(item, dict):
            changed = True
            continue
        folder_id = _clean_text(item.get("id")) or _gen_id("folder")
        if folder_id in folder_ids:
            folder_id = _gen_id("folder")
            changed = True
        folder_ids.add(folder_id)
        folder = {
            "id": folder_id,
            "name": _clean_text(item.get("name")) or "新文件夹",
            "description": _clean_text(item.get("description")),
            "color": _clean_text(item.get("color")) or DEFAULT_FOLDER_COLOR,
            "parentId": _clean_text(item.get("parentId")) or None,
            "createdAt": _clean_text(item.get("createdAt")) or now,
            "updatedAt": _clean_text(item.get("updatedAt")) or now,
        }
        folders.append(folder)
        if folder != item:
            changed = True

    if not folders:
        folders = [_default_folder()]
        folder_ids = {folders[0]["id"]}
        changed = True
    for folder in folders:
        if folder.get("parentId") not in folder_ids:
            if folder.get("parentId") is not None:
                changed = True
            folder["parentId"] = None
    changed = _break_folder_cycles(folders) or changed

    presets: list[dict[str, Any]] = []
    preset_ids: set[str] = set()
    for index, item in enumerate(state.get("presets") or []):
        if not isinstance(item, dict):
            changed = True
            continue
        preset_id = _clean_text(item.get("id")) or _gen_id("preset")
        if preset_id in preset_ids:
            preset_id = _gen_id("preset")
            changed = True
        preset_ids.add(preset_id)
        folder_id = _clean_text(item.get("folderId")) or None
        if folder_id not in folder_ids:
            folder_id = None
        preset = {
            "id": preset_id,
            "name": _clean_text(item.get("name")) or "未命名预设",
            "type": item.get("type") if item.get("type") in PRESET_TYPES else "custom",
            "content": str(item.get("content") or ""),
            "description": _clean_text(item.get("description")),
            "tags": _clean_tags(item.get("tags")),
            "folderId": folder_id,
            "isFavorite": bool(item.get("isFavorite", False)),
            "createdAt": _clean_text(item.get("createdAt")) or now,
            "updatedAt": _clean_text(item.get("updatedAt")) or now,
            "sortOrder": _as_int(item.get("sortOrder"), index),
        }
        for optional in ("isPublic", "author"):
            if optional in item:
                preset[optional] = item[optional]
        presets.append(preset)
        if preset != item:
            changed = True

    presets.sort(key=lambda item: (item.get("sortOrder", 0), item.get("updatedAt", "")))
    for index, preset in enumerate(presets):
        if preset.get("sortOrder") != index:
            preset["sortOrder"] = index
            changed = True

    settings_in = state.get("settings") if isinstance(state.get("settings"), dict) else {}
    default_folder = settings_in.get("defaultFolder")
    if default_folder not in folder_ids:
        default_folder = folders[0]["id"]
        changed = True
    max_presets = max(0, _as_int(settings_in.get("maxPresets"), DEFAULT_MAX_PRESETS))
    # The Vue application's historical hard-coded default was 1000. Once a
    # library reached it, every create operation became permanently unusable.
    if max_presets == 1000 and len(presets) >= 1000:
        max_presets = DEFAULT_MAX_PRESETS
        changed = True
    settings = {
        "defaultFolder": default_folder,
        "autoBackup": bool(settings_in.get("autoBackup", True)),
        "maxPresets": max_presets,
    }

    normalized = {
        "version": STORE_VERSION,
        "revision": max(0, _as_int(state.get("revision"), 0)),
        "folders": folders,
        "presets": presets,
        "settings": settings,
    }
    if normalized != source:
        changed = True
    return normalized, changed


def _quarantine_corrupt_file() -> None:
    if not os.path.isfile(_DATA_FILE):
        return
    os.makedirs(_BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    shutil.copy2(_DATA_FILE, os.path.join(_BACKUP_DIR, f"presets_corrupt_{stamp}.json"))


def _ensure_state_loaded() -> dict[str, Any]:
    os.makedirs(_DATA_DIR, exist_ok=True)
    if not os.path.isfile(_DATA_FILE):
        state = _default_state()
        _write_state(state)
        return state
    try:
        with open(_DATA_FILE, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except Exception:
        _quarantine_corrupt_file()
        state = _default_state()
        _write_state(state)
        return state
    state, changed = _normalize_state(raw)
    if changed:
        _maybe_backup(state)
        _write_state(state)
    return state


def _write_state(state: dict) -> None:
    os.makedirs(_DATA_DIR, exist_ok=True)
    temp_path = f"{_DATA_FILE}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with open(temp_path, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, _DATA_FILE)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def _maybe_backup(state: dict) -> None:
    if not state.get("settings", {}).get("autoBackup", True) or not os.path.isfile(_DATA_FILE):
        return
    try:
        os.makedirs(_BACKUP_DIR, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        shutil.copy2(_DATA_FILE, os.path.join(_BACKUP_DIR, f"presets_backup_{stamp}.json"))
        backups = sorted(Path(_BACKUP_DIR).glob("presets_backup_*.json"), key=lambda path: path.stat().st_mtime)
        for old in backups[:-MAX_BACKUPS]:
            old.unlink(missing_ok=True)
    except Exception:
        pass


def _commit(state: dict) -> None:
    _maybe_backup(state)
    state["version"] = STORE_VERSION
    state["revision"] = max(0, _as_int(state.get("revision"), 0)) + 1
    _write_state(state)


def _validate_folder_id(state: dict, folder_id: Any) -> str | None:
    cleaned = _clean_text(folder_id) or None
    if cleaned and not _find(state, "folders", cleaned):
        raise ValueError("目标文件夹不存在")
    return cleaned


def _validate_parent(state: dict, folder_id: str | None, parent_id: Any) -> str | None:
    parent = _validate_folder_id(state, parent_id)
    if not parent:
        return None
    seen = {folder_id} if folder_id else set()
    current = parent
    while current:
        if current in seen:
            raise ValueError("文件夹层级不能形成循环")
        seen.add(current)
        item = _find(state, "folders", current)
        current = item.get("parentId") if item else None
    return parent


def _new_preset(state: dict, data: dict, *, preset_id: str | None = None) -> dict[str, Any]:
    now = _now_iso()
    preset = {
        "id": preset_id or _gen_id("preset"),
        "name": _clean_text(data.get("name")) or "未命名预设",
        "type": data.get("type") if data.get("type") in PRESET_TYPES else "custom",
        "content": str(data.get("content") or ""),
        "description": _clean_text(data.get("description")),
        "tags": _clean_tags(data.get("tags")),
        "folderId": _validate_folder_id(state, data.get("folderId")),
        "isFavorite": bool(data.get("isFavorite", False)),
        "createdAt": _clean_text(data.get("createdAt")) or now,
        "updatedAt": now,
        "sortOrder": len(state.get("presets", [])),
    }
    for optional in ("isPublic", "author"):
        if optional in data:
            preset[optional] = data[optional]
    return preset


def _patch_preset(state: dict, preset: dict, data: dict) -> None:
    if "name" in data:
        preset["name"] = _clean_text(data.get("name")) or "未命名预设"
    if "type" in data:
        preset["type"] = data.get("type") if data.get("type") in PRESET_TYPES else "custom"
    if "content" in data:
        preset["content"] = str(data.get("content") or "")
    if "description" in data:
        preset["description"] = _clean_text(data.get("description"))
    if "tags" in data:
        preset["tags"] = _clean_tags(data.get("tags"))
    if "folderId" in data:
        preset["folderId"] = _validate_folder_id(state, data.get("folderId"))
    if "isFavorite" in data:
        preset["isFavorite"] = bool(data.get("isFavorite"))
    for optional in ("isPublic", "author"):
        if optional in data:
            preset[optional] = data[optional]
    preset["updatedAt"] = _now_iso()


# Read API

def get_all() -> dict:
    with _LOCK:
        return copy.deepcopy(_ensure_state_loaded())


def get_revision() -> int:
    with _LOCK:
        return _as_int(_ensure_state_loaded().get("revision"), 0)


def get_preset(preset_id: str) -> dict | None:
    with _LOCK:
        preset = _find(_ensure_state_loaded(), "presets", preset_id)
        return copy.deepcopy(preset) if preset else None


def get_preset_content(preset_id: str) -> str:
    preset = get_preset(preset_id) if preset_id else None
    return preset.get("content", "") if preset else ""


def get_preset_fingerprint(preset_id: str) -> str:
    preset = get_preset(preset_id) if preset_id else None
    if not preset:
        return f"missing:{preset_id or ''}"
    payload = "\0".join((preset["id"], preset.get("updatedAt", ""), preset.get("content", "")))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# Preset mutations

def create_preset(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ValueError("预设数据必须是对象")
    with _LOCK:
        state = _ensure_state_loaded()
        max_presets = _as_int(state["settings"].get("maxPresets"), DEFAULT_MAX_PRESETS)
        if max_presets > 0 and len(state["presets"]) >= max_presets:
            raise RuntimeError(f"预设数量已达上限 ({max_presets})")
        preset = _new_preset(state, data)
        state["presets"].append(preset)
        _commit(state)
        return copy.deepcopy(preset)


def update_preset(preset_id: str, data: dict) -> dict | None:
    if not isinstance(data, dict):
        raise ValueError("预设数据必须是对象")
    with _LOCK:
        state = _ensure_state_loaded()
        preset = _find(state, "presets", preset_id)
        if not preset:
            return None
        _patch_preset(state, preset, data)
        _commit(state)
        return copy.deepcopy(preset)


def delete_preset(preset_id: str) -> bool:
    with _LOCK:
        state = _ensure_state_loaded()
        remaining = [preset for preset in state["presets"] if preset.get("id") != preset_id]
        if len(remaining) == len(state["presets"]):
            return False
        for index, preset in enumerate(remaining):
            preset["sortOrder"] = index
        state["presets"] = remaining
        _commit(state)
        return True


def toggle_favorite(preset_id: str) -> dict | None:
    with _LOCK:
        state = _ensure_state_loaded()
        preset = _find(state, "presets", preset_id)
        if not preset:
            return None
        preset["isFavorite"] = not bool(preset.get("isFavorite"))
        preset["updatedAt"] = _now_iso()
        _commit(state)
        return copy.deepcopy(preset)


def reorder_presets(ordered_ids: list[str]) -> bool:
    with _LOCK:
        state = _ensure_state_loaded()
        ids = [str(item) for item in ordered_ids]
        if not ids or len(ids) != len(set(ids)):
            return False
        by_id = {preset["id"]: preset for preset in state["presets"]}
        if any(item not in by_id for item in ids):
            return False
        selected = iter(by_id[item] for item in ids)
        id_set = set(ids)
        merged = [next(selected) if preset["id"] in id_set else preset for preset in state["presets"]]
        for index, preset in enumerate(merged):
            preset["sortOrder"] = index
        state["presets"] = merged
        _commit(state)
        return True


# Folder mutations

def create_folder(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ValueError("文件夹数据必须是对象")
    with _LOCK:
        state = _ensure_state_loaded()
        now = _now_iso()
        folder = {
            "id": _gen_id("folder"),
            "name": _clean_text(data.get("name")) or "新文件夹",
            "description": _clean_text(data.get("description")),
            "color": _clean_text(data.get("color")) or DEFAULT_FOLDER_COLOR,
            "parentId": _validate_parent(state, None, data.get("parentId")),
            "createdAt": now,
            "updatedAt": now,
        }
        state["folders"].append(folder)
        _commit(state)
        return copy.deepcopy(folder)


def update_folder(folder_id: str, data: dict) -> dict | None:
    if not isinstance(data, dict):
        raise ValueError("文件夹数据必须是对象")
    with _LOCK:
        state = _ensure_state_loaded()
        folder = _find(state, "folders", folder_id)
        if not folder:
            return None
        if "name" in data:
            folder["name"] = _clean_text(data.get("name")) or "新文件夹"
        if "description" in data:
            folder["description"] = _clean_text(data.get("description"))
        if "color" in data:
            folder["color"] = _clean_text(data.get("color")) or DEFAULT_FOLDER_COLOR
        if "parentId" in data:
            folder["parentId"] = _validate_parent(state, folder_id, data.get("parentId"))
        folder["updatedAt"] = _now_iso()
        _commit(state)
        return copy.deepcopy(folder)


def delete_folder(folder_id: str) -> bool:
    with _LOCK:
        state = _ensure_state_loaded()
        folder = _find(state, "folders", folder_id)
        if not folder:
            return False
        now = _now_iso()
        parent = folder.get("parentId")
        for preset in state["presets"]:
            if preset.get("folderId") == folder_id:
                preset["folderId"] = None
                preset["updatedAt"] = now
        for child in state["folders"]:
            if child.get("parentId") == folder_id:
                child["parentId"] = parent
                child["updatedAt"] = now
        state["folders"] = [item for item in state["folders"] if item.get("id") != folder_id]
        if state["settings"].get("defaultFolder") == folder_id:
            state["settings"]["defaultFolder"] = state["folders"][0]["id"] if state["folders"] else None
        if not state["folders"]:
            replacement = _default_folder()
            state["folders"].append(replacement)
            state["settings"]["defaultFolder"] = replacement["id"]
        _commit(state)
        return True


# Vue-compatible import/export

def _build_bundle(folders: list[dict], presets: list[dict], settings: dict) -> dict:
    folders_copy = copy.deepcopy(folders)
    presets_copy = copy.deepcopy(presets)
    management = {
        "folders": copy.deepcopy(folders_copy),
        "presets": copy.deepcopy(presets_copy),
        "settings": copy.deepcopy(settings),
    }
    return {
        "version": BUNDLE_VERSION,
        "type": "presets",
        "savedAt": _now_iso(),
        "extendedPresets": presets_copy,
        "presetFolders": folders_copy,
        "presetManagement": management,
        "presets": [],
    }


def _folder_ancestors(state: dict, folder_ids: set[str]) -> set[str]:
    result = set(folder_ids)
    pending = list(folder_ids)
    while pending:
        folder = _find(state, "folders", pending.pop())
        parent = folder.get("parentId") if folder else None
        if parent and parent not in result:
            result.add(parent)
            pending.append(parent)
    return result


def export_all() -> dict:
    with _LOCK:
        state = _ensure_state_loaded()
        return _build_bundle(state["folders"], state["presets"], state["settings"])


def export_folder(folder_id: str) -> dict | None:
    with _LOCK:
        state = _ensure_state_loaded()
        if not _find(state, "folders", folder_id):
            return None
        selected: set[str] = set()
        pending = [folder_id]
        while pending:
            current = pending.pop()
            if current in selected:
                continue
            selected.add(current)
            pending.extend(item["id"] for item in state["folders"] if item.get("parentId") == current)
        included = _folder_ancestors(state, selected)
        folders = [item for item in state["folders"] if item["id"] in included]
        presets = [item for item in state["presets"] if item.get("folderId") in selected]
        return _build_bundle(folders, presets, state["settings"])


def export_preset(preset_id: str) -> dict | None:
    with _LOCK:
        state = _ensure_state_loaded()
        preset = _find(state, "presets", preset_id)
        if not preset:
            return None
        folder_ids = _folder_ancestors(state, {preset["folderId"]}) if preset.get("folderId") else set()
        folders = [item for item in state["folders"] if item["id"] in folder_ids]
        return _build_bundle(folders, [preset], state["settings"])


def export_presets(preset_ids: list[str]) -> dict:
    with _LOCK:
        state = _ensure_state_loaded()
        selected = set(preset_ids)
        presets = [item for item in state["presets"] if item["id"] in selected]
        folder_ids = {item["folderId"] for item in presets if item.get("folderId")}
        included = _folder_ancestors(state, folder_ids)
        folders = [item for item in state["folders"] if item["id"] in included]
        return _build_bundle(folders, presets, state["settings"])


def _folder_path(folder: dict, incoming_by_id: dict[str, dict]) -> tuple[str, ...]:
    names: list[str] = []
    seen: set[str] = set()
    current = folder
    while current:
        folder_id = _clean_text(current.get("id"))
        if folder_id in seen:
            break
        seen.add(folder_id)
        names.append(_clean_text(current.get("name")) or "新文件夹")
        current = incoming_by_id.get(_clean_text(current.get("parentId")))
    return tuple(reversed(names))


def _existing_folder_paths(state: dict) -> dict[tuple[str, ...], dict]:
    by_id = {item["id"]: item for item in state["folders"]}
    return {_folder_path(item, by_id): item for item in state["folders"]}


def _bundle_collections(bundle: dict) -> tuple[list[dict], list[dict], list[dict]]:
    management = bundle.get("presetManagement") if isinstance(bundle.get("presetManagement"), dict) else {}
    folders = bundle.get("presetFolders")
    if folders is None:
        folders = bundle.get("folders")
    if folders is None:
        folders = management.get("folders")
    presets = bundle.get("extendedPresets")
    if presets is None:
        presets = management.get("presets")
    legacy = bundle.get("presets")
    return (
        [item for item in (folders or []) if isinstance(item, dict)],
        [item for item in (presets or []) if isinstance(item, dict)],
        [item for item in (legacy or []) if isinstance(item, dict)],
    )


def import_bundle(bundle: dict) -> dict:
    if not isinstance(bundle, dict):
        raise ValueError("导入文件必须是 JSON 对象")
    incoming_folders, incoming_presets, legacy_presets = _bundle_collections(bundle)
    if not incoming_folders and not incoming_presets and not legacy_presets:
        raise ValueError("文件中没有可导入的预设")

    with _LOCK:
        state = _ensure_state_loaded()
        incoming_by_id = {_clean_text(item.get("id")): item for item in incoming_folders if item.get("id")}
        existing_by_id = {item["id"]: item for item in state["folders"]}
        existing_by_path = _existing_folder_paths(state)
        id_map: dict[str, str] = {}

        for folder in incoming_folders:
            old_id = _clean_text(folder.get("id")) or _gen_id("import_folder")
            path = _folder_path(folder, incoming_by_id)
            match = existing_by_id.get(old_id) or existing_by_path.get(path)
            id_map[old_id] = match["id"] if match else _gen_id("folder")

        for folder in sorted(incoming_folders, key=lambda item: len(_folder_path(item, incoming_by_id))):
            old_id = _clean_text(folder.get("id"))
            if not old_id:
                continue
            target_id = id_map[old_id]
            parent_old = _clean_text(folder.get("parentId"))
            parent_new = id_map.get(parent_old) if parent_old else None
            existing = _find(state, "folders", target_id)
            if existing:
                existing["name"] = _clean_text(folder.get("name")) or existing["name"]
                if "description" in folder:
                    existing["description"] = _clean_text(folder.get("description"))
                if "color" in folder:
                    existing["color"] = _clean_text(folder.get("color")) or DEFAULT_FOLDER_COLOR
                existing["parentId"] = _validate_parent(state, existing["id"], parent_new)
                existing["updatedAt"] = _now_iso()
            else:
                now = _now_iso()
                state["folders"].append({
                    "id": target_id,
                    "name": _clean_text(folder.get("name")) or "新文件夹",
                    "description": _clean_text(folder.get("description")),
                    "color": _clean_text(folder.get("color")) or DEFAULT_FOLDER_COLOR,
                    "parentId": parent_new,
                    "createdAt": _clean_text(folder.get("createdAt")) or now,
                    "updatedAt": now,
                })

        existing_preset_by_id = {item["id"]: item for item in state["presets"]}
        existing_preset_by_key = {(item["name"], item["type"]): item for item in state["presets"]}
        added = 0
        updated = 0
        max_presets = _as_int(state["settings"].get("maxPresets"), DEFAULT_MAX_PRESETS)

        for incoming in incoming_presets:
            name = _clean_text(incoming.get("name")) or "未命名预设"
            preset_type = incoming.get("type") if incoming.get("type") in PRESET_TYPES else "custom"
            incoming_id = _clean_text(incoming.get("id"))
            existing = existing_preset_by_id.get(incoming_id) or existing_preset_by_key.get((name, preset_type))
            payload = dict(incoming)
            payload["name"] = name
            payload["type"] = preset_type
            if "folderId" in incoming:
                payload["folderId"] = id_map.get(_clean_text(incoming.get("folderId")))
            if existing:
                _patch_preset(state, existing, payload)
                existing_preset_by_key[(existing["name"], existing["type"])] = existing
                updated += 1
            else:
                if max_presets > 0 and len(state["presets"]) >= max_presets:
                    raise RuntimeError(f"预设数量已达上限 ({max_presets})")
                created = _new_preset(state, payload)
                state["presets"].append(created)
                existing_preset_by_id[created["id"]] = created
                existing_preset_by_key[(created["name"], created["type"])] = created
                added += 1

        for legacy in legacy_presets:
            if "name" not in legacy or "text" not in legacy or "content" in legacy:
                continue
            name = _clean_text(legacy.get("name")) or "未命名预设"
            key = (name, "positive")
            if key in existing_preset_by_key:
                continue
            if max_presets > 0 and len(state["presets"]) >= max_presets:
                raise RuntimeError(f"预设数量已达上限 ({max_presets})")
            created = _new_preset(state, {
                "name": name,
                "type": "positive",
                "content": str(legacy.get("text") or ""),
                "description": "从旧格式导入",
                "createdAt": legacy.get("updatedAt"),
            })
            state["presets"].append(created)
            existing_preset_by_key[key] = created
            added += 1

        for index, preset in enumerate(state["presets"]):
            preset["sortOrder"] = index
        _commit(state)
        return {"added": added, "updated": updated}


def update_settings(patch: dict) -> dict:
    if not isinstance(patch, dict):
        raise ValueError("设置必须是对象")
    with _LOCK:
        state = _ensure_state_loaded()
        settings = state["settings"]
        if "defaultFolder" in patch:
            settings["defaultFolder"] = _validate_folder_id(state, patch.get("defaultFolder"))
        if "autoBackup" in patch:
            settings["autoBackup"] = bool(patch.get("autoBackup"))
        if "maxPresets" in patch:
            value = _as_int(patch.get("maxPresets"), DEFAULT_MAX_PRESETS)
            if value < 0:
                raise ValueError("预设上限不能小于 0")
            settings["maxPresets"] = value
        _commit(state)
        return copy.deepcopy(settings)
