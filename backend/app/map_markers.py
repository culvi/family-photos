"""Compact Immich's map markers for the Places page."""

from __future__ import annotations

from typing import Any


def compact_markers(raw: Any) -> dict[str, list]:
    """[{id, lat, lon, city, ...}] (newest first) -> {"ids": [...], "lat": [...], "lon": [...]}.

    Columns instead of objects and coordinates rounded to ~1 m: tens of thousands of
    markers stay a small download. Malformed or out-of-range entries are dropped.
    """
    ids: list[str] = []
    lats: list[float] = []
    lons: list[float] = []
    for marker in raw if isinstance(raw, list) else []:
        if not isinstance(marker, dict):
            continue
        asset_id = marker.get("id")
        lat = marker.get("lat")
        lon = marker.get("lon")
        if not isinstance(asset_id, str) or not asset_id:
            continue
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        if isinstance(lat, bool) or isinstance(lon, bool):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
            continue  # 0,0 is a camera with no fix, not a photo in the Gulf of Guinea
        ids.append(asset_id)
        lats.append(round(float(lat), 5))
        lons.append(round(float(lon), 5))
    return {"ids": ids, "lat": lats, "lon": lons}
