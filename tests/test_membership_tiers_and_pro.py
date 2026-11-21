"""
TDD & Regression Suite for the 4-Tier Membership System (Guest -> Free Member -> QuantFolio Pro -> Advisor Pro),
Backend Entitlements Enforcement (/api/optimize, /api/market-news, /api/portfolios),
and Owner/Admin + Activation-Code Payment Control (/api/auth/subscription, /api/admin/users, /api/admin/set-user-tier).
"""
import json
import os
import re
from datetime import datetime, timedelta, timezone
import numpy as np
import pandas as pd
import pytest
from starlette.testclient import TestClient

import app as main_app
import optimizer as opt_module

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel_path: str) -> str:
    with open(os.path.join(ROOT, rel_path), "r", encoding="utf-8") as f:
        return f.read()


@pytest.fixture
def tier_client(tmp_path, monkeypatch):
    db_file = tmp_path / "membership_tiers_db.json"
    db_file.write_text(
        json.dumps({"users": {}, "portfolios": [], "activation_codes": [], "upgrade_requests": []}),
        encoding="utf-8",
    )
    monkeypatch.setattr(main_app, "_get_db_file_path", lambda: str(db_file))
    main_app._login_attempts.clear()
    main_app._redeem_fail_attempts.clear()

    # Deterministic synthetic market prices for up to 27 tickers so /api/optimize runs fast & offline
    dates = pd.bdate_range("2023-01-02", periods=280)
    rng = np.random.default_rng(2026)
    all_syms = [f"SYM{i:02d}" for i in range(1, 28)]
    rets = rng.normal(0.0006, 0.014, size=(len(dates), len(all_syms)))
    full_prices = pd.DataFrame(100.0 * np.cumprod(1.0 + rets, axis=0), index=dates, columns=all_syms)

    def _fake_fetch_historical_prices(tickers, start_date, end_date):
        cols = [t for t in tickers if t in full_prices.columns]
        if not cols or len(cols) != len(tickers):
            cols = all_syms[: len(tickers)]
            df = full_prices[cols].copy()
            df.columns = list(tickers)
        else:
            df = full_prices[cols].copy()
        df.attrs["raw_last_dates"] = {t: dates[-1].strftime("%Y-%m-%d") for t in tickers}
        return df, list(tickers), []

    def _fake_raw_news(ticker: str, max_items: int = 5, force_refresh: bool = False):
        return {
            "ticker": ticker,
            "news_sentiment_score": 0.42,
            "positive_count": 1,
            "negative_count": 0,
            "neutral_count": 0,
            "articles": [
                {
                    "ticker": ticker,
                    "title": f"{ticker} record earnings beat expectations",
                    "publisher": "QuantFolio Test Wire",
                    "link": f"https://finance.yahoo.com/quote/{ticker}",
                    "published_at": "2026-11-21 10:00",
                    "sentiment": "positive",
                    "sentiment_label_th": "ข่าวเชิงบวก",
                    "sentiment_score": 0.42,
                }
            ],
        }

    monkeypatch.setattr(opt_module, "fetch_historical_prices", _fake_fetch_historical_prices)
    monkeypatch.setattr(opt_module, "get_usd_thb_rate", lambda: 34.50)
    monkeypatch.setattr(opt_module, "get_risk_free_rate", lambda **kwargs: 0.0225)
    monkeypatch.setattr(opt_module, "convert_prices_to_base_currency", lambda prices, **kwargs: prices.copy())
    monkeypatch.setattr(opt_module, "fetch_market_news_for_ticker", _fake_raw_news)

    return TestClient(main_app.app), db_file


def test_four_tier_entitlements_matrix_definitions():
    guest = main_app._get_user_entitlements("guest")
    free = main_app._get_user_entitlements("free")
    pro = main_app._get_user_entitlements("pro")
    advisor = main_app._get_user_entitlements("advisor")

    assert guest["max_assets"] == 5
    assert guest["max_saved_portfolios"] == 1
    assert guest["can_view_news"] is False
    assert guest["can_download_sim_pdf"] is False
    assert guest["can_customize_bl_views"] is False
    assert guest["can_whitelabel_advisor_pdf"] is False

    assert free["max_assets"] == 8
    assert free["max_saved_portfolios"] == 3
    assert free["can_view_news"] is True
    assert free["can_download_sim_pdf"] is True
    assert free["can_customize_bl_views"] is False
    assert free["can_whitelabel_advisor_pdf"] is False
    assert free["safe_bl_confidence_cap"] == 0.35

    assert pro["max_assets"] == 15
    assert pro["max_saved_portfolios"] == 20
    assert pro["can_view_news"] is True
    assert pro["can_download_sim_pdf"] is True
    assert pro["can_customize_bl_views"] is True
    assert pro["can_whitelabel_advisor_pdf"] is False
    assert pro["safe_bl_confidence_cap"] == 1.00

    assert advisor["max_assets"] == 25
    assert "25 หุ้น" in advisor["badge_text"]
    assert advisor["max_saved_portfolios"] == 9999
    assert advisor["can_view_news"] is True
    assert advisor["can_download_sim_pdf"] is True
    assert advisor["can_customize_bl_views"] is True
    assert advisor["can_whitelabel_advisor_pdf"] is True
    assert advisor["safe_bl_confidence_cap"] == 1.00


