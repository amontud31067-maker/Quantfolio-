import json
import pytest
from starlette.testclient import TestClient
import app as main_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    test_db_file = tmp_path / "test_users.json"
    password = "correct_password_123"
    salted_hash = main_app._hash_password(password)
    db_content = {
        "users": {
            "victim@example.com": {
                "id": "victim_user_1",
                "user_id": "victim_user_1",
                "email": "victim@example.com",
                "full_name": "Victim User",
                "password_hash": salted_hash,
                "created_at": 1700000000.0,
                "updated_at": 1700000000.0,
            }
        },
        "portfolios": {}
    }
    test_db_file.write_text(json.dumps(db_content), encoding="utf-8")
    monkeypatch.setattr(main_app, "_get_db_file_path", lambda: str(test_db_file))
    main_app._login_attempts.clear()
    return TestClient(main_app.app)


def test_attacker_cannot_lock_out_victim(client):
    """
    Topic 2: Rate limit must NOT allow an attacker to lock out a victim's account.
    Attacker from IP 198.51.100.1 fails 5 times on victim@example.com.
    Victim from IP 203.0.113.50 must still be able to log in with correct credentials.
    """
    # Attacker attempts 5 wrong passwords from attacker IP
    for _ in range(5):
        resp = client.post(
            "/api/auth/login",
            json={"email": "victim@example.com", "password": "wrong_password_999"},
            headers={"X-Forwarded-For": "198.51.100.1"}
        )
        assert resp.status_code in [401, 429]

    # Attacker should now be blocked
    resp_attacker = client.post(
        "/api/auth/login",
        json={"email": "victim@example.com", "password": "wrong_password_999"},
        headers={"X-Forwarded-For": "198.51.100.1"}
    )
    assert resp_attacker.status_code == 429, "Attacker should be rate-limited (429)"

    # Victim logs in from their own IP with the correct password.
    # MUST SUCCEED (200), NOT BE LOCKED OUT BY ATTACKER!
    resp_victim = client.post(
        "/api/auth/login",
        json={"email": "victim@example.com", "password": "correct_password_123"},
        headers={"X-Forwarded-For": "203.0.113.50"}
    )
    assert resp_victim.status_code == 200, f"Victim was locked out by attacker! Status: {resp_victim.status_code}, {resp_victim.text}"
    assert resp_victim.json()["user"]["email"] == "victim@example.com"


def test_cors_does_not_permit_arbitrary_untrusted_origins(client):
    """
    Topic 2: CORS must not be open to any wildcard/untrusted origin.
    An untrusted origin must not be granted Access-Control-Allow-Origin.
    """
    untrusted_origin = "https://evil-phishing-site.com"
    resp = client.options(
        "/api/auth/login",
        headers={
            "Origin": untrusted_origin,
            "Access-Control-Request-Method": "POST",
        }
    )
    # Untrusted origin should NOT be reflected or wildcarded in Access-Control-Allow-Origin
    allow_origin = resp.headers.get("access-control-allow-origin")
    assert allow_origin != "*", "CORS allow-origin must not be wildcard '*'"
    assert allow_origin != untrusted_origin, f"CORS must not allow untrusted origin {untrusted_origin}"
