"""PromptPresetManager - ComfyUI 预设管理插件

带前端的预设管理节点：
- 全局共享的提示词存储库（本地文件存储，非浏览器 storage）
- 支持文件夹、收藏、检索、排序
- 节点输出选中的预设文本，复制节点时携带当前选择
- 导入/导出格式与独立 Vue 前端（prompt）兼容
"""

import logging

logger = logging.getLogger(__name__)

if __package__:
    from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
else:  # Allows tools such as pytest to inspect a hyphenated plugin directory.
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}

WEB_DIRECTORY = "./web"

# 注册后端 API 路由（无 server 的测试环境静默跳过）
if __package__:
    try:
        from .server_routes import register_routes

        register_routes()
    except Exception:  # pragma: no cover
        logger.exception("PromptPresetManager 后端路由注册失败")

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