def test_guest_news_gate_and_5_asset_limit_on_backend(tier_client):
    tc, _ = tier_client

    # 1. Guest is blocked from GET /api/market-news with HTTP 403
    r_news_guest = tc.get("/api/market-news?tickers=SYM01,SYM02")
    assert r_news_guest.status_code == 403
    assert "สมัครสมาชิกฟรี" in r_news_guest.json()["detail"]

    # 2. Guest with 6 tickers is rejected by POST /api/optimize with HTTP 403
    r_opt_6 = tc.post(
        "/api/optimize",
        json={
            "tickers": ["SYM01", "SYM02", "SYM03", "SYM04", "SYM05", "SYM06"],
            "start_date": "2023-01-02",
            "end_date": "2024-01-15",
            "budget": 100000,
            "use_news_adjustment": True,
        },
    )
    assert r_opt_6.status_code == 403
    assert "5 สินทรัพย์" in r_opt_6.json()["detail"]

    # 3. Guest with 5 tickers succeeds, strips news articles, and forces pure historical mode
    r_opt_5 = tc.post(
        "/api/optimize",
        json={
            "tickers": ["SYM01", "SYM02", "SYM03", "SYM04", "SYM05"],
            "start_date": "2023-01-02",
            "end_date": "2024-01-15",
            "budget": 100000,
            "use_news_adjustment": True,
            "bl_confidence": 0.85,
            "bl_views": {"SYM01": 0.12},
        },
    )
    assert r_opt_5.status_code == 200, r_opt_5.text
    body = r_opt_5.json()
    assert body["metadata"]["plan_tier"] == "guest"
    assert body["metadata"]["applied_use_news_adjustment"] is False
    assert body["market_intelligence"]["news_locked_guest"] is True
    assert body["market_intelligence"]["articles"] == []
    for stat in body["asset_stats"]:
        assert stat["news"]["articles"] == []


def test_free_member_8_asset_limit_3_portfolio_quota_and_safe_35pct_bl_cap(tier_client):
    tc, _ = tier_client

    r_signup = tc.post(
        "/api/auth/login",
        json={
            "email": "member.free@example.com",
            "password": "Password#2026",
            "full_name": "Free Member Investor",
            "mode": "signup",
        },
    )
    assert r_signup.status_code == 200
    token = r_signup.json()["token"]
    user = r_signup.json()["user"]
    headers = {"Authorization": f"Bearer {token}"}

    assert user["plan_tier"] == "free"
    assert user["is_admin"] is False
    assert user["entitlements"]["max_assets"] == 8
    assert user["entitlements"]["max_saved_portfolios"] == 3

    # 1. Free Member CAN access GET /api/market-news
    r_news = tc.get("/api/market-news?tickers=SYM01,SYM02", headers=headers)
    assert r_news.status_code == 200
    assert len(r_news.json()["articles"]) >= 1

    # 2. Free Member with 9 tickers is blocked with HTTP 403
    r_opt_9 = tc.post(
        "/api/optimize",
        headers=headers,
        json={
            "tickers": [f"SYM{i:02d}" for i in range(1, 10)],
            "start_date": "2023-01-02",
            "end_date": "2024-01-15",
            "budget": 100000,
        },
    )
    assert r_opt_9.status_code == 403
    assert "8 สินทรัพย์" in r_opt_9.json()["detail"]

    # 3. Free Member with 8 tickers + use_news_adjustment=True has BL confidence capped at 0.35 and custom bl_views ignored
    r_opt_8 = tc.post(
        "/api/optimize",
        headers=headers,
        json={
            "tickers": [f"SYM{i:02d}" for i in range(1, 9)],
            "start_date": "2023-01-02",
            "end_date": "2024-01-15",
            "budget": 100000,
            "use_news_adjustment": True,
            "bl_confidence": 0.95,
            "bl_views": {"SYM01": 0.22},
        },
    )
    assert r_opt_8.status_code == 200, r_opt_8.text
    opt_data = r_opt_8.json()
    assert opt_data["metadata"]["plan_tier"] == "free"
    assert opt_data["metadata"]["applied_use_news_adjustment"] is True
    assert opt_data["metadata"]["applied_bl_confidence"] == 0.35
    assert opt_data["black_litterman"]["confidence"] == 0.35
    assert opt_data["black_litterman"]["applied_views"]["SYM01"] != 0.22

    # 4. Free Member can save up to 3 portfolios in Cloud Vault; 4th new portfolio returns HTTP 403
    saved_ids = []
    for idx in range(1, 4):
        r_save = tc.post(
            "/api/portfolios",
            headers=headers,
            json={"portfolio_name": f"แผนที่ {idx}", "tickers": ["SYM01", "SYM02"]},
        )
        assert r_save.status_code == 200, r_save.text
        saved_ids.append(r_save.json()["portfolio"]["id"])

    r_save_4th = tc.post(
        "/api/portfolios",
        headers=headers,
        json={"portfolio_name": "แผนที่ 4 เกินโควตา", "tickers": ["SYM01", "SYM02"]},
    )
    assert r_save_4th.status_code == 403
    assert "3 แผน" in r_save_4th.json()["detail"]

    # Updating an existing portfolio among the 3 is still allowed
    r_update_existing = tc.post(
        "/api/portfolios",
        headers=headers,
        json={"id": saved_ids[0], "portfolio_name": "แผนที่ 1 แก้ไขสำเร็จ", "tickers": ["SYM01", "SYM02"]},
    )
    assert r_update_existing.status_code == 200


