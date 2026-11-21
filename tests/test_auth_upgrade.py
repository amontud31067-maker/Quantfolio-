import json
import os
import re
import pytest
from starlette.testclient import TestClient
import app as main_app


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel_path: str) -> str:
    with open(os.path.join(ROOT, rel_path), "r", encoding="utf-8") as f:
        return f.read()


@pytest.fixture
def client(tmp_path, monkeypatch):
    test_db_file = tmp_path / "auth_upgrade_users.json"
    test_db_file.write_text(json.dumps({"users": {}, "portfolios": {}}), encoding="utf-8")
    monkeypatch.setattr(main_app, "_get_db_file_path", lambda: str(test_db_file))
    main_app._login_attempts.clear()
    return TestClient(main_app.app), test_db_file


def test_duplicate_signup_returns_409_and_signin_preserves_name(client):
    tc, _ = client
    email = "investor.alpha@example.com"
    pw = "StrongPass#2026"

    r1 = tc.post("/api/auth/login", json={
        "email": email,
        "password": pw,
        "full_name": "คุณอัลฟ่า นักลงทุน",
        "mode": "signup",
    })
    assert r1.status_code == 200, r1.text
    assert r1.json()["action"] == "signed_up"
    assert r1.json()["user"]["user_metadata"]["full_name"] == "คุณอัลฟ่า นักลงทุน"

    # Duplicate signup on existing email must fail with HTTP 409 Conflict
    r_dup = tc.post("/api/auth/login", json={
        "email": email,
        "password": pw,
        "full_name": "Attempt Overwrite",
        "mode": "signup",
    })
    assert r_dup.status_code == 409, f"Expected 409 Conflict, got {r_dup.status_code}: {r_dup.text}"
    assert "เข้าสู่ระบบ" in r_dup.json().get("detail", "")

    # Sign-in must succeed and preserve existing display name
    r_in = tc.post("/api/auth/login", json={
        "email": email,
        "password": pw,
        "full_name": "",
        "mode": "signin",
    })
    assert r_in.status_code == 200, r_in.text
    assert r_in.json()["user"]["user_metadata"]["full_name"] == "คุณอัลฟ่า นักลงทุน"


def test_auth_me_endpoint_valid_invalid_and_deleted(client):
    tc, _ = client
    # Missing / invalid token rejected
    assert tc.get("/api/auth/me").status_code == 401
    assert tc.get("/api/auth/me", headers={"Authorization": "Bearer invalid.token.here"}).status_code == 401

    r_up = tc.post("/api/auth/login", json={
        "email": "me.check@example.com",
        "password": "Password#1234",
        "full_name": "Somchai Quant",
        "mode": "signup",
    })
    assert r_up.status_code == 200
    token = r_up.json()["token"]

    r_me = tc.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r_me.status_code == 200, r_me.text
    user_data = r_me.json()["user"]
    assert user_data["email"] == "me.check@example.com"
    assert user_data["user_metadata"]["full_name"] == "Somchai Quant"
    assert str(user_data["user_metadata"]["avatar_url"]).startswith("data:image/svg+xml")

    # Delete account -> old token must immediately fail /api/auth/me with 401
    r_del = tc.delete("/api/auth/account", headers={"Authorization": f"Bearer {token}"})
    assert r_del.status_code == 200
    r_me_after = tc.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r_me_after.status_code == 401


def test_patch_auth_profile_updates_name_and_svg_avatar(client):
    tc, _ = client
    r_up = tc.post("/api/auth/login", json={
        "email": "profile.edit@example.com",
        "password": "Password#1234",
        "full_name": "Initial Name",
        "mode": "signup",
    })
    assert r_up.status_code == 200
    token = r_up.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    # Validation checks
    assert tc.patch("/api/auth/profile", headers=headers, json={"full_name": "   "}).status_code == 400
    assert tc.patch("/api/auth/profile", headers=headers, json={"full_name": "x" * 81}).status_code == 400

    # Valid profile update
    r_patch = tc.patch("/api/auth/profile", headers=headers, json={"full_name": "คุณนภา พอร์ตแกร่ง"})
    assert r_patch.status_code == 200, r_patch.text
    meta = r_patch.json()["user"]["user_metadata"]
    assert meta["full_name"] == "คุณนภา พอร์ตแกร่ง"
    assert str(meta["avatar_url"]).startswith("data:image/svg+xml")
    assert "ui-avatars.com" not in str(meta["avatar_url"])

    # Verify persisted via /api/auth/me
    r_me = tc.get("/api/auth/me", headers=headers)
    assert r_me.status_code == 200
    assert r_me.json()["user"]["user_metadata"]["full_name"] == "คุณนภา พอร์ตแกร่ง"


