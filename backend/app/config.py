"""Configuration settings for the gated photos viewer."""

from pydantic_settings import BaseSettings, NoDecode
from pydantic import field_validator
from typing import Annotated, List
import json


class Settings(BaseSettings):
    immich_url: str = "http://127.0.0.1:2283"
    immich_api_key: str = ""

    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False

    cors_origins: Annotated[List[str], NoDecode] = ["http://127.0.0.1:8080"]
    public_base_url: str = "http://127.0.0.1:8080"

    session_secret: str = ""
    tokens_db_path: str = "/data/tokens.db"

    # X-Forwarded-For/X-Real-IP are attacker-controlled unless the direct TCP peer is
    # a trusted reverse proxy — trusting them unconditionally lets anyone bypass
    # IP-based rate limiting by forging the header. Off by default (safe: falls back
    # to the direct peer address). Enable only alongside trusted_proxy_ips below.
    trust_x_forwarded_for: bool = False
    # IPs or CIDR ranges (e.g. Caddy's address, or your Docker bridge network) allowed
    # to set X-Forwarded-For/X-Real-IP. Required for trust_x_forwarded_for to take effect.
    trusted_proxy_ips: Annotated[List[str], NoDecode] = []

    cache_ttl_people: int = 300
    # People page "More faces": unnamed people who appear in at least this many photos.
    unnamed_min_photos: int = 5
    # Comments, reactions and the activity feed. Off: the routes aren't registered at all.
    social_enabled: bool = False
    cache_ttl_suggestions: int = 600

    # Places page: Immich's own map (vector tiles + light/dark styles). The page may fetch
    # map data from map_connect_src and nothing else outside this site.
    map_style_light: str = "https://tiles.immich.cloud/v1/style/light.json"
    map_style_dark: str = "https://tiles.immich.cloud/v1/style/dark.json"
    map_connect_src: str = "https://*.immich.cloud"

    # Cloudflare Access sign-in: with both set, people signed in through Access are let
    # in as themselves (no access code) and show up in "who's here". Team domain like
    # "jarvis-homelab.cloudflareaccess.com"; AUD is the Access application's audience tag.
    cf_access_team_domain: str = ""
    cf_access_aud: str = ""
    # Who may open the Usage page (emails, comma-separated).
    admin_emails: Annotated[List[str], NoDecode] = []
    # Display names for signed-in people, "email=Name" comma-separated. The name also
    # picks their face from Immich's people. Unlisted emails show their email's first part.
    members: Annotated[List[str], NoDecode] = []

    # Previews and originals persist under ./data so they survive image rebuilds.
    media_cache_dir: str = "/data/media-cache"
    media_cache_max_bytes: int = 8 * 1024 * 1024 * 1024

    @field_validator("cors_origins", "trusted_proxy_ips", "admin_emails", "members", mode="before")
    @classmethod
    def parse_str_list(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if v.startswith("["):
                return json.loads(v)
            return [item.strip() for item in v.split(",") if item.strip()]
        return v

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "case_sensitive": False,
        "extra": "ignore",
    }


settings = Settings()

if not settings.session_secret:
    raise RuntimeError(
        "SESSION_SECRET is required (openssl rand -hex 32). Refusing to start with an ephemeral secret."
    )
