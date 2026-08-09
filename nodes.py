"""PromptPresetManager ComfyUI node.

A text-output node backed by a global, on-disk preset repository. Each node
instance remembers which preset it has selected (the ``preset_id`` widget, which
is serialized so duplicating a node carries the selection over). At execution
time the node looks the preset content up from the shared store, so editing a
preset propagates to every node referencing it.
"""

from __future__ import annotations

import logging
import os

from . import storage

CATEGORY = "预设管理"
NODE_NAME = "PromptPresetManager"

logger = logging.getLogger(__name__)


class PromptPresetManager:
    """Output a preset's text content from the shared store."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preset_id": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "当前选中的预设 ID。由节点面板管理，复制节点时会一同复制。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "get_text"
    CATEGORY = CATEGORY
    DESCRIPTION = "从全局共享的预设库中读取一条预设并输出为文本。"
    OUTPUT_TOOLTIPS = ("当前选中预设的文本内容",)

    @classmethod
    def IS_CHANGED(cls, preset_id: str = ""):
        """Invalidate ComfyUI's node cache when shared preset content changes."""
        return storage.get_preset_fingerprint(preset_id)

    def get_text(self, preset_id: str = ""):
        content = ""
        if preset_id:
            try:
                content = storage.get_preset_content(preset_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning("PromptPresetManager 读取预设 %s 失败: %s", preset_id, exc)
                content = ""
        return (content,)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: PromptPresetManager,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "预设管理器",
}