def test_change_password_verifies_current_and_rotates_token(client):
    tc, db_file = client
    email = "pw.rotate@example.com"
    old_pw = "OldSecret#2025"
    new_pw = "NewSecret#2026"

    r_up = tc.post("/api/auth/login", json={
        "email": email,
        "password": old_pw,
        "full_name": "Security Tester",
        "mode": "signup",
    })
    assert r_up.status_code == 200
    token = r_up.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    # Wrong current password -> 401
    r_wrong = tc.post("/api/auth/change-password", headers=headers, json={
        "current_password": "WrongPassword99",
        "new_password": new_pw,
    })
    assert r_wrong.status_code == 401

    # Short new password (<8) -> 400
    r_short = tc.post("/api/auth/change-password", headers=headers, json={
        "current_password": old_pw,
        "new_password": "short12",
    })
    assert r_short.status_code == 400

    # Same password -> 400
    r_same = tc.post("/api/auth/change-password", headers=headers, json={
        "current_password": old_pw,
        "new_password": old_pw,
    })
    assert r_same.status_code == 400

    # Valid password change -> 200 + rotated token + salted PBKDF2-SHA256 hash
    r_ok = tc.post("/api/auth/change-password", headers=headers, json={
        "current_password": old_pw,
        "new_password": new_pw,
    })
    assert r_ok.status_code == 200, r_ok.text
    new_token = r_ok.json().get("token")
    assert new_token

    db_data = json.loads(db_file.read_text(encoding="utf-8"))
    stored_hash = db_data["users"][email]["password_hash"]
    assert stored_hash.startswith("pbkdf2_sha256$")

    # New token works with /api/auth/me
    assert tc.get("/api/auth/me", headers={"Authorization": f"Bearer {new_token}"}).status_code == 200

    # Old password rejected, new password accepted
    assert tc.post("/api/auth/login", json={"email": email, "password": old_pw, "mode": "signin"}).status_code == 401
    assert tc.post("/api/auth/login", json={"email": email, "password": new_pw, "mode": "signin"}).status_code == 200


def test_frontend_auth_ui_dark_mode_and_safety_guards():
    for html_path in ("index.html", "static/index.html"):
        html_txt = _read(html_path)
        for required_id in (
            'id="header-account-menu-btn"',
            'id="header-account-menu"',
            'id="account-settings-modal"',
            'id="delete-account-confirm-modal"',
            'id="auth-password-strength-wrap"',
            'id="real-auth-password-confirm"',
            'id="auth-remember-email"',
            'id="auth-google-oauth-section"',
            'id="btn-confirm-delete-account"',
        ):
            assert required_id in html_txt, f"Missing {required_id} in {html_path}"

        # Legacy bright white technical diagnostic badge must be removed
        assert 'id="google-provider-status-badge"' not in html_txt, f"Legacy diagnostic badge still in {html_path}"

        # Google OAuth section must default to hidden until verified enabled
        assert re.search(r'id="auth-google-oauth-section"\s+class="[^"]*\bhidden\b', html_txt), (
            f"#auth-google-oauth-section must start hidden in {html_path}"
        )

        # Delete account must never be triggered directly from top navbar box (must open confirm modal)
        logged_in_match = re.search(
            r'id="auth-logged-in-box".*?id="header-landing-cta-btn"',
            html_txt,
            flags=re.DOTALL,
        )
        assert logged_in_match, f"Could not inspect #auth-logged-in-box in {html_path}"
        logged_in_block = logged_in_match.group(0)
        assert "openDeleteAccountModal()" in logged_in_block
        assert "deleteUserAccount()" not in logged_in_block

    for css_path in ("styles.css", "static/styles.css"):
        css_txt = _read(css_path)
        for selector in (
            "html body.theme-dark #header-account-menu-btn",
            "html body.theme-dark #header-account-menu",
            "html body.theme-dark #supabase-config-modal .qf-auth-modal-card",
            "html body.theme-dark .qf-auth-tab-tray",
            "html body.theme-dark .qf-auth-tab-btn.active",
            "html body.theme-dark #account-settings-modal #btn-change-password",
        ):
            assert selector in css_txt, f"Missing Dark Mode CSS selector {selector} in {css_path}"

    for js_path in ("supabase_auth.js", "static/supabase_auth.js"):
        js_txt = _read(js_path)
        for token in (
            "/api/auth/me",
            "/api/auth/profile",
            "/api/auth/change-password",
            "toggleHeaderAccountMenu",
            "toggleAuthPasswordVisibility",
            "updateAuthPasswordStrength",
            "openAccountSettingsModal",
            "openDeleteAccountModal",
            "validateDeleteAccountConfirmInput",
            "deleteUserAccount",
            "password.length < 8",
        ):
            assert token in js_txt, f"Missing {token} in {js_path}"
        # Logout must not blindly wipe Guest portfolios key
        assert "k.startsWith('quantfolio_portfolios_')" not in js_txt, (
            f"Logout in {js_path} still wipes Guest portfolios!"
        )
