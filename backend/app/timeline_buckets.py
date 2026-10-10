"""Normalize Immich's per-month photo counts for the timeline scrubber."""

from __future__ import annotations

import re
from typing import Any

_MONTH = re.compile(r"^(\d{4})-(\d{2})")


def normalize_buckets(raw: Any) -> list[dict[str, Any]]:
    """[{timeBucket: "2025-10-01...", count}] -> [{month: "2025-10", count}], newest first.

    Drops malformed or empty entries and merges duplicates (Immich has returned both
    date and datetime bucket keys across versions).
    """
    counts: dict[str, int] = {}
    for bucket in raw if isinstance(raw, list) else []:
        if not isinstance(bucket, dict):
            continue
        match = _MONTH.match(str(bucket.get("timeBucket", "")))
        try:
            count = int(bucket.get("count", 0))
        except (TypeError, ValueError):
            continue
        if not match or count <= 0:
            continue
        month = f"{match.group(1)}-{match.group(2)}"
        counts[month] = counts.get(month, 0) + count
    return [{"month": m, "count": c} for m, c in sorted(counts.items(), reverse=True)]
