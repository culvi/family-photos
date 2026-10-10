"""Who's here and the Usage page: Cloudflare sign-ins only; Usage only for the owner."""

import httpx
import pytest
from fastapi import FastAPI

from app.auth import SESSION_COOKIE, install_auth_gate, make_session_value
from app.config import settings
from app.members import display_name, parse_members, person_for_name
from app.memory_cache import cache_manager
from app.presence import PresenceBoard
from app.routers import presence
from app.tokens import TokenStore
from app.usage_store import UsageStore

PHOTO = "aaaaaaaa-1234-1234-1234-123456789abc"
NADIA_FACE = "11111111-1111-1111-1111-111111111111"


class FakeVerifier:
    """Stands in for Cloudflare: the header value is the email (tests only)."""

    async def email(self, token):
        return token if token and "@" in token else None


def test_members_parsing_and_faces():
    members = parse_members(["Nadia@x.com=Nadia", "bad", "j@x.com=", "a@x.com = Asia "])
    assert members == {"nadia@x.com": "Nadia", "a@x.com": "Asia"}
    assert display_name("cammrrw@gmail.com", members) == "Cammrrw"
    people = [{"id": "1", "name": "Nadia Neville"}, {"id": "2", "name": "Asia"}, {"id": "3", "name": "Amy"}, {"id": "4", "name": "Amy Diana"}]
    assert person_for_name("Nadia", people) == "1"
    assert person_for_name("Asia", people) == "2"
    assert person_for_name("Amy", people) == "3"  # exact match wins
    assert person_for_name("Zed", people) is None


def test_board_visits_and_photos():
    board = PresenceBoard()
    assert board.beat("n", None, "grid", 1000) == [("visit", None)]
    assert board.beat("n", PHOTO, "photo", 1020) == [("photo", PHOTO)]
    assert board.beat("n", PHOTO, "photo", 1040) == []
    assert board.beat("n", None, "grid", 1040 + 31 * 60) == [("visit", None)]
    assert board.active(1040 + 31 * 60 + 100) == []


@pytest.fixture
async def viewer(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "admin_emails", ["will@x.com"])
    monkeypatch.setattr(settings, "members", ["nadia@x.com=Nadia", "asia@x.com=Asia"])
    monkeypatch.setattr(presence, "board", PresenceBoard())

    def upstream(request):
        assert request.url.path == "/api/people"
        return httpx.Response(200, json={"people": [{"id": NADIA_FACE, "name": "Nadia"}], "hasNextPage": False})

    app = FastAPI()
    app.include_router(presence.router)
    install_auth_gate(app)
    store = TokenStore(str(tmp_path / "tokens.db"), "fixture-token-secret")
    app.state.token_store = store
    app.state.usage_store = UsageStore(str(tmp_path / "tokens.db"))
    app.state.cf_verifier = FakeVerifier()
    code, _ = store.issue("family")
    cache_manager.clear()
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream), base_url="http://immich.test") as up:
        app.state.http_client = up

        def as_member(email):
            return httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://viewer.test",
                headers={"cf-access-jwt-assertion": email},
            )

        def with_code():
            return httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://viewer.test",
                cookies={SESSION_COOKIE: make_session_value(code.id)},
            )

        def anonymous():
            return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://viewer.test")

        yield as_member, with_code, anonymous
    cache_manager.clear()


async def test_cloudflare_sign_in_needs_no_code(viewer):
    as_member, _, anonymous = viewer
    async with as_member("nadia@x.com") as client:
        me = (await client.get("/api/me")).json()
    assert me == {"email": "nadia@x.com", "name": "Nadia", "personId": NADIA_FACE, "presence": True, "isAdmin": False}
    async with anonymous() as client:
        assert (await client.get("/api/me")).status_code == 401
    async with as_member("not-an-email") as client:
        assert (await client.get("/api/me")).status_code == 401


async def test_people_see_each_other(viewer):
    as_member, with_code, _ = viewer
    async with as_member("nadia@x.com") as nadia, as_member("asia@x.com") as asia:
        await nadia.post("/api/presence", json={"assetId": PHOTO, "where": "photo"})
        seen = (await asia.post("/api/presence", json={"where": "grid"})).json()["others"]
        assert seen == [{"name": "Nadia", "personId": NADIA_FACE, "where": "photo", "assetId": PHOTO}]
        await nadia.post("/api/presence/leave")
        assert (await asia.post("/api/presence", json={})).json()["others"] == []
    # code sessions are anonymous: they see nobody and aren't seen
    async with with_code() as client:
        assert (await client.post("/api/presence", json={})).json() == {"others": []}
        assert (await client.get("/api/me")).json()["presence"] is False


async def test_bad_input_is_dropped(viewer):
    as_member, _, _ = viewer
    async with as_member("nadia@x.com") as client:
        assert (await client.post("/api/presence", json={"where": "kitchen"})).status_code == 422
        response = await client.post("/api/presence", json={"assetId": "../../etc", "where": "photo"})
        assert response.status_code == 200
        assert (await client.post("/api/usage/event", json={"kind": "delete"})).status_code == 422


async def test_usage_page_is_owner_only(viewer):
    as_member, with_code, _ = viewer
    async with as_member("nadia@x.com") as nadia:
        await nadia.post("/api/presence", json={"assetId": PHOTO, "where": "photo"})
        await nadia.post("/api/usage/event", json={"kind": "download", "assetId": PHOTO})
        assert (await nadia.get("/api/usage")).status_code == 403
        assert (await nadia.get("/usage")).status_code == 403
    async with with_code() as client:
        assert (await client.get("/api/usage")).status_code == 403
    async with as_member("will@x.com") as will:
        data = (await will.get("/api/usage")).json()
    rows = {p["email"]: p for p in data["people"]}
    assert rows["nadia@x.com"]["visits"] == 1
    assert rows["nadia@x.com"]["photos"] == 1
    assert rows["nadia@x.com"]["saves"] == 1
    assert rows["nadia@x.com"]["here"] is True
    assert rows["asia@x.com"]["last"] is None  # listed even before her first visit
    assert "will@x.com" not in rows  # the owner's own visits stay off their page
    assert all(e["email"] != "will@x.com" for e in data["recent"])
    assert {e["kind"] for e in data["recent"]} >= {"visit", "photo", "download"}
