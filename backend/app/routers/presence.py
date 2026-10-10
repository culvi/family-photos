"""Who's here now, and the owner's Usage page. Only for people signed in through
Cloudflare Access (access-code sessions are anonymous and simply don't take part)."""

from __future__ import annotations

import time
from typing import Literal, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator

from ..auth import member_email, require_token
from ..deps import get_client
from ..members import display_name, is_admin, parse_members, person_for_name
from ..memory_cache import cache_manager
from ..presence import PresenceBoard
from ..config import settings
from ..tokens import TokenRecord
from ..validation import is_uuid
from .access import _html_page
from .people import _fetch_all_people

router = APIRouter()
board = PresenceBoard()


class Beat(BaseModel):
    assetId: Optional[str] = None
    where: Literal["grid", "photo", "map", "people"] = "grid"

    @field_validator("assetId")
    @classmethod
    def _uuid(cls, value):
        return value if value is None or is_uuid(value) else None


class UsageEvent(BaseModel):
    kind: Literal["download", "share", "copy"]
    assetId: Optional[str] = None

    @field_validator("assetId")
    @classmethod
    def _uuid(cls, value):
        return value if value is None or is_uuid(value) else None


async def _faces(client: httpx.AsyncClient) -> dict[str, Optional[str]]:
    """{display name: Immich person id} for the configured members (cached)."""
    cached = cache_manager.get("members:faces")
    if cached is not None:
        return cached
    try:
        people = await _fetch_all_people(client, with_hidden=False)
    except Exception:
        people = []
    names = set(parse_members(settings.members).values())
    faces = {name: person_for_name(name, people) for name in names}
    cache_manager.set("members:faces", faces, ttl=600)
    return faces


async def _who(email: str, client: httpx.AsyncClient) -> dict:
    name = display_name(email)
    faces = await _faces(client)
    return {"email": email, "name": name, "personId": faces.get(name)}


@router.get("/api/me")
async def me(
    request: Request,
    client: httpx.AsyncClient = Depends(get_client),
    token: TokenRecord = Depends(require_token),
):
    email = await member_email(request)
    if not email:
        return {"email": None, "presence": False, "isAdmin": False}
    return {**await _who(email, client), "presence": True, "isAdmin": is_admin(email)}


@router.post("/api/presence")
async def presence_beat(
    beat: Beat,
    request: Request,
    client: httpx.AsyncClient = Depends(get_client),
    token: TokenRecord = Depends(require_token),
):
    email = await member_email(request)
    if not email:
        return {"others": []}
    store = request.app.state.usage_store
    now = time.time()
    asset_id = beat.assetId if beat.where == "photo" else None
    last_logged = None if board.knows(email) else store.last_seen(email)
    for kind, event_asset in board.beat(email, asset_id, beat.where, now, last_logged):
        store.add(email, kind, event_asset, ts=now)

    others = []
    for entry in board.active(now, exclude=email):
        who = await _who(entry["email"], client)
        others.append(
            {
                "name": who["name"],
                "personId": who["personId"],
                "where": entry["where"],
                "assetId": entry["assetId"],
            }
        )
    return {"others": others}


@router.post("/api/presence/leave")
async def presence_leave(request: Request, token: TokenRecord = Depends(require_token)):
    email = await member_email(request)
    if email:
        board.leave(email)
    return {"ok": True}


@router.post("/api/usage/event")
async def usage_event(event: UsageEvent, request: Request, token: TokenRecord = Depends(require_token)):
    email = await member_email(request)
    if email:
        request.app.state.usage_store.add(email, event.kind, event.assetId)
    return {"ok": True}


async def _require_admin(request: Request) -> str:
    email = await member_email(request)
    if not is_admin(email):
        raise HTTPException(status_code=403, detail="Only for the site's owner")
    return email


@router.get("/api/usage")
async def usage(
    request: Request,
    client: httpx.AsyncClient = Depends(get_client),
    token: TokenRecord = Depends(require_token),
):
    await _require_admin(request)
    store = request.app.state.usage_store
    now = time.time()
    summary = store.summary(since=now - 30 * 24 * 3600)
    here = {entry["email"]: entry for entry in board.active(now)}

    # The owner's own browsing would only be noise on their page.
    emails = [e for e in parse_members(settings.members) if not is_admin(e)]
    emails += sorted(e for e in summary if e not in emails and not is_admin(e))
    people = []
    for email in emails:
        stats = summary.get(email, {"last": None, "visits": 0, "photos": 0, "saves": 0})
        live = here.get(email)
        people.append(
            {
                **await _who(email, client),
                **stats,
                "here": bool(live),
                "where": live["where"] if live else None,
                "assetId": live["assetId"] if live else None,
            }
        )

    recent = []
    for event in store.recent(300):
        if not is_admin(event["email"]):
            recent.append({**event, "name": display_name(event["email"])})
    recent = recent[:150]
    return {"now": now, "people": people, "recent": recent}


@router.get("/usage")
async def usage_page(request: Request, token: TokenRecord = Depends(require_token)):
    await _require_admin(request)
    return _html_page("usage.html", missing="Usage page not found")
