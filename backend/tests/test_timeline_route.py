"""The scrubber's month counts: timeline-only, optional person, none for album-scoped codes."""

import httpx
import pytest
from fastapi import FastAPI

from app.auth import SESSION_COOKIE, install_auth_gate, make_session_value
from app.memory_cache import cache_manager
from app.routers import timeline
from app.tokens import TokenStore

PERSON = "12345678-1234-1234-1234-123456789abc"
ASSET = "aaaaaaaa-1234-1234-1234-123456789abc"
MONTH = {
    "id": [ASSET],
    "isImage": [False],
    "visibility": ["timeline"],
    "isTrashed": [False],
    "fileCreatedAt": ["2024-02-10T03:30:00.000Z"],
    "localOffsetHours": [-5],
}


@pytest.fixture
async def viewer(tmp_path):
    sent = []

    def upstream(request):
        sent.append(dict(request.url.params))
        if request.url.path == "/api/timeline/bucket":
            return httpx.Response(200, json=MONTH)
        assert request.url.path == "/api/timeline/buckets"
        return httpx.Response(200, json=[{"timeBucket": "2024-02-01", "count": 7}])

    app = FastAPI()
    app.include_router(timeline.router)
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

        yield client_for, full, scoped, sent
    cache_manager.clear()


async def test_buckets_are_timeline_only(viewer):
    client_for, full, _, sent = viewer
    async with client_for(full) as client:
        response = await client.get("/api/timeline/buckets")
    assert response.json() == {"buckets": [{"month": "2024-02", "count": 7}]}
    assert sent[-1] == {"visibility": "timeline"}


async def test_buckets_can_follow_one_person(viewer):
    client_for, full, _, sent = viewer
    async with client_for(full) as client:
        response = await client.get("/api/timeline/buckets", params={"personId": PERSON})
    assert response.status_code == 200
    assert sent[-1] == {"visibility": "timeline", "personId": PERSON}


async def test_bad_person_id_is_rejected(viewer):
    client_for, full, _, sent = viewer
    async with client_for(full) as client:
        response = await client.get("/api/timeline/buckets", params={"personId": "nope"})
    assert response.status_code == 400
    assert sent == []


async def test_album_scoped_codes_get_no_scrubber(viewer):
    client_for, _, scoped, sent = viewer
    async with client_for(scoped) as client:
        response = await client.get("/api/timeline/buckets")
    assert response.json() == {"buckets": []}
    assert sent == []


async def test_month_photos_are_timeline_only(viewer):
    client_for, full, _, sent = viewer
    async with client_for(full) as client:
        response = await client.get("/api/timeline/month", params={"month": "2024-02", "personId": PERSON})
    assert response.status_code == 200
    assert response.json() == {
        "items": [{"id": ASSET, "type": "VIDEO", "localDateTime": "2024-02-09T22:30:00.000Z"}]
    }
    assert sent[-1] == {
        "timeBucket": "2024-02-01T00:00:00.000Z",
        "visibility": "timeline",
        "personId": PERSON,
    }


@pytest.mark.parametrize("month", ["2024-13", "2024-2", "2024-02-01", "x"])
async def test_month_must_be_a_month(viewer, month):
    client_for, full, _, sent = viewer
    async with client_for(full) as client:
        response = await client.get("/api/timeline/month", params={"month": month})
    assert response.status_code == 400
    assert sent == []


async def test_album_scoped_codes_get_no_month(viewer):
    client_for, _, scoped, sent = viewer
    async with client_for(scoped) as client:
        response = await client.get("/api/timeline/month", params={"month": "2024-02"})
    assert response.json() == {"items": []}
    assert sent == []
