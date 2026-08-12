"""Prompt Preset Manager for ComfyUI.

The node provides a shared file-backed prompt library with folders, favorites,
search, sorting, import/export, and workflow-safe local drafts.
"""

import logging

logger = logging.getLogger(__name__)

if __package__:
    from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
else:  # Allows tools such as pytest to inspect a hyphenated plugin directory.
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}

WEB_DIRECTORY = "./web"

# Register API routes when loaded by a running ComfyUI server.
if __package__:
    try:
        from .server_routes import register_routes

        register_routes()
    except Exception:  # pragma: no cover
        logger.exception("PromptPresetManager backend route registration failed")

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
