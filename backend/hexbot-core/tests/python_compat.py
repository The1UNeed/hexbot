"""Compare native storage upgrades with the actual Python implementation.

Standard library only. All writes go into a temporary home and workspace.
Run through `cargo test --test python_compat`.
"""

import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from hexbot import db, memory  # noqa: E402
from hexbot.errors import HexbotError  # noqa: E402


def seed(home, version):
    home.mkdir()
    if version == 0:
        return
    with sqlite3.connect(home / "hexbot.db") as conn:
        conn.executescript(db._DDL)
        conn.execute("INSERT INTO schema_version VALUES (?)", (version,))
        for step in range(2, version + 1):
            if step in db._MIGRATION_DDL:
                conn.executescript(db._MIGRATION_DDL[step])
            for table, column, definition in db._ADDED_COLUMNS.get(step, []):
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        conn.execute("INSERT INTO bots(name,created_at) VALUES ('scout',123)")
        conn.execute("INSERT INTO sections(id,bot,title) VALUES ('s1','scout','Kept')")
        if version < 8:
            conn.execute("CREATE TABLE core_memory(owner_id TEXT, section TEXT, text TEXT)")
            conn.executemany("INSERT INTO core_memory VALUES (?,?,?)", [
                ("local", "facts", "Name: Alex"),
                ("local", "preferences", "中文 😀 " * 500),
                ("other", "facts", "Legacy text"),
            ])
    # Neither implementation may overwrite an existing user-authored file.
    path = home / "users/other/user.md"
    path.parent.mkdir(parents=True)
    path.write_text("Keep my notes", encoding="utf-8")


def snapshot(home):
    with sqlite3.connect(home / "hexbot.db") as conn:
        names = sorted(r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
        schema = {}
        data = {}
        for table in names:
            schema[table] = {
                "columns": conn.execute(f"PRAGMA table_info({table})").fetchall(),
                "foreign_keys": conn.execute(f"PRAGMA foreign_key_list({table})").fetchall(),
                "indexes": sorted(conn.execute(f"PRAGMA index_list({table})").fetchall(), key=lambda r: r[1]),
            }
            # SQLite index ordinal depends on creation order, not behavior.
            schema[table]["indexes"] = [r[1:] for r in schema[table]["indexes"]]
            columns = [r[1] for r in schema[table]["columns"]]
            rows = [dict(zip(columns, row)) for row in conn.execute(f"SELECT * FROM {table}")]
            for row in rows:
                if table == "users" and row["id"] == "local":
                    row["created_at"] = 0
            data[table] = rows
    files = {str(p.relative_to(home)): p.read_text(encoding="utf-8")
             for p in sorted(home.rglob("*.md"))}
    return {"schema": schema, "data": data, "files": files}


def memory_parity(binary, root):
    pyhome, nativehome = root / "py-memory", root / "native-memory"
    os.environ["HEXBOT_HOME"] = str(pyhome)
    db.migrate()
    requests, expected = [], []
    for index, text in enumerate([
        ..., "", ..., "Name: Alex\n中文 😀\u2028\u2029", ...,
        "😀" * 2000, "😀" * 2001, ..., None, ...,
    ]):
        method = "get" if text is ... else "set"
        requests.append({"jsonrpc": "2.0", "id": index,
                         "method": f"hexbot.memory.user.{method}",
                         "params": {} if text is ... else {"text": text}})
        frame = {"jsonrpc": "2.0", "id": index}
        try:
            frame["result"] = (memory.get_user_memory() if text is ...
                               else memory.set_user_memory(text))
        except HexbotError as error:
            frame["error"] = {"code": error.code, "message": error.message}
        expected.append(frame)
    run = subprocess.run([binary, "memory-rpc", "--home", str(nativehome), "--user", "local"],
                         input="".join(json.dumps(r, ensure_ascii=False) + "\n" for r in requests),
                         capture_output=True, text=True, timeout=30, check=True)
    # Split on LF only. Unicode separators are valid characters inside JSON strings.
    actual = [json.loads(line) for line in run.stdout.split("\n") if line]
    for frames in (actual, expected):
        for frame in frames:
            result = frame.get("result", {})
            if result.get("updated_at") is not None:
                assert isinstance(result["updated_at"], (float, int))
                assert result["updated_at"] > 0
                result["updated_at"] = "timestamp"
    assert actual == expected, f"memory replies differ: {actual!r} != {expected!r}"
    assert (nativehome / "users/local/user.md").read_text() == (pyhome / "users/local/user.md").read_text()


def main(binary):
    with tempfile.TemporaryDirectory(prefix="hexbot-storage-parity-") as tmp:
        root = Path(tmp)
        os.environ["HEXBOT_WORKSPACE"] = str(root / "workspace")
        for version in range(10):
            pyhome, nativehome = root / f"py-{version}", root / f"native-{version}"
            seed(pyhome, version)
            seed(nativehome, version)
            os.environ["HEXBOT_HOME"] = str(pyhome)
            db.migrate()
            expected = snapshot(pyhome)
            for _ in range(2):
                subprocess.run([binary, "migrate", "--home", str(nativehome)],
                               check=True, capture_output=True, text=True)
                actual = snapshot(nativehome)
                if actual != expected:
                    raise AssertionError(f"v{version} storage mismatch\n"
                                         f"Python: {json.dumps(expected, ensure_ascii=False)}\n"
                                         f"Rust: {json.dumps(actual, ensure_ascii=False)}")
            # The old backend can still read and migrate the native result.
            os.environ["HEXBOT_HOME"] = str(nativehome)
            db.migrate()
            assert snapshot(nativehome) == expected, f"v{version} Python round-trip"
        memory_parity(binary, root)
        print("Python/Rust storage parity: fresh database and versions 1–9 passed")
        print("Python/Rust About you parity: reads, writes, Unicode, cap errors and null passed")


if __name__ == "__main__":
    main(sys.argv[1])