def test_activation_code_verification_and_admin_customer_tier_control(tier_client):
    tc, _ = tier_client

    # 1. Register normal retail customer
    r_cust = tc.post(
        "/api/auth/login",
        json={
            "email": "customer.retail@example.com",
            "password": "Password#2026",
            "full_name": "Retail Customer",
            "mode": "signup",
        },
    )
    assert r_cust.status_code == 200
    cust_token = r_cust.json()["token"]
    cust_headers = {"Authorization": f"Bearer {cust_token}"}

    # 2. Normal customer CANNOT self-upgrade without a valid activation code
    r_no_code = tc.post(
        "/api/auth/subscription",
        headers=cust_headers,
        json={"plan_tier": "pro", "activation_code": ""},
    )
    assert r_no_code.status_code == 403

    r_bad_code = tc.post(
        "/api/auth/subscription",
        headers=cust_headers,
        json={"plan_tier": "pro", "activation_code": "WRONG-CODE-999"},
    )
    assert r_bad_code.status_code == 403

    # Normal customer CANNOT use Pro code to unlock Advisor Pro
    r_mismatch_code = tc.post(
        "/api/auth/subscription",
        headers=cust_headers,
        json={"plan_tier": "advisor", "activation_code": "QF-PRO-2026"},
    )
    assert r_mismatch_code.status_code == 403

    # Normal customer CANNOT access admin endpoints
    assert tc.get("/api/admin/users", headers=cust_headers).status_code == 403
    assert tc.post(
        "/api/admin/set-user-tier",
        headers=cust_headers,
        json={"target_email": "customer.retail@example.com", "plan_tier": "advisor"},
    ).status_code == 403

    # 3. Normal customer with valid QF-PRO-2026 code upgrades to QuantFolio Pro (15 assets, Custom BL Views)
    r_pro_ok = tc.post(
        "/api/auth/subscription",
        headers=cust_headers,
        json={"plan_tier": "pro", "activation_code": "QF-PRO-2026"},
    )
    assert r_pro_ok.status_code == 200, r_pro_ok.text
    pro_user = r_pro_ok.json()["user"]
    assert pro_user["plan_tier"] == "pro"
    assert pro_user["entitlements"]["max_assets"] == 15
    assert pro_user["entitlements"]["can_customize_bl_views"] is True
    assert pro_user["entitlements"]["can_whitelabel_advisor_pdf"] is False

    # Verify Pro user can now optimize 12 assets with custom BL confidence 0.85 and custom bl_views
    r_opt_12 = tc.post(
        "/api/optimize",
        headers=cust_headers,
        json={
            "tickers": [f"SYM{i:02d}" for i in range(1, 13)],
            "start_date": "2023-01-02",
            "end_date": "2024-01-15",
            "budget": 250000,
            "use_news_adjustment": True,
            "bl_confidence": 0.85,
            "bl_views": {"SYM01": 0.14},
        },
    )
    assert r_opt_12.status_code == 200, r_opt_12.text
    opt_12_data = r_opt_12.json()
    assert opt_12_data["metadata"]["plan_tier"] == "pro"
    assert opt_12_data["metadata"]["applied_bl_confidence"] == 0.85
    assert opt_12_data["black_litterman"]["applied_views"]["SYM01"] == 0.14

    # 4. Owner / Admin (amontud31067@gmail.com) gets is_admin=True and can manage all tiers without code
    r_admin = tc.post(
        "/api/auth/login",
        json={
            "email": "amontud31067@gmail.com",
            "password": "AdminPassword#2026",
            "full_name": "Amon Owner",
            "mode": "signup",
        },
    )
    assert r_admin.status_code == 200
    admin_body = r_admin.json()
    admin_token = admin_body["token"]
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    assert admin_body["user"]["is_admin"] is True

    # Admin can switch own tier in 1 click without activation code
    for target_t in ("advisor", "pro", "free", "advisor"):
        r_sw = tc.post(
            "/api/auth/subscription",
            headers=admin_headers,
            json={"plan_tier": target_t, "activation_code": ""},
        )
        assert r_sw.status_code == 200
        assert r_sw.json()["user"]["plan_tier"] == target_t

    # Admin can list users and upgrade customer.retail@example.com to advisor
    r_list = tc.get("/api/admin/users", headers=admin_headers)
    assert r_list.status_code == 200
    emails = [u["email"] for u in r_list.json()["users"]]
    assert "customer.retail@example.com" in emails

    r_set_cust = tc.post(
        "/api/admin/set-user-tier",
        headers=admin_headers,
        json={"target_email": "customer.retail@example.com", "plan_tier": "advisor"},
    )
    assert r_set_cust.status_code == 200
    assert r_set_cust.json()["target_user"]["plan_tier"] == "advisor"
    assert r_set_cust.json()["target_user"]["entitlements"]["can_whitelabel_advisor_pdf"] is True

    # Verify customer sees new Advisor Pro tier immediately on GET /api/auth/me
    r_cust_me = tc.get("/api/auth/me", headers=cust_headers)
    assert r_cust_me.status_code == 200
    assert r_cust_me.json()["user"]["plan_tier"] == "advisor"
    assert r_cust_me.json()["user"]["entitlements"]["can_whitelabel_advisor_pdf"] is True


def test_atomic_json_write_no_leftover_tmp_files(tier_client):
    _, db_file = tier_client
    payload = {
        "users": {"atomic@example.com": {"id": "u-atomic", "plan_tier": "pro"}},
        "portfolios": [],
        "activation_codes": [],
        "upgrade_requests": [],
    }
    main_app._save_db(payload)
    loaded = json.loads(db_file.read_text(encoding="utf-8"))
    assert loaded["users"]["atomic@example.com"]["plan_tier"] == "pro"
    leftover_tmps = [p.name for p in db_file.parent.iterdir() if p.name.endswith(".tmp")]
    assert leftover_tmps == []
    app_src = _read("app.py")
    assert "os.fsync(" in app_src and "os.replace(" in app_src


