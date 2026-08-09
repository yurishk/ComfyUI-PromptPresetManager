"""HTTP routes used by the PromptPresetManager frontend."""

from __future__ import annotations

import json
import logging

from . import storage

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
        if not storage.delete_preset(data.get("id", "")):
            return failure("预设不存在", 404)
        return success()

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
