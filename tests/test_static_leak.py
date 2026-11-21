"""Regression: the public /static route must never expose the user DB or source."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest
from test_access_control import ASGITestClient, quantfolio_app

SENSITIVE = [
    "/static/quantfolio_users_db.json",
    "/static/app.py",
    "/static/optimizer.py",
    "/static/supabase_schema.sql",
    "/static/.gitignore",
    "/static/../app.py",
    "/static/..%2fapp.py",
    "/static/%2e%2e/quantfolio_users_db.json",
    "/static/..%5cquantfolio_users_db.json",
    "/static/%00",
]


@pytest.mark.parametrize("path", SENSITIVE)
def test_sensitive_files_are_not_served(path):
    client = ASGITestClient(quantfolio_app.app)
    res = client.get(path)
    assert res.status_code in (404, 400), f"LEAK: {path} returned {res.status_code}"
    assert "password_hash" not in res.text
    assert "def _hash_password" not in res.text


@pytest.mark.parametrize("path", ["/", "/app.js", "/styles.css", "/supabase_auth.js"])
def test_public_assets_still_served(path):
    client = ASGITestClient(quantfolio_app.app)
    assert client.get(path).status_code == 200


def test_public_assets_fallback_to_root_allowlist_only_when_static_missing(tmp_path, monkeypatch):
    """When static/ is missing on deployment (e.g. root-only upload or serverless build),
    explicitly allowlisted frontend files fall back safely to root while source/DB stay blocked."""
    monkeypatch.setattr(quantfolio_app, "STATIC_DIR", str(tmp_path / "missing_static"))
    client = ASGITestClient(quantfolio_app.app)

    root_res = client.get("/")
    assert root_res.status_code == 200
    assert "was not found" not in root_res.text
    assert "QuantFolio" in root_res.text

    for public_path in ("/app.js", "/styles.css", "/supabase_auth.js"):
        assert client.get(public_path).status_code == 200

    for blocked_path in ("/static/app.py", "/static/quantfolio_users_db.json", "/static/../app.py"):
        assert client.get(blocked_path).status_code in (400, 404)
