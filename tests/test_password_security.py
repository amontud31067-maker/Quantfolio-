import hashlib
import json
import pytest
from starlette.testclient import TestClient
import app as main_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    test_db_file = tmp_path / "test_users.json"
    test_db_file.write_text(json.dumps({"users": {}, "portfolios": {}}), encoding="utf-8")
    monkeypatch.setattr(main_app, "_get_db_file_path", lambda: str(test_db_file))
    main_app._login_attempts.clear()
    return TestClient(main_app.app)


def test_unsalted_legacy_sha256_hash_is_rejected(client, tmp_path):
    """
    Topic 1: Legacy unsalted SHA-256 hashes must NOT be accepted.
    Only salted PBKDF2-SHA256 hashes should authenticate.
    """
    test_db_file = tmp_path / "test_users.json"
    
    # Store an unsalted SHA-256 hash
    password = "legacy_password_123"
    legacy_hash = hashlib.sha256(password.encode("utf-8")).hexdigest()
    
    db_content = {
        "users": {
            "legacy@example.com": {
                "id": "legacy_user_1",
                "user_id": "legacy_user_1",
                "email": "legacy@example.com",
                "full_name": "Legacy User",
                "password_hash": legacy_hash,
                "created_at": 1700000000.0,
                "updated_at": 1700000000.0,
            }
        },
        "portfolios": {}
    }
    test_db_file.write_text(json.dumps(db_content), encoding="utf-8")
    
    # Attempt login with the valid plaintext password
    resp = client.post("/api/auth/login", json={
        "email": "legacy@example.com",
        "password": password
    })
    
    # The requirement strictly says: "ยกเลิก fallback hash แบบเก่าไม่มี salt"
    # An unsalted SHA-256 hash must NOT authenticate (HTTP 401).
    assert resp.status_code == 401, f"Expected 401 rejected for unsalted hash, got {resp.status_code}: {resp.text}"


def test_password_minimum_length_8_enforced(client):
    """
    Topic 1: Passwords must be at least 8 characters long.
    Passwords with length 6 or 7 must be rejected with HTTP 400.
    """
    for short_pw in ["123456", "abcdefg"]:
        assert len(short_pw) < 8
        resp = client.post("/api/auth/login", json={
            "email": "test@example.com",
            "password": short_pw
        })
        assert resp.status_code == 400, f"Expected 400 for password length {len(short_pw)}, got {resp.status_code}"
        assert "8" in resp.json().get("detail", ""), f"Detail should mention 8 characters: {resp.text}"


def test_salted_pbkdf2_with_length_ge_8_succeeds(client, tmp_path):
    """
    Verify that valid salted PBKDF2 hash with length >= 8 succeeds.
    """
    test_db_file = tmp_path / "test_users.json"
    password = "valid_secure_pass123"
    salted_hash = main_app._hash_password(password)
    db_content = {
        "users": {
            "valid@example.com": {
                "id": "valid_user_1",
                "user_id": "valid_user_1",
                "email": "valid@example.com",
                "full_name": "Valid User",
                "password_hash": salted_hash,
                "created_at": 1700000000.0,
                "updated_at": 1700000000.0,
            }
        },
        "portfolios": {}
    }
    test_db_file.write_text(json.dumps(db_content), encoding="utf-8")
    
    resp = client.post("/api/auth/login", json={
        "email": "valid@example.com",
        "password": password
    })
    assert resp.status_code == 200, f"Expected 200 OK for valid credentials, got {resp.status_code}: {resp.text}"
    data = resp.json()
    assert data["user"]["email"] == "valid@example.com"


def test_frontend_scripts_enforce_minimum_8_chars():
    """
    Topic 1: Frontend scripts must enforce min 8 chars (not 6).
    """
    for fn in ["supabase_auth.js", "static/supabase_auth.js"]:
        with open(fn, "r", encoding="utf-8") as f:
            content = f.read()
        assert "password.length < 6" not in content, f"{fn} still contains legacy 'password.length < 6'"
        assert "password.length < 8" in content, f"{fn} should check 'password.length < 8'"
        assert "อย่างน้อย 8 ตัวอักษร" in content, f"{fn} alert should mention 8 characters"
