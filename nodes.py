"""PromptPresetManager ComfyUI node.

A text-output node with a native editable prompt widget. Preset metadata is
managed by the frontend and serialized in node properties.
"""

from __future__ import annotations

import hashlib

CATEGORY = "预设管理"
NODE_NAME = "PromptPresetManager"

class PromptPresetManager:
    """Output editable prompt text backed by the shared preset library."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt_text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": True,
                        "tooltip": "可直接编辑的提示词内容。支持 ComfyUI 原生文本框及动态提示词功能。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "get_text"
    CATEGORY = CATEGORY
    DESCRIPTION = "从全局预设库载入提示词，并允许在节点原生文本框中直接编辑后输出。"
    OUTPUT_TOOLTIPS = ("当前选中预设的文本内容",)

    @classmethod
    def IS_CHANGED(
        cls,
        prompt_text: str = "",
    ):
        """Invalidate cache whenever the native prompt text changes."""
        digest = hashlib.sha256(str(prompt_text).encode("utf-8")).hexdigest()
        return f"native:{digest}"

    def get_text(
        self,
        prompt_text: str = "",
    ):
        return (str(prompt_text),)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: PromptPresetManager,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "预设管理器",
}
