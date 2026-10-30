"""Isolated UI/integration fixture: python tests/history_preview_server.py.

Uses temporary data and actual plugin routes/modules. Never loads user presets.
"""
import importlib.util
import sys
import tempfile
import types
from pathlib import Path

from aiohttp import web

ROOT = Path(__file__).resolve().parents[1]
package = types.ModuleType("ppm_preview")
package.__path__ = [str(ROOT)]
sys.modules[package.__name__] = package
from ppm_preview import storage, nodes, server_routes  # noqa: E402

temporary = tempfile.TemporaryDirectory(prefix="ppm-history-preview-")
storage._DATA_DIR = str(Path(temporary.name) / "data")
storage._DATA_FILE = str(Path(storage._DATA_DIR) / "presets.json")
storage._BACKUP_DIR = str(Path(temporary.name) / "backups")
storage.create_preset({"name": "柔光人像", "content": "soft light, portrait, natural skin texture", "type": "positive"})
storage.create_preset({"name": "夜景风格", "content": "city at night, cinematic, rainy streets", "type": "style"})
for index, content in enumerate(["未保存的最初草稿\n{red|blue}", "portrait, soft light", "portrait, soft light, silver hair", "portrait, soft light, silver hair, window light"]):
    storage.record_text_history({"content": content, "name": "柔光人像", "type": "positive"},
                                scope="preview-node", source="draft" if index == 0 else "external")

app = web.Application(client_max_size=32 * 1024 * 1024)
routes = web.RouteTableDef()
mock_server = types.ModuleType("server")
mock_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes, app=app))
sys.modules["server"] = mock_server
server_routes.register_routes()


@routes.get("/")
async def preview(request):
    return web.FileResponse(ROOT / "tests" / "history_preview.html")


@routes.get("/scripts/api.js")
async def api_stub(request):
    return web.Response(text="export const api = { fetchApi: (...args) => fetch(...args) };", content_type="text/javascript")


@routes.get("/scripts/app.js")
async def app_stub(request):
    return web.Response(text="export const app = window.previewApp;", content_type="text/javascript")


@routes.post("/preview/run")
async def external(request):
    data = await request.json()
    result = nodes.PromptPresetManager().get_text(data["properties"].get("promptPresetText", ""), data["text"],
        unique_id="1", extra_pnginfo={"workflow": {"nodes": [{"id": 1, "properties": data["properties"]}]}})
    return web.json_response(result["ui"])


app.add_routes(routes)
app.router.add_static("/extensions/ppm/", ROOT / "web")
if __name__ == "__main__":
    web.run_app(app, host="127.0.0.1", port=8195)
