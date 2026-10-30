"""PromptPresetManager ComfyUI node.

A text-output node with a native editable prompt widget. Preset metadata is
managed by the frontend and serialized in node properties.
"""

from __future__ import annotations

import hashlib
import logging
import uuid

from . import storage

logger = logging.getLogger(__name__)

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
            "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"},
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
        **kwargs,
    ):
        """Invalidate cache whenever either local or external text changes."""
        fingerprint = f"{prompt_text}\0{text if text is not None else ''}"
        digest = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
        return f"text:{digest}"

    def get_text(
        self,
        prompt_text: str = "",
        text: str | None = None,
        unique_id=None,
        extra_pnginfo=None,
    ):
        external_text = "" if text is None else str(text)
        if external_text != "":
            properties = {}
            workflow = (extra_pnginfo or {}).get("workflow", {})
            for node in workflow.get("nodes", []):
                if str(node.get("id")) == str(unique_id):
                    properties = node.get("properties") or {}
                    break
            scope = str(properties.get("promptPresetHistoryScope") or f"api:{unique_id or 'unlinked'}")
            context = None
            try:
                from comfy_execution.utils import get_executing_context
                context = get_executing_context()
            except ImportError:
                pass
            run_key = f"{context.prompt_id}:{unique_id}:{context.list_index}" if context else uuid.uuid4().hex
            snapshot = {**(properties.get("promptPresetDraft") or {}), "content": external_text,
                        "presetId": properties.get("promptPresetId") or ""}
            history_id, error = "", ""
            try:
                # The editor's original text may differ from dynamic prompt
                # expansion in prompt_text; preserve the workflow property.
                baseline = {**snapshot, "content": str(properties.get("promptPresetText", prompt_text))}
                storage.record_text_history(baseline, scope=scope, source="queued", event_key="queued:" + run_key)
                history_id = storage.record_text_history(snapshot, scope=scope, source="external", event_key="external:" + run_key)
            except Exception as exc:
                error = str(exc)
                logger.exception("PromptPresetManager: could not preserve external text")
            return {
                "ui": {"external_text": [external_text], "history_id": [history_id], "history_error": [error]},
                "result": (external_text,),
            }
        return (str(prompt_text),)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: PromptPresetManager,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "Prompt Preset Manager",
}
