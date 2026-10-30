"""Local, expiring recovery history. No third-party dependencies."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

DEFAULT_RETENTION_DAYS = 30
EDIT_FIELDS = ("name", "type", "content", "folderId", "tags", "description")


@contextmanager
def _connect(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=15)
    db.row_factory = sqlite3.Row
    try:
        db.executescript("""
            PRAGMA auto_vacuum = INCREMENTAL;
            CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS snapshots (hash TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS entries (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                kind TEXT NOT NULL, source TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
                preset_id TEXT NOT NULL DEFAULT '', created REAL NOT NULL,
                snapshot TEXT NOT NULL, event_key TEXT UNIQUE, deleted REAL, note TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS history_scope ON entries(scope, created);
            CREATE INDEX IF NOT EXISTS history_preset ON entries(preset_id, created);
            CREATE INDEX IF NOT EXISTS history_age ON entries(created);
        """)
        # Serialize cleanup + writes across threads and other ComfyUI processes.
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT value FROM config WHERE key='retentionDays'").fetchone()
        days = row[0] if row else DEFAULT_RETENTION_DAYS
        now = time.time()
        db.execute("DELETE FROM entries WHERE created < ? OR deleted < ?",
                   (now - days * 86400, now - min(days, 7) * 86400))
        yield db
        db.execute("DELETE FROM snapshots WHERE hash NOT IN (SELECT snapshot FROM entries)")
        db.commit()
        db.execute("PRAGMA incremental_vacuum(128)")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def _snapshot(db, value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    db.execute("INSERT OR IGNORE INTO snapshots VALUES (?, ?)", (digest, raw))
    return digest


def append(path, snapshot, *, kind="text", source="draft", scope="", preset_id="", event_key=None):
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("content", ""), str):
        raise ValueError("历史内容必须是文本对象")
    if kind not in ("text", "preset", "checkpoint"):
        raise ValueError("无效的历史类型")
    # Keep only recoverable fields, plus the original association.
    tags = snapshot.get("tags", snapshot.get("tagsText", []))
    if isinstance(tags, str):
        tags = [tag.strip() for tag in tags.split(",") if tag.strip()]
    if not isinstance(tags, list):
        raise ValueError("历史标签必须是数组或逗号分隔的文本")
    value = {"name": str(snapshot.get("name") or ""), "type": snapshot.get("type") or "positive",
             "content": snapshot.get("content", ""), "folderId": snapshot.get("folderId") or None,
             "tags": tags, "description": str(snapshot.get("description") or ""),
             "presetId": snapshot.get("presetId") or ""}
    if kind == "preset":
        value["updatedAt"] = snapshot.get("updatedAt", "")
        for key in ("createdAt", "isFavorite", "isPublic", "author"):
            if key in snapshot:
                value[key] = snapshot[key]
    with _connect(path) as db:
        digest = _snapshot(db, value)
        # Boundary protection need not duplicate a state that is already safe.
        # Actual external executions and explicit restores always keep events.
        if source in ("draft", "queued"):
            existing = db.execute("SELECT id FROM entries WHERE scope=? AND snapshot=? AND deleted IS NULL ORDER BY seq DESC LIMIT 1",
                                  (scope, digest)).fetchone()
            if existing:
                return existing[0]
        if kind == "checkpoint":
            event_key = "checkpoint:" + scope
            existing = db.execute("SELECT id FROM entries WHERE event_key=? AND deleted IS NULL", (event_key,)).fetchone()
            if existing:
                db.execute("UPDATE entries SET snapshot=?, created=?, preset_id=?, deleted=NULL WHERE id=?",
                           (digest, time.time(), preset_id, existing[0]))
                return existing[0]
        if event_key:
            existing = db.execute("SELECT id,deleted FROM entries WHERE event_key=?", (event_key,)).fetchone()
            if existing:
                if existing[1] is None:
                    return existing[0]
                db.execute("UPDATE entries SET event_key=NULL WHERE id=?", (existing[0],))
        entry_id = uuid.uuid4().hex
        db.execute("INSERT INTO entries(id,kind,source,scope,preset_id,created,snapshot,event_key) VALUES(?,?,?,?,?,?,?,?)",
                   (entry_id, kind, source, str(scope), str(preset_id), time.time(), digest, event_key))
        return entry_id


def _decode(row, full=True):
    result = dict(row)
    value = json.loads(result.pop("value"))
    result["snapshot"] = value if full else {key: val for key, val in value.items() if key != "content"}
    result["preview"] = value.get("content", "")[:180]
    result["length"] = len(value.get("content", ""))
    return result


def get(path, entry_id):
    with _connect(path) as db:
        row = db.execute("SELECT e.*, s.value FROM entries e JOIN snapshots s ON s.hash=e.snapshot WHERE e.id=?",
                         (entry_id,)).fetchone()
        return _decode(row) if row else None


def list_entries(path, *, scope="", preset_id="", kind="", query="", source="", trash=False, page=1):
    where, args = ["e.deleted IS NOT NULL" if trash else "e.deleted IS NULL"], []
    for column, value in (("scope", scope), ("preset_id", preset_id), ("source", source)):
        if value:
            where.append(f"e.{column}=?")
            args.append(value)
    if kind == "text":
        where.append("e.kind IN ('text','checkpoint')")
    elif kind == "preset":
        where.append("e.kind='preset'")
    if query:
        where.append("(instr(lower(s.value),lower(?))>0 OR instr(lower(e.note),lower(?))>0)")
        args.extend((query, query))
    clause = " AND ".join(where)
    with _connect(path) as db:
        total = db.execute(f"SELECT count(*) FROM entries e JOIN snapshots s ON s.hash=e.snapshot WHERE {clause}", args).fetchone()[0]
        rows = db.execute(f"SELECT e.*, s.value FROM entries e JOIN snapshots s ON s.hash=e.snapshot WHERE {clause} ORDER BY e.created DESC,e.seq DESC LIMIT 40 OFFSET ?",
                          (*args, (max(1, int(page)) - 1) * 40)).fetchall()
        days = db.execute("SELECT value FROM config WHERE key='retentionDays'").fetchone()
        return {"items": [_decode(row, False) for row in rows], "total": total,
                "retentionDays": days[0] if days else DEFAULT_RETENTION_DAYS}


def manage(path, ids, action, note=""):
    if action not in ("delete", "restore", "purge", "note") or not isinstance(ids, list) or len(ids) > 1000:
        raise ValueError("无效的历史管理操作")
    with _connect(path) as db:
        for entry_id in ids:
            if action == "purge":
                db.execute("DELETE FROM entries WHERE id=? AND deleted IS NOT NULL", (entry_id,))
            elif action == "note":
                db.execute("UPDATE entries SET note=? WHERE id=?", (str(note)[:1000], entry_id))
            else:
                db.execute("UPDATE entries SET deleted=? WHERE id=?", (time.time() if action == "delete" else None, entry_id))
                if action == "delete":
                    db.execute("UPDATE entries SET event_key=NULL WHERE id=? AND kind='checkpoint'", (entry_id,))


def settings(path, days):
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= 365:
        raise ValueError("历史保留天数必须在 1–365 天之间")
    with _connect(path) as db:
        db.execute("INSERT OR REPLACE INTO config VALUES ('retentionDays', ?)", (days,))
        db.execute("DELETE FROM entries WHERE created < ?", (time.time() - days * 86400,))
    return days


def remove_saved_external(path, contents):
    """Permanently discard external results that have an exact saved original.

    Matching is literal: saving an edited variant must not remove its source.
    Other history types, including preset versions and deleted presets, survive.
    """
    contents = set(contents)
    with _connect(path) as db:
        rows = db.execute("SELECT DISTINCT s.hash,s.value FROM snapshots s JOIN entries e ON e.snapshot=s.hash WHERE e.kind='text' AND e.source='external'").fetchall()
        for row in rows:
            if json.loads(row["value"]).get("content", "") in contents:
                db.execute("DELETE FROM entries WHERE kind='text' AND source='external' AND snapshot=?", (row["hash"],))
