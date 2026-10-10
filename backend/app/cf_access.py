"""Who's signed in, from Cloudflare Access.

Cloudflare Access signs everyone in by email before a request ever reaches the site, and
forwards a signed token (a JWT) naming them. Checking that token's signature against the
team's published keys proves the request came through Access as that person, so the
site can say "this is Nadia" without a code of its own.

Off unless CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are both set. Requests that don't come
through Access (e.g. straight to the server on the home network) carry no token and fall
back to the access-code sign-in.
"""

from __future__ import annotations

import base64
import json
import logging
import time
from typing import Any, Awaitable, Callable, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

log = logging.getLogger(__name__)

HEADER = "cf-access-jwt-assertion"
COOKIE = "CF_Authorization"
LEEWAY_SECONDS = 60
KEYS_TTL_SECONDS = 3600
MIN_REFETCH_SECONDS = 60


def _b64url(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _int(data: str) -> int:
    return int.from_bytes(_b64url(data), "big")


def public_keys(jwks: Any) -> dict[str, rsa.RSAPublicKey]:
    """{kid: key} from Cloudflare's certs document ({"keys": [JWK, ...]}); RSA keys only."""
    keys: dict[str, rsa.RSAPublicKey] = {}
    for jwk in (jwks or {}).get("keys", []) if isinstance(jwks, dict) else []:
        if not isinstance(jwk, dict) or jwk.get("kty") != "RSA" or not jwk.get("kid"):
            continue
        try:
            keys[jwk["kid"]] = rsa.RSAPublicNumbers(_int(jwk["e"]), _int(jwk["n"])).public_key()
        except (KeyError, ValueError, TypeError):
            continue
    return keys


def verified_email(
    token: str,
    keys: dict[str, rsa.RSAPublicKey],
    *,
    team_domain: str,
    audience: str,
    now: Optional[float] = None,
) -> Optional[str]:
    """The signed-in email if `token` is a valid Access token for this app, else None."""
    try:
        head_b64, body_b64, sig_b64 = token.split(".")
        head = json.loads(_b64url(head_b64))
        body = json.loads(_b64url(body_b64))
        signature = _b64url(sig_b64)
    except (ValueError, TypeError):
        return None
    if not isinstance(head, dict) or not isinstance(body, dict):
        return None
    if head.get("alg") != "RS256":
        return None  # never "none", never HMAC with a public key
    key = keys.get(head.get("kid"))
    if key is None:
        return None
    try:
        key.verify(signature, f"{head_b64}.{body_b64}".encode(), padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature:
        return None

    now = time.time() if now is None else now
    audiences = body.get("aud")
    audiences = [audiences] if isinstance(audiences, str) else audiences
    if not isinstance(audiences, list) or audience not in audiences:
        return None  # signed for a different Access app
    if body.get("iss") != f"https://{team_domain}":
        return None
    exp = body.get("exp")
    if not isinstance(exp, (int, float)) or exp + LEEWAY_SECONDS < now:
        return None
    nbf = body.get("nbf", body.get("iat"))
    if isinstance(nbf, (int, float)) and nbf - LEEWAY_SECONDS > now:
        return None
    email = body.get("email")
    if not isinstance(email, str) or "@" not in email:
        return None  # service tokens carry no email
    return email.strip().lower()


class AccessVerifier:
    """Verifies tokens against the team's keys, fetched and cached (re-fetched on rotation)."""

    def __init__(self, team_domain: str, audience: str, fetch_json: Callable[[str], Awaitable[Any]]):
        self.team_domain = team_domain.strip().removeprefix("https://").rstrip("/")
        self.audience = audience.strip()
        self._fetch_json = fetch_json
        self._keys: dict[str, rsa.RSAPublicKey] = {}
        self._fetched_at = 0.0

    @property
    def certs_url(self) -> str:
        return f"https://{self.team_domain}/cdn-cgi/access/certs"

    async def _refresh(self, force: bool = False) -> None:
        age = time.time() - self._fetched_at
        if not force and self._keys and age < KEYS_TTL_SECONDS:
            return
        if force and age < MIN_REFETCH_SECONDS:
            return  # a stream of bad tokens mustn't hammer Cloudflare
        self._fetched_at = time.time()
        try:
            keys = public_keys(await self._fetch_json(self.certs_url))
        except Exception as error:  # network trouble: keep the old keys
            log.warning("Could not fetch Cloudflare Access keys: %s", error)
            return
        if keys:
            self._keys = keys

    async def email(self, token: Optional[str]) -> Optional[str]:
        if not token:
            return None
        await self._refresh()
        args = dict(team_domain=self.team_domain, audience=self.audience)
        result = verified_email(token, self._keys, **args)
        if result is None and self._kid(token) not in self._keys:
            await self._refresh(force=True)  # keys may have rotated
            result = verified_email(token, self._keys, **args)
        return result

    @staticmethod
    def _kid(token: str) -> Optional[str]:
        try:
            return json.loads(_b64url(token.split(".")[0])).get("kid")
        except (ValueError, TypeError, AttributeError, IndexError):
            return None
