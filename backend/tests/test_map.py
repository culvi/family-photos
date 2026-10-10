"""Places page: markers are timeline-only, compact, and never for album-scoped codes."""

import httpx
import pytest
from fastapi import FastAPI

from app.auth import SESSION_COOKIE, install_auth_gate, make_session_value
from app.map_markers import compact_markers
from app.memory_cache import cache_manager
from app.routers import map as map_router
from app.tokens import TokenStore

A = "aaaaaaaa-1234-1234-1234-123456789abc"
B = "bbbbbbbb-1234-1234-1234-123456789abc"


def test_compact_markers_columns_and_rounding():
    raw = [
        {"id": A, "lat": 32.7765123456, "lon": -79.9311987654, "city": "Charleston"},
        {"id": B, "lat": 0, "lon": 0},  # no GPS fix
        {"id": "c", "lat": 91, "lon": 0},  # out of range
        {"id": "d", "lat": "32", "lon": 1},  # not a number
        {"id": "e", "lat": True, "lon": 1},  # bool is not a coordinate
        {"lat": 1, "lon": 1},  # no id
        "junk",
    ]
    assert compact_markers(raw) == {"ids": [A], "lat": [32.77651], "lon": [-79.9312]}


def test_compact_markers_non_list():
    assert compact_markers({"nope": 1}) == {"ids": [], "lat": [], "lon": []}


@pytest.fixture
async def viewer(tmp_path):
    sent = []

    def upstream(request):
        assert request.url.path == "/api/map/markers"
        sent.append(dict(request.url.params))
        return httpx.Response(200, json=[{"id": A, "lat": 10.5, "lon": 20.25}])

    app = FastAPI()
    app.include_router(map_router.router)
    install_auth_gate(app)
    store = TokenStore(str(tmp_path / "tokens.db"), "fixture-token-secret")
    app.state.token_store = store
    full, _ = store.issue("family")
    scoped, _ = store.issue("friends", album_ids=["11111111-1111-1111-1111-111111111111"])
    cache_manager.clear()
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), base_url="http://immich.test"
    ) as upstream_client:
        app.state.http_client = upstream_client

        def client_for(record):
            return httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://viewer.test",
                cookies={SESSION_COOKIE: make_session_value(record.id)},
            )

        yield client_for, full, scoped, sent, app
    cache_manager.clear()


async def test_markers_exclude_archived(viewer):
    client_for, full, _, sent, _app = viewer
    async with client_for(full) as client:
        response = await client.get("/api/map/markers")
    assert response.json() == {"ids": [A], "lat": [10.5], "lon": [20.25]}
    assert sent == [{"isArchived": "false"}]


async def test_album_scoped_codes_get_no_markers(viewer):
    client_for, _, scoped, sent, _app = viewer
    async with client_for(scoped) as client:
        response = await client.get("/api/map/markers")
    assert response.json() == {"ids": [], "lat": [], "lon": []}
    assert sent == []


async def test_map_style_needs_a_session(viewer):
    client_for, full, _, _, app = viewer
    async with client_for(full) as client:
        response = await client.get("/api/map/style")
    assert response.json()["light"].startswith("https://")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://viewer.test") as anonymous:
        assert (await anonymous.get("/api/map/style")).status_code in (401, 403)
