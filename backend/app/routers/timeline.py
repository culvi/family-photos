"""Per-month photo counts for the timeline scrubber (timeline-visible photos only)."""

from __future__ import annotations

from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Query

from ..auth import require_token
from ..config import settings
from ..deps import get_client, validate_uuid
from ..memory_cache import cache_manager
from ..timeline_buckets import normalize_buckets
from ..tokens import TokenRecord

router = APIRouter(prefix="/api")


@router.get("/timeline/buckets")
async def get_timeline_buckets(
    personId: Optional[str] = Query(None),
    client: httpx.AsyncClient = Depends(get_client),
    token: TokenRecord = Depends(require_token),
):
    # Album-scoped sessions see a subset Immich's buckets can't express; no scrubber there.
    if token.is_scoped:
        return {"buckets": []}
    if personId:
        validate_uuid(personId, "personId")

    cache_key = f"timeline:buckets:{personId or 'all'}"
    cached = cache_manager.get(cache_key)
    if cached:
        return cached

    params = {"visibility": "timeline"}  # same rule as search: never archived
    if personId:
        params["personId"] = personId
    try:
        response = await client.get("/api/timeline/buckets", params=params)
        response.raise_for_status()
        result = {"buckets": normalize_buckets(response.json())}
    except (httpx.HTTPError, ValueError):
        return {"buckets": []}  # scrubber just stays hidden

    cache_manager.set(cache_key, result, ttl=settings.cache_ttl_people)
    return result