def test_activation_code_4_layers_secrets_format_and_rate_limit(tier_client):
    tc, db_file = tier_client

    # Register Admin + 3 customers
    def _signup(email, name):
        r = tc.post(
            "/api/auth/login",
            json={"email": email, "password": "Password#2026", "full_name": name, "mode": "signup"},
        )
        assert r.status_code == 200, r.text
        return {"Authorization": f"Bearer {r.json()['token']}"}

    admin_h = _signup("amontud31067@gmail.com", "Admin Owner")
    u1_h = _signup("user1@example.com", "User One")
    u2_h = _signup("user2@example.com", "User Two")
    u3_h = _signup("user3@example.com", "User Three")

    # 1. Admin generates Pro & Advisor codes using secrets (>= 8 random chars)
    r_c1 = tc.post(
        "/api/admin/codes",
        headers=admin_h,
        json={"plan_tier": "pro", "duration_days": 30, "max_uses": 1, "code_valid_days": 7, "note": "Single use"},
    )
    assert r_c1.status_code == 200, r_c1.text
    code1 = r_c1.json()["code"]
    assert re.match(r"^QF-PRO-[A-Z0-9]{4}-[A-Z0-9]{4}$", code1["code"])

    r_c_adv = tc.post(
        "/api/admin/codes",
        headers=admin_h,
        json={"plan_tier": "advisor", "duration_days": 30, "max_uses": 2, "code_valid_days": 30},
    )
    assert r_c_adv.status_code == 200
    code_adv = r_c_adv.json()["code"]
    assert re.match(r"^QF-ADV-[A-Z0-9]{4}-[A-Z0-9]{4}$", code_adv["code"])

    # Hardcoded QF-PRO-2026 must NOT bypass /api/auth/redeem-code, even for Admin!
    assert tc.post("/api/auth/redeem-code", headers=u1_h, json={"code": "QF-PRO-2026"}).status_code == 403
    assert tc.post("/api/auth/redeem-code", headers=admin_h, json={"code": "INVALID-ADMIN-TEST"}).status_code == 403

    # 2. Layer 1: Revoked code -> 403
    r_c_rev = tc.post(
        "/api/admin/codes",
        headers=admin_h,
        json={"plan_tier": "pro", "duration_days": 30, "max_uses": 5, "code_valid_days": 30},
    )
    rev_rec = r_c_rev.json()["code"]
    assert tc.post(f"/api/admin/codes/{rev_rec['id']}/revoke", headers=admin_h).status_code == 200
    assert tc.post("/api/auth/redeem-code", headers=u1_h, json={"code": rev_rec["code"]}).status_code == 403

    # 3. Layer 2: Expired code (code_expires_at in the past) -> 403
    r_c_exp = tc.post(
        "/api/admin/codes",
        headers=admin_h,
        json={"plan_tier": "pro", "duration_days": 30, "max_uses": 5, "code_valid_days": 30},
    )
    exp_rec = r_c_exp.json()["code"]
    raw_db = json.loads(db_file.read_text(encoding="utf-8"))
    for c in raw_db["activation_codes"]:
        if c["id"] == exp_rec["id"]:
            c["code_expires_at"] = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    db_file.write_text(json.dumps(raw_db), encoding="utf-8")
    assert tc.post("/api/auth/redeem-code", headers=u1_h, json={"code": exp_rec["code"]}).status_code == 403

    # 4. Layer 3: max_uses=1 -> User 1 succeeds, User 2 gets 403
    r_u1 = tc.post("/api/auth/redeem-code", headers=u1_h, json={"code": code1["code"]})
    assert r_u1.status_code == 200, r_u1.text
    assert r_u1.json()["user"]["plan_tier"] == "pro"
    assert tc.post("/api/auth/redeem-code", headers=u2_h, json={"code": code1["code"]}).status_code == 403

    # 5. Layer 4: Multi-use code -> same email cannot redeem twice (403), different email succeeds (200)
    r_adv_u1 = tc.post("/api/auth/redeem-code", headers=u1_h, json={"code": code_adv["code"]})
    assert r_adv_u1.status_code == 200
    assert r_adv_u1.json()["user"]["plan_tier"] == "advisor"
    assert tc.post("/api/auth/redeem-code", headers=u1_h, json={"code": code_adv["code"]}).status_code == 403
    assert tc.post("/api/auth/redeem-code", headers=u2_h, json={"code": code_adv["code"]}).status_code == 200

    # 6. Rate Limit: 10 failed redemption attempts -> 11th returns HTTP 429
    for attempt in range(10):
        r_fail = tc.post("/api/auth/redeem-code", headers=u3_h, json={"code": f"QF-PRO-BAD{attempt:02d}-XXXX"})
        assert r_fail.status_code == 403, f"Attempt {attempt + 1} expected 403, got {r_fail.status_code}"
    r_rate = tc.post("/api/auth/redeem-code", headers=u3_h, json={"code": "QF-PRO-OVER-LIMT"})
    assert r_rate.status_code == 429


def test_tier_change_guard_no_downgrade_and_no_code_deduction(tier_client):
    tc, db_file = tier_client

    admin_h = {
        "Authorization": "Bearer "
        + tc.post(
            "/api/auth/login",
            json={"email": "amontud31067@gmail.com", "password": "Password#2026", "full_name": "Admin", "mode": "signup"},
        ).json()["token"]
    }
    adv_h = {
        "Authorization": "Bearer "
        + tc.post(
            "/api/auth/login",
            json={"email": "vip.advisor@example.com", "password": "Password#2026", "full_name": "VIP", "mode": "signup"},
        ).json()["token"]
    }
    pro_h = {
        "Authorization": "Bearer "
        + tc.post(
            "/api/auth/login",
            json={"email": "retail.pro@example.com", "password": "Password#2026", "full_name": "Retail", "mode": "signup"},
        ).json()["token"]
    }

    # Grant active Advisor (30 days) to vip.advisor and active Pro (30 days) to retail.pro
    assert tc.post(
        "/api/admin/set-user-tier",
        headers=admin_h,
        json={"target_email": "vip.advisor@example.com", "plan_tier": "advisor", "duration_days": 30},
    ).status_code == 200
    assert tc.post(
        "/api/admin/set-user-tier",
        headers=admin_h,
        json={"target_email": "retail.pro@example.com", "plan_tier": "pro", "duration_days": 30},
    ).status_code == 200

    # Create a single-use Pro code & a single-use Advisor code
    pro_code = tc.post(
        "/api/admin/codes",
        headers=admin_h,
        json={"plan_tier": "pro", "duration_days": 30, "max_uses": 1, "code_valid_days": 30},
    ).json()["code"]["code"]
    adv_code = tc.post(
        "/api/admin/codes",
        headers=admin_h,
        json={"plan_tier": "advisor", "duration_days": 90, "max_uses": 1, "code_valid_days": 30},
    ).json()["code"]["code"]

    # 1. Active Advisor redeeming a Pro code -> 400 AND code is NOT consumed!
    r_down = tc.post("/api/auth/redeem-code", headers=adv_h, json={"code": pro_code})
    assert r_down.status_code == 400
    raw_db = json.loads(db_file.read_text(encoding="utf-8"))
    pro_code_rec = next(c for c in raw_db["activation_codes"] if c["code"] == pro_code)
    assert pro_code_rec["used_by"] == []
    assert tc.get("/api/auth/me", headers=adv_h).json()["user"]["plan_tier"] == "advisor"

    # Verify the unconsumed Pro code still works for retail.pro (same-tier stacked renewal!)
    r_renew = tc.post("/api/auth/redeem-code", headers=pro_h, json={"code": pro_code})
    assert r_renew.status_code == 200
    assert r_renew.json()["user"]["days_remaining"] >= 59

    # 2. Active Pro upgrading to Advisor via 90-day Advisor code -> 200, becomes Advisor with ~90 days
    r_up = tc.post("/api/auth/redeem-code", headers=pro_h, json={"code": adv_code})
    assert r_up.status_code == 200
    up_user = r_up.json()["user"]
    assert up_user["plan_tier"] == "advisor"
    assert 89 <= up_user["days_remaining"] <= 91


