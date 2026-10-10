"""Comments, reactions and the activity feed are off unless SOCIAL_ENABLED is set."""

from app.config import settings
from app.main import app


def _paths():
    return {getattr(route, "path", "") for route in app.routes}


def test_social_off_by_default():
    assert settings.social_enabled is False


def test_social_routes_not_registered():
    paths = _paths()
    assert "/api/activity" not in paths
    assert "/api/assets/{asset_id}/comments" not in paths
    assert "/api/assets/{asset_id}/reactions" not in paths
    assert "/api/comments/{comment_id}" not in paths
