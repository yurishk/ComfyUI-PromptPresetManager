"""PromptPresetManager ComfyUI node.

A text-output node with a native editable prompt widget. Preset metadata is
managed by the frontend and serialized in node properties.
"""

from __future__ import annotations

import hashlib

CATEGORY = "text/presets"
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
                        "tooltip": "Editable prompt content with native ComfyUI dynamic prompt support.",
                    },
                ),
            },
            "optional": {
                "text": (
                    "STRING",
                    {
                        "forceInput": True,
                        "tooltip": "Optional external text. Non-empty input replaces the editable prompt after execution.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_NODE = True
    FUNCTION = "get_text"
    CATEGORY = CATEGORY
    DESCRIPTION = "Manage shared prompt presets and optionally capture non-empty text from an upstream node."
    OUTPUT_TOOLTIPS = ("External text when non-empty; otherwise the editable local prompt.",)

    @classmethod
    def IS_CHANGED(
        cls,
        prompt_text: str = "",
        text: str | None = None,
    ):
        """Invalidate cache whenever either local or external text changes."""
        fingerprint = f"{prompt_text}\0{text if text is not None else ''}"
        digest = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
        return f"text:{digest}"

    def get_text(
        self,
        prompt_text: str = "",
        text: str | None = None,
    ):
        external_text = "" if text is None else str(text)
        if external_text != "":
            return {
                "ui": {"external_text": [external_text]},
                "result": (external_text,),
            }
        return (str(prompt_text),)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: PromptPresetManager,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "Prompt Preset Manager",
}
