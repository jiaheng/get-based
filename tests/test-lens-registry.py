#!/usr/bin/env python3
"""Smoke test for lens.registry — library registry persistence + API.

Node-side helpers live in test-lens-*.js; this one runs under the bundled
lens venv so we can import the registry module directly.

Run via:
  ~/.local/share/getbased/lens/venv/bin/python tests/test-lens-registry.py
or just `python tests/test-lens-registry.py` after `pip install -e lens/`.
"""

from __future__ import annotations

import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

# Ensure we import the source tree, not any installed copy.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "lens" / "src"))

from lens.config import LensConfig  # noqa: E402
from lens.registry import Registry  # noqa: E402


@dataclass
class Result:
    passed: int = 0
    failed: int = 0

    def ok(self, name: str) -> None:
        self.passed += 1
        print(f"  PASS: {name}")

    def bad(self, name: str, detail: str = "") -> None:
        self.failed += 1
        print(f"  FAIL: {name}{(' — ' + detail) if detail else ''}")


def _fresh_config() -> LensConfig:
    tmp = Path(tempfile.mkdtemp(prefix="lens-registry-test-"))
    return LensConfig(data_dir=tmp, api_key_file=tmp / "api_key")


def main() -> int:
    r = Result()

    # Empty registry → list returns empty.
    cfg = _fresh_config()
    reg = Registry(cfg)
    state = reg.list()
    (r.ok if state["libraries"] == [] and state["activeId"] == "" else r.bad)(
        "empty registry lists nothing",
    )

    # ensure_default creates one and activates it.
    aid = reg.ensure_default()
    state = reg.list()
    if state["activeId"] == aid and len(state["libraries"]) == 1 and state["libraries"][0]["name"] == "Default":
        r.ok("ensure_default creates Default + activates it")
    else:
        r.bad("ensure_default behavior", str(state))

    # Second ensure_default is a no-op.
    aid2 = reg.ensure_default()
    (r.ok if aid2 == aid else r.bad)("ensure_default idempotent")

    # create + auto-activate if first.
    cfg2 = _fresh_config()
    reg2 = Registry(cfg2)
    lib = reg2.create("Research")
    s = reg2.list()
    if lib["name"] == "Research" and s["activeId"] == lib["id"] and len(s["libraries"]) == 1:
        r.ok("create on empty auto-activates new library")
    else:
        r.bad("create/activate", str(s))

    # Second create does NOT change active.
    lib2 = reg2.create("Clinical")
    s = reg2.list()
    (r.ok if s["activeId"] == lib["id"] and len(s["libraries"]) == 2 else r.bad)(
        "second create does not steal active",
    )

    # Activate → switches.
    reg2.activate(lib2["id"])
    (r.ok if reg2.active_id() == lib2["id"] else r.bad)("activate switches active id")

    # Rename.
    renamed = reg2.rename(lib["id"], "Research Papers")
    (r.ok if renamed["name"] == "Research Papers" else r.bad)("rename updates name")

    # Rename missing → ValueError.
    try:
        reg2.rename("nonexistent", "X")
        r.bad("rename missing raises", "no exception")
    except ValueError:
        r.ok("rename missing raises ValueError")

    # Delete → removed + active falls back.
    reg2.delete(lib2["id"])
    s = reg2.list()
    if len(s["libraries"]) == 1 and s["activeId"] == lib["id"]:
        r.ok("delete active falls back to remaining library")
    else:
        r.bad("delete active fallback", str(s))

    # Delete last → active becomes empty string.
    reg2.delete(lib["id"])
    s = reg2.list()
    (r.ok if s["libraries"] == [] and s["activeId"] == "" else r.bad)(
        "deleting last library clears active",
    )

    # active_collection naming is lib_<hex>.
    cfg3 = _fresh_config()
    reg3 = Registry(cfg3)
    aid3 = reg3.ensure_default()
    coll = reg3.active_collection()
    if coll.startswith("lib_") and coll[4:] == aid3:
        r.ok("active_collection uses lib_<id> format")
    else:
        r.bad("active_collection format", coll)

    # Persistence across instances.
    reg3.rename(aid3, "My Library")
    reg3b = Registry(cfg3)
    s = reg3b.list()
    (r.ok if s["libraries"] and s["libraries"][0]["name"] == "My Library" else r.bad)(
        "state persists across Registry instances",
    )

    print()
    total = r.passed + r.failed
    print(f"Total: {r.passed} passed, {r.failed} failed (out of {total}).")
    return 0 if r.failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