def test_stacked_renewal_and_auto_expiry_preserves_portfolios(tier_client):
    tc, db_file = tier_client

    admin_h = {
        "Authorization": "Bearer "
        + tc.post(
            "/api/auth/login",
            json={"email": "amontud31067@gmail.com", "password": "Password#2026", "full_name": "Admin", "mode": "signup"},
        ).json()["token"]
    }
    cust_h = {
        "Authorization": "Bearer "
        + tc.post(
            "/api/auth/login",
            json={"email": "expiry.test@example.com", "password": "Password#2026", "full_name": "Expiry User", "mode": "signup"},
        ).json()["token"]
    }

    # Grant 20 days of Pro
    assert tc.post(
        "/api/admin/set-user-tier",
        headers=admin_h,
        json={"target_email": "expiry.test@example.com", "plan_tier": "pro", "duration_days": 20},
    ).status_code == 200

    # Save 5 portfolios while Pro (more than Free limit of 3)
    for i in range(1, 6):
        r_p = tc.post("/api/portfolios", headers=cust_h, json={"portfolio_name": f"Pro Plan {i}", "tickers": ["SYM01", "SYM02"]})
        assert r_p.status_code == 200

    # Stack +30 days via Pro renewal -> should total ~50 days
    code_30 = tc.post(
        "/api/admin/codes",
        headers=admin_h,
        json={"plan_tier": "pro", "duration_days": 30, "max_uses": 1},
    ).json()["code"]["code"]
    r_stack = tc.post("/api/auth/redeem-code", headers=cust_h, json={"code": code_30})
    assert r_stack.status_code == 200
    assert 49 <= r_stack.json()["user"]["days_remaining"] <= 51

    # Simulate expiry by setting plan_expires_at in the past
    raw_db = json.loads(db_file.read_text(encoding="utf-8"))
    raw_db["users"]["expiry.test@example.com"]["plan_expires_at"] = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    db_file.write_text(json.dumps(raw_db), encoding="utf-8")

    # Auto-downgrade to Free on /api/auth/me and /api/optimize
    r_me = tc.get("/api/auth/me", headers=cust_h)
    assert r_me.status_code == 200
    assert r_me.json()["user"]["plan_tier"] == "free"
    assert r_me.json()["user"]["is_expired"] is True

    r_opt_9 = tc.post(
        "/api/optimize",
        headers=cust_h,
        json={"tickers": [f"SYM{i:02d}" for i in range(1, 10)], "start_date": "2023-01-02", "end_date": "2024-01-15", "budget": 100000},
    )
    assert r_opt_9.status_code == 403

    # Existing 5 saved portfolios MUST remain preserved
    r_ports = tc.get("/api/portfolios", headers=cust_h)
    assert r_ports.status_code == 200
    assert len(r_ports.json()["portfolios"]) == 5


def test_session_bound_upgrade_requests_anti_spam_and_idempotent_approval(tier_client):
    tc, _ = tier_client

    admin_h = {
        "Authorization": "Bearer "
        + tc.post(
            "/api/auth/login",
            json={"email": "amontud31067@gmail.com", "password": "Password#2026", "full_name": "Admin", "mode": "signup"},
        ).json()["token"]
    }
    cust_h = {
        "Authorization": "Bearer "
        + tc.post(
            "/api/auth/login",
            json={"email": "buyer@example.com", "password": "Password#2026", "full_name": "Real Buyer", "mode": "signup"},
        ).json()["token"]
    }

    # 1. Guest rejected with 401
    r_guest = tc.post(
        "/api/upgrade-requests",
        json={"target_tier": "pro", "duration_days": 30, "transfer_amount": "299", "transfer_datetime": "22/11/2026 02:30"},
    )
    assert r_guest.status_code == 401

    # 2. Member submits with spoofed email/user_id in body -> Server binds to token email only
    r_req1 = tc.post(
        "/api/upgrade-requests",
        headers=cust_h,
        json={
            "email": "spoofed.victim@example.com",
            "user_id": "fake-id",
            "target_tier": "pro",
            "duration_days": 30,
            "transfer_amount": "299.00",
            "transfer_datetime": "22/11/2026 02:45",
            "account_last4": "4821",
            "slip_ref": "https://example.com/slip/123",
            "contact_note": "Line: @realbuyer",
        },
    )
    assert r_req1.status_code == 200, r_req1.text
    req1 = r_req1.json()["request"]
    assert req1["email"] == "buyer@example.com"
    assert req1["status"] == "pending"

    # 3. Anti-spam: 2nd pending request returns 409 Conflict
    r_req2 = tc.post(
        "/api/upgrade-requests",
        headers=cust_h,
        json={"target_tier": "advisor", "duration_days": 30, "transfer_amount": "1290", "transfer_datetime": "22/11/2026 02:46"},
    )
    assert r_req2.status_code == 409

    # 4. Member can cancel own pending request and re-submit
    assert tc.delete(f"/api/upgrade-requests/{req1['id']}", headers=cust_h).status_code == 200
    r_req3 = tc.post(
        "/api/upgrade-requests",
        headers=cust_h,
        json={"target_tier": "pro", "duration_days": 30, "transfer_amount": "299.00", "transfer_datetime": "22/11/2026 02:50"},
    )
    assert r_req3.status_code == 200
    req3_id = r_req3.json()["request"]["id"]

    # 5. Admin approves once -> 200, user becomes Pro for ~30 days
    r_app1 = tc.post(
        f"/api/admin/upgrade-requests/{req3_id}/decide",
        headers=admin_h,
        json={"decision": "approve"},
    )
    assert r_app1.status_code == 200, r_app1.text
    first_expiry = r_app1.json()["target_user"]["plan_expires_at"]
    assert r_app1.json()["target_user"]["plan_tier"] == "pro"

    # 6. Idempotent Approval Guard: double-clicking approve returns 409 Conflict & does NOT double-stack days!
    r_app2 = tc.post(
        f"/api/admin/upgrade-requests/{req3_id}/decide",
        headers=admin_h,
        json={"decision": "approve"},
    )
    assert r_app2.status_code == 409
    assert tc.get("/api/auth/me", headers=cust_h).json()["user"]["plan_expires_at"] == first_expiry


