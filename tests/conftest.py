from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_NAME = "prompt_preset_manager_under_test"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


package = types.ModuleType(PACKAGE_NAME)
package.__path__ = [str(PLUGIN_ROOT)]
sys.modules[PACKAGE_NAME] = package
storage = _load_module(f"{PACKAGE_NAME}.storage", PLUGIN_ROOT / "storage.py")
nodes = _load_module(f"{PACKAGE_NAME}.nodes", PLUGIN_ROOT / "nodes.py")


@pytest.fixture()
def isolated_store(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    backup_dir = tmp_path / "backups"
    monkeypatch.setattr(storage, "_DATA_DIR", str(data_dir))
    monkeypatch.setattr(storage, "_DATA_FILE", str(data_dir / "presets.json"))
    monkeypatch.setattr(storage, "_BACKUP_DIR", str(backup_dir))
    storage._write_state(storage._default_state())
    return storage


@pytest.fixture()
def node_module():
    return nodes
