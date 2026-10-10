"""Who's been using the site: visits, photos opened, and saves, per signed-in person."""

from __future__ import annotations

import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Optional

KINDS = ("visit", "photo", "download", "share", "copy")
SAVE_KINDS = ("download", "share", "copy")
KEEP_SECONDS = 400 * 24 * 3600  # a bit over a year


class UsageStore:
    def __init__(self, db_path: str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as conn, conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS usage_events (
                    ts REAL NOT NULL,
                    email TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    asset_id TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
                CREATE INDEX IF NOT EXISTS idx_usage_email_ts ON usage_events(email, ts);
                """
            )

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def add(self, email: str, kind: str, asset_id: Optional[str] = None, ts: Optional[float] = None) -> None:
        if kind not in KINDS:
            raise ValueError(f"unknown usage kind: {kind}")
        ts = time.time() if ts is None else ts
        with closing(self._connect()) as conn, conn:
            conn.execute(
                "INSERT INTO usage_events (ts, email, kind, asset_id) VALUES (?, ?, ?, ?)",
                (ts, email, kind, asset_id),
            )
            conn.execute("DELETE FROM usage_events WHERE ts < ?", (ts - KEEP_SECONDS,))

    def last_seen(self, email: str) -> Optional[float]:
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT MAX(ts) AS ts FROM usage_events WHERE email = ?", (email,)).fetchone()
        return row["ts"] if row and row["ts"] is not None else None

    def summary(self, since: float) -> dict[str, dict]:
        """{email: {last, visits, photos, saves}}; counts since `since`, last ever."""
        saves = ",".join("?" * len(SAVE_KINDS))
        with closing(self._connect()) as conn:
            rows = conn.execute(
                f"""
                SELECT email,
                       MAX(ts) AS last,
                       SUM(kind = 'visit' AND ts >= ?) AS visits,
                       SUM(kind = 'photo' AND ts >= ?) AS photos,
                       SUM(kind IN ({saves}) AND ts >= ?) AS saves
                FROM usage_events GROUP BY email
                """,
                (since, since, *SAVE_KINDS, since),
            ).fetchall()
        return {
            r["email"]: {
                "last": r["last"],
                "visits": int(r["visits"] or 0),
                "photos": int(r["photos"] or 0),
                "saves": int(r["saves"] or 0),
            }
            for r in rows
        }

    def recent(self, limit: int = 100) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute(
                "SELECT ts, email, kind, asset_id FROM usage_events ORDER BY ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [{"ts": r["ts"], "email": r["email"], "kind": r["kind"], "assetId": r["asset_id"]} for r in rows]
