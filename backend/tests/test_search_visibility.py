"""Archived photos are how the owner hides things from family: every listing must exclude them."""

import json

import httpx
import pytest
from fastapi import FastAPI

from app.auth import SESSION_COOKIE, install_auth_gate, make_session_value
from app.memory_cache import cache_manager
from app.routers import assets, search
from app.tokens import TokenStore


@pytest.fixture
async def viewer(tmp_path):
    sent = []

    def upstream(request):
        if request.url.path.startswith("/api/search/"):
            sent.append((request.url.path, json.loads(request.content)))
            return httpx.Response(200, json={"assets": {"items": [], "total": 0}})
        raise AssertionError(f"Unexpected upstream request: {request.url}")

    app = FastAPI()
    app.include_router(search.router)
    app.include_router(assets.router)
    install_auth_gate(app)
    store = TokenStore(str(tmp_path / "tokens.db"), "fixture-token-secret")
    app.state.token_store = store
    record, _ = store.issue("family")
    cache_manager.clear()
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), base_url="http://immich.test"
    ) as upstream_client:
        app.state.http_client = upstream_client
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://viewer.test",
            cookies={SESSION_COOKIE: make_session_value(record.id)},
        ) as client:
            yield client, sent
    cache_manager.clear()


@pytest.mark.parametrize(
    "body, endpoint",
    [
        ({}, "/api/search/metadata"),
        ({"query": "beach"}, "/api/search/smart"),
        ({"takenBefore": "2012-03-31"}, "/api/search/metadata"),
    ],
)
async def test_search_only_returns_timeline_photos(viewer, body, endpoint):
    client, sent = viewer
    response = await client.post("/api/search", json=body)
    assert response.status_code == 200
    assert sent[-1][0] == endpoint
    assert sent[-1][1]["visibility"] == "timeline"


async def test_asset_listing_only_returns_timeline_photos(viewer):
    client, sent = viewer
    response = await client.get("/api/assets")
    assert response.status_code == 200
    assert sent[-1][1]["visibility"] == "timeline"
