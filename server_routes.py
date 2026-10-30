"""HTTP routes used by the PromptPresetManager frontend."""

from __future__ import annotations

import json
import logging
import asyncio
from contextlib import suppress

from . import storage, history_store

logger = logging.getLogger(__name__)

ROUTE_PREFIX = "/promptpreset"
_REGISTERED_FLAG = "_promptpreset_routes_registered"
MAX_IMPORT_BYTES = 32 * 1024 * 1024


def register_routes() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:  # pragma: no cover - ComfyUI is not available in unit tests
        return

    instance = getattr(PromptServer, "instance", None)
    if instance is None or not hasattr(instance, "routes"):
        return
    if getattr(instance, _REGISTERED_FLAG, False):
        return

    routes = instance.routes

    async def read_object(request):  # noqa: ANN001
        try:
            data = await request.json()
        except Exception as exc:
            raise web.HTTPBadRequest(text=json.dumps({"ok": False, "error": "请求不是有效的 JSON"}, ensure_ascii=False), content_type="application/json") from exc
        if not isinstance(data, dict):
            raise web.HTTPBadRequest(text=json.dumps({"ok": False, "error": "请求内容必须是对象"}, ensure_ascii=False), content_type="application/json")
        return data

    def success(**payload):
        return web.json_response({"ok": True, "revision": storage.get_revision(), **payload})

    def failure(message: str, status: int):
        return web.json_response({"ok": False, "error": message}, status=status)

    @routes.get(f"{ROUTE_PREFIX}/history")
    async def get_history(request):
        try:
            q = request.rel_url.query
            await asyncio.to_thread(storage.cleanup_history)
            result = await asyncio.to_thread(history_store.list_entries, storage.history_path(),
                scope=q.get("scope", ""), preset_id=q.get("presetId", ""), kind=q.get("kind", ""),
                query=q.get("query", "")[:500], source=q.get("source", ""),
                trash=q.get("trash") == "true", page=int(q.get("page", "1")))
            return web.json_response({"ok": True, **result})
        except Exception as exc:
            return failure(str(exc), 500)

    @routes.get(f"{ROUTE_PREFIX}/history/entry")
    async def history_entry(request):
        entry = await asyncio.to_thread(history_store.get, storage.history_path(), request.rel_url.query.get("id", ""))
        return web.json_response({"ok": True, "entry": entry}) if entry else failure("历史已过期或已删除", 404)

    @routes.post(f"{ROUTE_PREFIX}/history/capture")
    async def capture_history(request):
        data = await read_object(request)
        try:
            receipt = data.get("receiptId")
            existing = await asyncio.to_thread(history_store.get, storage.history_path(), receipt) if receipt else None
            if existing and existing["deleted"] is None and existing["scope"] == str(data.get("scope", "")):
                return web.json_response({"ok": True, "id": existing["id"]})
            if data.get("source", "draft") not in ("draft", "restore", "external", "checkpoint", "switch"):
                raise ValueError("无效的记录来源")
            entry_id = await asyncio.to_thread(storage.record_text_history, data.get("snapshot", {}),
                scope=str(data.get("scope", ""))[:200], source=data.get("source", "draft"),
                event_key=str(data["eventKey"])[:200] if data.get("eventKey") else None,
                checkpoint=bool(data.get("checkpoint")))
            return web.json_response({"ok": True, "id": entry_id})
        except Exception as exc:
            return failure(str(exc), 500)

    @routes.post(f"{ROUTE_PREFIX}/history/manage")
    async def manage_history(request):
        data = await read_object(request)
        try:
            def manage_records():
                ids, action = data.get("ids"), data.get("action")
                if not isinstance(ids, list) or len(ids) > 1000:
                    raise ValueError("无效的历史管理操作")
                if action != "restore":
                    return history_store.manage(storage.history_path(), ids, action, data.get("note", ""))
                for entry_id in ids:
                    entry = history_store.get(storage.history_path(), entry_id)
                    if entry and entry["source"] == "deleted":
                        storage.restore_deleted_preset_history(entry_id)
                    else:
                        history_store.manage(storage.history_path(), [entry_id], "restore")
            await asyncio.to_thread(manage_records)
            return web.json_response({"ok": True})
        except ValueError as exc:
            return failure(str(exc), 400)
        except Exception as exc:
            return failure(str(exc), 500)

    @routes.post(f"{ROUTE_PREFIX}/history/settings")
    async def history_settings(request):
        data = await read_object(request)
        try:
            days = await asyncio.to_thread(history_store.settings, storage.history_path(), data.get("retentionDays"))
            return web.json_response({"ok": True, "retentionDays": days})
        except ValueError as exc:
            return failure(str(exc), 400)

    @routes.post(f"{ROUTE_PREFIX}/history/restore-preset")
    async def restore_history(request):
        data = await read_object(request)
        try:
            preset = await asyncio.to_thread(storage.restore_preset_history, data.get("id", ""), data.get("expectedUpdatedAt"))
            return success(preset=preset)
        except ValueError as exc:
            return failure(str(exc), 409)
        except Exception as exc:
            return failure(str(exc), 500)

    async def history_maintenance(app):
        async def cleanup():
            while True:
                try:
                    if storage.os.path.isfile(storage.history_path()):
                        await asyncio.to_thread(storage.cleanup_history)
                except Exception:
                    logger.exception("PromptPresetManager history cleanup failed")
                await asyncio.sleep(3600)
        task = asyncio.create_task(cleanup())
        yield
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    if hasattr(instance, "app"):
        instance.app.cleanup_ctx.append(history_maintenance)

    @routes.get(f"{ROUTE_PREFIX}/all")
    async def get_all(request):  # noqa: ANN001
        try:
            data = storage.get_all()
            return web.json_response({"ok": True, "revision": data.get("revision", 0), "data": data})
        except Exception as exc:  # noqa: BLE001
            logger.exception("PromptPresetManager: get_all failed")
            return failure(str(exc), 500)

    @routes.get(f"{ROUTE_PREFIX}/revision")
    async def get_revision(request):  # noqa: ANN001
        try:
            return web.json_response({"ok": True, "revision": storage.get_revision()})
        except Exception as exc:  # noqa: BLE001
            logger.exception("PromptPresetManager: get_revision failed")
            return failure(str(exc), 500)

    @routes.get(f"{ROUTE_PREFIX}/content")
    async def get_content(request):  # noqa: ANN001
        preset_id = request.rel_url.query.get("id", "")
        preset = storage.get_preset(preset_id)
        if not preset:
            return failure("预设不存在", 404)
        return web.json_response({"ok": True, "content": preset.get("content", "")})

    @routes.post(f"{ROUTE_PREFIX}/preset")
    async def upsert_preset(request):  # noqa: ANN001
        data = await read_object(request)
        try:
            if data.get("id"):
                preset = storage.update_preset(data["id"], data)
                if preset is None:
                    return failure("预设不存在", 404)
            else:
                preset = storage.create_preset(data)
            return success(preset=preset)
        except (ValueError, RuntimeError) as exc:
            return failure(str(exc), 409)
        except Exception as exc:  # noqa: BLE001
            logger.exception("PromptPresetManager: upsert_preset failed")
            return failure(str(exc), 500)

    @routes.post(f"{ROUTE_PREFIX}/preset/delete")
    async def delete_preset(request):  # noqa: ANN001
        data = await read_object(request)
        try:
            if not storage.delete_preset(data.get("id", "")):
                return failure("预设不存在", 404)
            return success()
        except Exception as exc:
            logger.exception("PromptPresetManager: delete_preset failed")
            return failure(str(exc), 500)

    @routes.post(f"{ROUTE_PREFIX}/preset/favorite")
    async def favorite_preset(request):  # noqa: ANN001
        data = await read_object(request)
        preset = storage.toggle_favorite(data.get("id", ""))
        if preset is None:
            return failure("预设不存在", 404)
        return success(preset=preset)

    @routes.post(f"{ROUTE_PREFIX}/preset/reorder")
    async def reorder(request):  # noqa: ANN001
        data = await read_object(request)
        ordered_ids = data.get("orderedIds")
        if not isinstance(ordered_ids, list):
            return failure("orderedIds 必须是数组", 400)
        if not storage.reorder_presets(ordered_ids):
            return failure("排序列表无效", 409)
        return success()

    @routes.post(f"{ROUTE_PREFIX}/folder")
    async def upsert_folder(request):  # noqa: ANN001
        data = await read_object(request)
        try:
            if data.get("id"):
                folder = storage.update_folder(data["id"], data)
                if folder is None:
                    return failure("文件夹不存在", 404)
            else:
                folder = storage.create_folder(data)
            return success(folder=folder)
        except ValueError as exc:
            return failure(str(exc), 409)
        except Exception as exc:  # noqa: BLE001
            logger.exception("PromptPresetManager: upsert_folder failed")
            return failure(str(exc), 500)

    @routes.post(f"{ROUTE_PREFIX}/folder/delete")
    async def delete_folder(request):  # noqa: ANN001
        data = await read_object(request)
        if not storage.delete_folder(data.get("id", "")):
            return failure("文件夹不存在", 404)
        return success()

    @routes.post(f"{ROUTE_PREFIX}/settings")
    async def patch_settings(request):  # noqa: ANN001
        data = await read_object(request)
        try:
            return success(settings=storage.update_settings(data))
        except ValueError as exc:
            return failure(str(exc), 400)

    @routes.get(f"{ROUTE_PREFIX}/export/all")
    async def export_all(request):  # noqa: ANN001
        return web.json_response(storage.export_all())

    @routes.get(f"{ROUTE_PREFIX}/export/folder")
    async def export_folder(request):  # noqa: ANN001
        bundle = storage.export_folder(request.rel_url.query.get("id", ""))
        return web.json_response(bundle) if bundle else failure("文件夹不存在", 404)

    @routes.get(f"{ROUTE_PREFIX}/export/preset")
    async def export_preset(request):  # noqa: ANN001
        bundle = storage.export_preset(request.rel_url.query.get("id", ""))
        return web.json_response(bundle) if bundle else failure("预设不存在", 404)

    @routes.post(f"{ROUTE_PREFIX}/export/selection")
    async def export_selection(request):  # noqa: ANN001
        data = await read_object(request)
        preset_ids = data.get("ids")
        if not isinstance(preset_ids, list):
            return failure("ids 必须是数组", 400)
        return web.json_response(storage.export_presets(preset_ids))

    @routes.post(f"{ROUTE_PREFIX}/import")
    async def import_bundle(request):  # noqa: ANN001
        if request.content_length and request.content_length > MAX_IMPORT_BYTES:
            return failure("导入文件不能超过 32 MB", 413)
        data = await read_object(request)
        try:
            return success(**storage.import_bundle(data))
        except ValueError as exc:
            return failure(str(exc), 400)
        except Exception as exc:  # noqa: BLE001
            logger.exception("PromptPresetManager: import failed")
            return failure(str(exc), 500)

    @routes.post(f"{ROUTE_PREFIX}/import/file")
    async def import_file(request):  # noqa: ANN001
        if request.content_length and request.content_length > MAX_IMPORT_BYTES:
            return failure("导入文件不能超过 32 MB", 413)
        try:
            reader = await request.multipart()
            part = await reader.next()
            if part is None:
                return failure("没有收到导入文件", 400)
            raw = await part.read(decode=True)
            if len(raw) > MAX_IMPORT_BYTES:
                return failure("导入文件不能超过 32 MB", 413)
            data = json.loads(raw.decode("utf-8-sig"))
            if not isinstance(data, dict):
                return failure("导入文件内容必须是对象", 400)
            return success(**storage.import_bundle(data))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return failure(f"解析导入文件失败: {exc}", 400)
        except ValueError as exc:
            return failure(str(exc), 400)
        except Exception as exc:  # noqa: BLE001
            logger.exception("PromptPresetManager: import file failed")
            return failure(str(exc), 500)

    setattr(instance, _REGISTERED_FLAG, True)