def test_admin_safe_preview_mode_and_non_admin_spoof_rejection(tier_client):
    tc, db_file = tier_client

    admin_token = tc.post(
        "/api/auth/login",
        json={"email": "amontud31067@gmail.com", "password": "Password#2026", "full_name": "Admin", "mode": "signup"},
    ).json()["token"]
    admin_h = {"Authorization": f"Bearer {admin_token}"}
    assert tc.post(
        "/api/admin/set-user-tier",
        headers=admin_h,
        json={"target_email": "amontud31067@gmail.com", "plan_tier": "advisor", "duration_days": 0},
    ).status_code == 200

    # Admin previews as Guest via X-QF-Admin-Preview-Tier header
    preview_guest_h = {"Authorization": f"Bearer {admin_token}", "X-QF-Admin-Preview-Tier": "guest"}
    r_me_prev = tc.get("/api/auth/me", headers=preview_guest_h)
    assert r_me_prev.status_code == 200
    u_prev = r_me_prev.json()["user"]
    assert u_prev["plan_tier"] == "guest"
    assert u_prev["real_plan_tier"] == "advisor"
    assert u_prev["preview_tier"] == "guest"
    assert u_prev["is_admin"] is True

    # Guest limits are enforced during preview
    assert tc.get("/api/market-news?tickers=SYM01", headers=preview_guest_h).status_code == 403
    assert tc.post(
        "/api/optimize",
        headers=preview_guest_h,
        json={"tickers": [f"SYM{i:02d}" for i in range(1, 7)], "start_date": "2023-01-02", "end_date": "2024-01-15", "budget": 100000},
    ).status_code == 403

    # Admin endpoints STILL work during Guest preview and real DB tier is untouched!
    assert tc.get("/api/admin/overview", headers=preview_guest_h).status_code == 200
    raw_db = json.loads(db_file.read_text(encoding="utf-8"))
    assert raw_db["users"]["amontud31067@gmail.com"]["plan_tier"] == "advisor"

    # Non-admin spoofing X-QF-Admin-Preview-Tier: advisor MUST be ignored
    user_token = tc.post(
        "/api/auth/login",
        json={"email": "normal.free@example.com", "password": "Password#2026", "full_name": "Free User", "mode": "signup"},
    ).json()["token"]
    spoof_h = {"Authorization": f"Bearer {user_token}", "X-QF-Admin-Preview-Tier": "advisor"}
    r_spoof_me = tc.get("/api/auth/me", headers=spoof_h)
    assert r_spoof_me.status_code == 200
    assert r_spoof_me.json()["user"]["plan_tier"] == "free"
    assert r_spoof_me.json()["user"]["preview_tier"] is None
    assert tc.post(
        "/api/optimize",
        headers=spoof_h,
        json={"tickers": [f"SYM{i:02d}" for i in range(1, 10)], "start_date": "2023-01-02", "end_date": "2024-01-15", "budget": 100000},
    ).status_code == 403


