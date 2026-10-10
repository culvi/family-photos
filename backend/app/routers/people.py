"""Immich server info, named people, and the most-seen unnamed faces."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import require_token
from ..memory_cache import cache_manager
from ..people_lists import FALLBACK_UNNAMED, split_people, unnamed_with_min_photos
from ..config import settings
from ..deps import get_client, get_media_cache, validate_uuid
from ..media_cache import MediaCache, as_response, person_thumb_key
from ..scope import album_ids_for_search, ensure_person_in_scope, person_ids_in_scope
from ..tokens import TokenRecord

router = APIRouter(prefix="/api")


@router.get("/server-info")
async def get_server_info(
    client: httpx.AsyncClient = Depends(get_client),
    _token: TokenRecord = Depends(require_token),
):
    try:
        response = await client.get("/api/server/about")
        response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail="Failed to get server info")


async def _fetch_all_people(client: httpx.AsyncClient, with_hidden: bool, max_pages: int = 5) -> list:
    """Immich pages /api/people (max 1000 per page); unnamed faces can run past one page."""
    people: list = []
    for page in range(1, max_pages + 1):
        response = await client.get(
            "/api/people", params={"withHidden": with_hidden, "page": page, "size": 1000}
        )
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            return people + list(data)
        people.extend(data.get("people", []))
        if not data.get("hasNextPage"):
            break
    return people


async def _most_seen_unnamed(client: httpx.AsyncClient, unnamed: list) -> list:
    """Unnamed people in >= UNNAMED_MIN_PHOTOS photos; the top few if counts are unavailable
    (e.g. the API key lacks person.statistics)."""

    async def photo_count(person_id: str) -> int:
        response = await client.get(f"/api/people/{person_id}/statistics")
        response.raise_for_status()
        return int(response.json().get("assets", 0))

    try:
        return await unnamed_with_min_photos(unnamed, settings.unnamed_min_photos, photo_count)
    except (httpx.HTTPError, ValueError, TypeError):
        return unnamed[:FALLBACK_UNNAMED]


@router.get("/people")
async def get_people(
    client: httpx.AsyncClient = Depends(get_client),
    withHidden: bool = False,
    token: TokenRecord = Depends(require_token),
):
    allowed = await person_ids_in_scope(client, token)
    if allowed is not None and not allowed:
        return {"people": [], "total": 0}

    scoped = album_ids_for_search(token)
    # Must not share people_{withHidden} across tokens — that served the full
    # Immich directory (names + face ids) to album-scoped sessions.
    if scoped is None:
        cache_key = f"people:full:{withHidden}"
        hidden = withHidden
    else:
        cache_key = f"people:albums:{','.join(sorted(scoped))}"
        hidden = True

    cached = cache_manager.get(cache_key)
    if cached:
        return cached

    try:
        people = await _fetch_all_people(client, hidden)
        named_people, unnamed_all = split_people(people, allowed, unnamed_limit=None)
        unnamed_people = await _most_seen_unnamed(client, unnamed_all)
        result = {"people": named_people, "total": len(named_people), "unnamed": unnamed_people}
        cache_manager.set(cache_key, result, ttl=settings.cache_ttl_people)
        return result
    except httpx.HTTPStatusError as e:
        return {"people": [], "total": 0, "error": f"Failed to get people: {e.response.status_code}"}
    except Exception as e:
        return {"people": [], "total": 0, "error": f"Failed to get people: {str(e)}"}


@router.get("/people/{person_id}")
async def get_person(
    person_id: str,
    client: httpx.AsyncClient = Depends(get_client),
    token: TokenRecord = Depends(require_token),
):
    validate_uuid(person_id, "person_id")
    await ensure_person_in_scope(client, person_id, token)
    try:
        response = await client.get(f"/api/people/{person_id}")
        response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail="Person not found")


@router.get("/people/{person_id}/thumbnail")
async def get_person_thumbnail(
    person_id: str,
    request: Request,
    client: httpx.AsyncClient = Depends(get_client),
    token: TokenRecord = Depends(require_token),
    cache: MediaCache = Depends(get_media_cache),
):
    validate_uuid(person_id, "person_id")
    await ensure_person_in_scope(client, person_id, token)
    key = person_thumb_key(person_id)

    async def filler():
        return await cache.fill_http(key, client, f"/api/people/{person_id}/thumbnail")

    try:
        cached = await cache.get_or_fill(key, filler)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail="Thumbnail not found")
    return as_response(cached, request, "private, max-age=3600")
