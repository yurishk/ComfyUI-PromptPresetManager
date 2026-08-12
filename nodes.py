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
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "get_text"
    CATEGORY = CATEGORY
    DESCRIPTION = "Load prompts from a shared preset library, edit them in the node, and output text."
    OUTPUT_TOOLTIPS = ("Text from the selected preset or the current local draft.",)

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
    NODE_NAME: "Prompt Preset Manager",
}