def test_frontend_membership_modals_gates_xss_and_dark_mode_css():
    html = _read("index.html")
    app_js = _read("app.js")
    auth_js = _read("supabase_auth.js")
    css = _read("styles.css")

    # Toast z-index must render above #pro-upgrade-modal (z-[98])
    assert 'id="portfolio-toast"' in html
    toast_idx = html.index('id="portfolio-toast"')
    assert "z-[120]" in html[toast_idx : toast_idx + 220]

    for req_id in (
        "header-tier-badge",
        "header-tier-badge-text",
        "account-menu-tier-pill",
        "admin-quick-tier-panel",
        "admin-switch-btn-real",
        "admin-switch-btn-guest",
        "admin-switch-btn-free",
        "admin-switch-btn-pro",
        "admin-switch-btn-advisor",
        "insights-guest-login-gate",
        "pro-upgrade-modal",
        "pro-modal-current-tier-pill",
        "pro-modal-preview-badge",
        "pro-upgrade-reason-banner",
        "pro-tab-btn-plans",
        "pro-tab-btn-activate",
        "pro-tab-btn-admin",
        "pro-plan-card-free",
        "pro-plan-card-pro",
        "pro-plan-card-advisor",
        "pro-guest-summary-strip",
        "pro-activation-code-box",
        "pro-activation-code-input",
        "req-target-tier",
        "req-duration-days",
        "req-transfer-amount",
        "req-transfer-datetime",
        "req-account-last4",
        "req-slip-ref",
        "req-contact-note",
        "my-upgrade-requests-section",
        "admin-upgrade-control-box",
        "admin-requests-container",
        "admin-users-search-input",
        "admin-users-table-body",
        "admin-codes-table-body",
        "pdf-cfg-advisor-pro-badge",
        "btn-print-a4-preview-label",
        "btn-open-pdf-new-tab",
    ):
        assert f'id="{req_id}"' in html, f"Missing element #{req_id} in index.html"

    for fn_token in (
        "CLIENT_TIER_DEFAULTS",
        "function sanitizeHttpsOnlyUrl(",
        "function getUserTierInfo(",
        "function syncMembershipTierBadgesUI(",
        "function switchProModalTab(",
        "function switchAdminSubTab(",
        "function openProUpgradeModal(",
        "async function submitActivationCodeUpgrade(",
        "async function submitUpgradeRequest(",
        "async function adminSetPreviewTier(",
        "async function loadAdminConsoleOverview(",
        "async function adminDecideUpgradeRequest(",
        "async function adminUpdateUserRowTier(",
        "async function adminGenerateActivationCode(",
        "async function adminRevokeActivationCode(",
    ):
        assert fn_token in auth_js, f"Missing {fn_token} in supabase_auth.js"

    # Strict XSS Prevention checks in Admin Console renderer (strictly https://, rejecting quotes/angle brackets/javascript:)
    assert "/^https:\\/\\/[^\\s\"'<>]+$/i.test(" in auth_js
    for escaped_field in (
        "escapeHtml(r.transfer_amount",
        "escapeHtml(r.transfer_datetime",
        "escapeHtml(r.account_last4",
        "escapeHtml(r.slip_ref)",
        "escapeHtml(r.contact_note)",
        "escapeHtml(httpsSlipUrl)",
    ):
        assert escaped_field in auth_js, f"Missing XSS escaping for {escaped_field} in supabase_auth.js"

    for app_token in (
        "function getActiveUserTierInfo(",
        "insights-guest-login-gate",
        "canDownloadSimPdf",
        "canCustomizeBlViews",
        "canWhitelabelAdvisorPdf",
    ):
        assert app_token in app_js, f"Missing {app_token} in app.js"

    # Dark mode CSS must target the exact pill ID (#pro-modal-current-tier-pill)
    assert "html body.theme-dark #pro-upgrade-modal > div" in css
    assert "html body.theme-dark #pro-upgrade-modal #pro-modal-current-tier-pill" in css
    assert 'html body.theme-dark #pro-upgrade-modal input[type="text"]' in css

    # Advisor Pro 25-asset differentiation, TradingView pricing structure, 25-color palette, adaptive heatmap & Auto-Annex Page 3 PDF
    assert "25 สินทรัพย์ / พอร์ต" in html
    assert "Advisor Pro (25 หุ้น)" in html
    assert "max-w-5xl" in html.split('id="pro-upgrade-modal"')[1].split('id="pro-upgrade-modal-title"')[0]
    plans_panel = html.split('id="pro-tab-panel-plans"')[1].split('id="pro-tab-panel-activate"')[0]
    assert "Tab 3" not in plans_panel, "Internal UI jargon 'Tab 3' must not appear on the Pricing Plans tab"
    for tv_token in (
        'id="pro-billing-toggle"',
        'id="pro-billing-btn-monthly"',
        'id="pro-billing-btn-yearly"',
        "ประหยัดสูงสุด 23%",
        "฿239",
        "ชำระรายปี ฿2,868 • ประหยัด ฿720/ปี",
        "฿990",
        "ชำระรายปี ฿11,880 • ประหยัด ฿3,600/ปี",
        "แนะนำ",
        "การจัดพอร์ต &amp; คลังข้อมูล",
        "ข่าว &amp; มุมมองรายหุ้น",
        "รายงาน PDF &amp; มาตรฐาน ก.ล.ต.",
        "กลยุทธ์, ซื้อ–ขาย &amp; เป้าหมาย",
        'id="btn-toggle-core-features"',
        'id="pro-enterprise-summary-strip"',
        'id="btn-enterprise-goto-activate"',
    ):
        assert tv_token in plans_panel, f"Missing TradingView pricing token {tv_token} in Tab 1"
    for js_tv_token in (
        "function setProBillingCycle(",
        "function toggleProCoreFeatures(",
        "function syncUpgradeRequestPriceHint(",
        "function selectEnterpriseInquiry(",
        "✓ แพ็กเกจปัจจุบัน (สิทธิ์ถาวร)",
    ):
        assert js_tv_token in auth_js, f"Missing {js_tv_token} in supabase_auth.js"
    assert "maxAssets: 25" in auth_js
    assert "ADVISOR PRO • 25 หุ้น" in auth_js
    palette_block = app_js.split("const ASSET_COLORS = [")[1].split("];")[0]
    assert len(re.findall(r"#[0-9A-Fa-f]{6}", palette_block)) >= 25
    assert "tierInfo.planTier === 'pro'" in app_js
    assert "สูงสุด 25 สินทรัพย์" in app_js
    assert "const isDenseMatrix = nAssets >= 19;" in app_js
    assert "showscale: isDenseMatrix" in app_js
    assert "const needsAnnexPage = allSchedule.length > 12;" in app_js
    assert 'data-pdf-annex="true"' in app_js
    assert "หน้า 3 / 3" in app_js
    assert "+ อีก ${restItems.length} สินทรัพย์อื่นๆ" in app_js


