"""Normalize Immich's timeline data: per-month counts and the photos in one month."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
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


_MONTH_ONLY = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def is_month(value: str) -> bool:
    return bool(_MONTH_ONLY.match(value or ""))


def _wall_clock(file_created_at: Any, offset_hours: Any) -> str | None:
    """UTC capture time + the photographer's UTC offset = the time on their clock, written
    the way Immich writes localDateTime (wall-clock time with a Z)."""
    try:
        moment = datetime.fromisoformat(str(file_created_at).replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    try:
        offset = float(offset_hours or 0)
    except (TypeError, ValueError):
        offset = 0.0
    local = moment.astimezone(timezone.utc) + timedelta(hours=offset)
    return local.strftime("%Y-%m-%dT%H:%M:%S.") + f"{local.microsecond // 1000:03d}Z"


def month_items(raw: Any) -> list[dict[str, Any]]:
    """Immich's columnar month ({id: [...], isImage: [...], ...}) -> [{id, type, localDateTime}].

    Keeps Immich's order (newest first) and skips anything trashed, not on the timeline,
    or malformed.
    """
    if not isinstance(raw, dict):
        return []
    ids = raw.get("id")
    if not isinstance(ids, list):
        return []

    def column(name: str) -> list:
        value = raw.get(name)
        return value if isinstance(value, list) and len(value) == len(ids) else [None] * len(ids)

    is_image = column("isImage")
    visibility = column("visibility")
    trashed = column("isTrashed")
    created = column("fileCreatedAt")
    offsets = column("localOffsetHours")

    items = []
    for i, asset_id in enumerate(ids):
        if not isinstance(asset_id, str) or not asset_id:
            continue
        if trashed[i] is True or (visibility[i] not in (None, "timeline")):
            continue
        local = _wall_clock(created[i], offsets[i])
        if not local:
            continue
        items.append(
            {"id": asset_id, "type": "VIDEO" if is_image[i] is False else "IMAGE", "localDateTime": local}
        )
    return items
