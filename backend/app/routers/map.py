"""Places page: where photos were taken (timeline-visible photos only)."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends

from ..auth import require_token
from ..config import settings
from ..deps import get_client
from ..map_markers import compact_markers
from ..memory_cache import cache_manager
from ..tokens import TokenRecord

router = APIRouter(prefix="/api")

_EMPTY = {"ids": [], "lat": [], "lon": []}


@router.get("/map/markers")
async def get_map_markers(
    client: httpx.AsyncClient = Depends(get_client),
    token: TokenRecord = Depends(require_token),
):
    # Immich's markers can't be limited to an album-scoped code's albums.
    if token.is_scoped:
        return _EMPTY

    cached = cache_manager.get("map:markers")
    if cached:
        return cached

    try:
        # isArchived=false: timeline photos only (archived is how things are hidden from family)
        response = await client.get("/api/map/markers", params={"isArchived": "false"})
        response.raise_for_status()
        result = compact_markers(response.json())
    except (httpx.HTTPError, ValueError):
        return _EMPTY

    cache_manager.set("map:markers", result, ttl=settings.cache_ttl_suggestions)
    return result


@router.get("/map/style")
async def get_map_style(token: TokenRecord = Depends(require_token)):
    """The map's look (vector tile styles), light and dark."""
    return {"light": settings.map_style_light, "dark": settings.map_style_dark}