def test_advisor_pro_25_asset_ceiling_vs_pro_15_and_concurrent_news_wrapper(tier_client):
    tc, _ = tier_client

    admin_h = {
        "Authorization": "Bearer "
        + tc.post(
            "/api/auth/login",
            json={"email": "amontud31067@gmail.com", "password": "Password#2026", "full_name": "Admin", "mode": "signup"},
        ).json()["token"]
    }
    pro_h = {
        "Authorization": "Bearer "
        + tc.post(
            "/api/auth/login",
            json={"email": "pro15@example.com", "password": "Password#2026", "full_name": "Pro Investor", "mode": "signup"},
        ).json()["token"]
    }
    adv_h = {
        "Authorization": "Bearer "
        + tc.post(
            "/api/auth/login",
            json={"email": "adv25@example.com", "password": "Password#2026", "full_name": "Advisor IC", "mode": "signup"},
        ).json()["token"]
    }

    assert tc.post(
        "/api/admin/set-user-tier",
        headers=admin_h,
        json={"target_email": "pro15@example.com", "plan_tier": "pro", "duration_days": 30},
    ).status_code == 200
    assert tc.post(
        "/api/admin/set-user-tier",
        headers=admin_h,
        json={"target_email": "adv25@example.com", "plan_tier": "advisor", "duration_days": 30},
    ).status_code == 200

    # 1. QuantFolio Pro: 15 tickers -> 200; 16 tickers -> 403 suggesting Advisor Pro (25)
    r_pro_15 = tc.post(
        "/api/optimize",
        headers=pro_h,
        json={
            "tickers": [f"SYM{i:02d}" for i in range(1, 16)],
            "start_date": "2023-01-02",
            "end_date": "2024-01-15",
            "budget": 300000,
        },
    )
    assert r_pro_15.status_code == 200, r_pro_15.text

    r_pro_16 = tc.post(
        "/api/optimize",
        headers=pro_h,
        json={
            "tickers": [f"SYM{i:02d}" for i in range(1, 17)],
            "start_date": "2023-01-02",
            "end_date": "2024-01-15",
            "budget": 300000,
        },
    )
    assert r_pro_16.status_code == 403
    assert "Advisor Pro" in r_pro_16.json()["detail"]
    assert "25 สินทรัพย์" in r_pro_16.json()["detail"]

    # 2. Advisor Pro: 25 tickers -> 200 with valid weights summing to 1.0; 26 tickers -> 403
    tickers_25 = [f"SYM{i:02d}" for i in range(1, 26)]
    r_adv_25 = tc.post(
        "/api/optimize",
        headers=adv_h,
        json={
            "tickers": tickers_25,
            "start_date": "2023-01-02",
            "end_date": "2024-01-15",
            "budget": 1000000,
            "use_news_adjustment": True,
            "bl_confidence": 0.50,
        },
    )
    assert r_adv_25.status_code == 200, r_adv_25.text
    adv_body = r_adv_25.json()
    assert adv_body["metadata"]["plan_tier"] == "advisor"
    assert len(adv_body["metadata"]["tickers"]) == 25
    assert abs(sum(adv_body["strategies"]["max_sharpe"]["weights"].values()) - 1.0) < 0.01
    assert abs(sum(adv_body["strategies"]["hrp"]["weights"].values()) - 1.0) < 0.01

    r_adv_26 = tc.post(
        "/api/optimize",
        headers=adv_h,
        json={
            "tickers": [f"SYM{i:02d}" for i in range(1, 27)],
            "start_date": "2023-01-02",
            "end_date": "2024-01-15",
            "budget": 1000000,
        },
    )
    assert r_adv_26.status_code == 403
    assert "25 สินทรัพย์" in r_adv_26.json()["detail"]

    # 3. Concurrent news wrapper handles all 25 tickers cleanly via /api/market-news
    r_news_25 = tc.get(f"/api/market-news?tickers={','.join(tickers_25)}", headers=adv_h)
    assert r_news_25.status_code == 200, r_news_25.text
    assert len(r_news_25.json()["news"]) == 25


def test_admin_custom_expiry_datetime_bangkok_conversion_and_ui_touchpoints(tier_client):
    tc, _ = tier_client

    admin_h = {
        "Authorization": "Bearer "
        + tc.post(
            "/api/auth/login",
            json={"email": "amontud31067@gmail.com", "password": "Password#2026", "full_name": "Admin", "mode": "signup"},
        ).json()["token"]
    }
    cust_h = {
        "Authorization": "Bearer "
        + tc.post(
            "/api/auth/login",
            json={"email": "custom.exp@example.com", "password": "Password#2026", "full_name": "Custom Expiry", "mode": "signup"},
        ).json()["token"]
    }

    # 1. Naive Thailand timestamp (UTC+7) -> stored accurately as UTC (-7 hours)
    r_naive = tc.post(
        "/api/admin/set-user-tier",
        headers=admin_h,
        json={"target_email": "custom.exp@example.com", "plan_tier": "pro", "expires_at": "2027-06-15T18:30"},
    )
    assert r_naive.status_code == 200, r_naive.text
    assert r_naive.json()["user"]["plan_tier"] == "pro"
    assert r_naive.json()["user"]["plan_expires_at"] == "2027-06-15T11:30:00+00:00"

    # 2. Explicit +07:00 offset timestamp -> converted accurately to UTC
    r_offset = tc.post(
        "/api/admin/set-user-tier",
        headers=admin_h,
        json={"target_email": "custom.exp@example.com", "plan_tier": "advisor", "expires_at": "2027-01-10T23:59:00+07:00"},
    )
    assert r_offset.status_code == 200
    assert r_offset.json()["user"]["plan_tier"] == "advisor"
    assert r_offset.json()["user"]["plan_expires_at"] == "2027-01-10T16:59:00+00:00"

    # 3. Past timestamp accepted for Admin expiry testing -> auto-downgrades immediately on /api/auth/me
    r_past = tc.post(
        "/api/admin/set-user-tier",
        headers=admin_h,
        json={"target_email": "custom.exp@example.com", "plan_tier": "pro", "expires_at": "2020-01-01T10:00:00+07:00"},
    )
    assert r_past.status_code == 200
    r_me = tc.get("/api/auth/me", headers=cust_h)
    assert r_me.status_code == 200
    assert r_me.json()["user"]["plan_tier"] == "free"
    assert r_me.json()["user"]["is_expired"] is True
    assert r_me.json()["user"]["plan_expires_at"] == "2020-01-01T03:00:00+00:00"

    # 4. Invalid datetime string -> 400
    r_bad = tc.post(
        "/api/admin/set-user-tier",
        headers=admin_h,
        json={"target_email": "custom.exp@example.com", "plan_tier": "pro", "expires_at": "not-a-valid-date"},
    )
    assert r_bad.status_code == 400

    # 5. Frontend 3 touchpoints + Asia/Bangkok HH:mm น. + Admin datetime-local picker
    html = _read("index.html")
    auth_js = _read("supabase_auth.js")
    css = _read("styles.css")
    for eid in (
        "account-menu-expiry-line",
        "acct-modal-membership-box",
        "acct-modal-plan-label",
        "acct-modal-expiry-text",
        "pro-modal-expiry-banner",
        "pro-card-expiry-note-pro",
        "pro-card-expiry-note-advisor",
    ):
        assert f'id="{eid}"' in html, f"Missing expiry UI element #{eid}"

    for js_tok in (
        "function formatDateTimeTh(",
        "timeZone: 'Asia/Bangkok'",
        "function formatBangkokDatetimeLocalValue(",
        "function getExpiryCountdownInfo(",
        "function adminToggleCustomExpiryInput(",
        "กำหนดวัน–เวลาเอง",
        'type="datetime-local"',
        "ชม.",
    ):
        assert js_tok in auth_js, f"Missing {js_tok} in supabase_auth.js"

    assert 'input[type="datetime-local"]' in css
    assert "html body.theme-dark #acct-modal-membership-box" in css
