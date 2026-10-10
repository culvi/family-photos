"""Cloudflare Access sign-in tokens: only a correctly signed token for this app counts."""

import asyncio
import base64
import json
import time

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from app import cf_access as cf

TEAM = "team.cloudflareaccess.com"
AUD = "aud123"


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_pn = KEY.public_key().public_numbers()
JWK = {"kid": "k1", "kty": "RSA", "alg": "RS256", "e": b64(_pn.e.to_bytes(3, "big")), "n": b64(_pn.n.to_bytes(256, "big"))}
KEYS = cf.public_keys({"keys": [JWK]})


def token(body, head=None, signer=KEY):
    h = b64(json.dumps(head or {"alg": "RS256", "kid": "k1"}).encode())
    p = b64(json.dumps(body).encode())
    s = signer.sign(f"{h}.{p}".encode(), padding.PKCS1v15(), hashes.SHA256())
    return f"{h}.{p}.{b64(s)}"


def good():
    now = time.time()
    return {"aud": [AUD], "iss": f"https://{TEAM}", "exp": now + 600, "iat": now - 5, "email": "Nadia@Gmail.com"}


def check(tok):
    return cf.verified_email(tok, KEYS, team_domain=TEAM, audience=AUD)


def test_valid_token_gives_lowercased_email():
    assert check(token(good())) == "nadia@gmail.com"
    assert check(token(dict(good(), aud=AUD))) == "nadia@gmail.com"


@pytest.mark.parametrize(
    "change",
    [
        {"aud": ["another-app"]},
        {"iss": "https://evil.cloudflareaccess.com"},
        {"exp": time.time() - 120},
        {"iat": time.time() + 600},
        {"email": None},
    ],
)
def test_wrong_claims_are_rejected(change):
    body = {k: v for k, v in dict(good(), **change).items() if v is not None}
    assert check(token(body)) is None


def test_bad_signatures_and_algorithms_are_rejected():
    assert check(token(good(), signer=OTHER)) is None
    assert check(token(good(), head={"alg": "none", "kid": "k1"})) is None
    assert check(token(good(), head={"alg": "HS256", "kid": "k1"})) is None
    assert check(token(good(), head={"alg": "RS256", "kid": "unknown"})) is None
    h, _, s = token(good()).split(".")
    forged = b64(json.dumps(dict(good(), email="evil@x.com")).encode())
    assert check(f"{h}.{forged}.{s}") is None
    assert check("garbage") is None and check("a.b.c") is None


def test_verifier_fetches_team_keys_once():
    calls = []

    async def fetch(url):
        calls.append(url)
        return {"keys": [JWK]}

    verifier = cf.AccessVerifier(f"https://{TEAM}/", AUD, fetch)
    assert asyncio.run(verifier.email(token(good()))) == "nadia@gmail.com"
    assert asyncio.run(verifier.email(token(good()))) == "nadia@gmail.com"
    assert calls == [f"https://{TEAM}/cdn-cgi/access/certs"]
    assert asyncio.run(verifier.email(None)) is None
