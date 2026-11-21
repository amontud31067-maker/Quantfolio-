"""
Phase 2 TDD Suite: Financial consistency, centralized UI state lifecycle,
stale badge clearing, order sheet assumptions/rounding, copy & header audit.
"""
import os
import re
import sys
import numpy as np
import pandas as pd
import pytest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import optimizer as opt
import app as quantfolio_app
from tests.test_access_control import ASGITestClient


def _read_text(rel_path: str) -> str:
    with open(os.path.join(PROJECT_ROOT, rel_path), "r", encoding="utf-8") as f:
        return f.read()


def _build_mock_prices():
    dates = pd.date_range("2024-01-01", periods=120, freq="D")
    rng = np.random.default_rng(101)
    df = pd.DataFrame(
        {
            "NVDA": 120.0 * np.cumprod(1.0 + rng.normal(0.001, 0.02, 120)),
            "AAPL": 180.0 * np.cumprod(1.0 + rng.normal(0.0006, 0.012, 120)),
            "BTC-USD": 60000.0 * np.cumprod(1.0 + rng.normal(0.0012, 0.03, 120)),
            "PTT.BK": 35.0 * np.cumprod(1.0 + rng.normal(0.0003, 0.01, 120)),
        },
        index=dates,
    )
    return df


def test_api_optimize_contract_all_tabs_fields(monkeypatch):
    """API /api/optimize must return all fields required across Tabs 1-5 with truthful metadata."""
    prices_df = _build_mock_prices()
    tickers = list(prices_df.columns)

    monkeypatch.setattr(opt, "fetch_historical_prices", lambda t, s, e: (prices_df.copy(), list(t), []))
    monkeypatch.setattr(
        opt,
        "convert_prices_to_base_currency",
        lambda prices, base_currency="THB", fx_series=None, fallback_fx_rate=34.50: prices.copy(),
    )
    monkeypatch.setattr(opt, "fetch_portfolio_market_news", lambda t: {k: {"articles": [], "news_sentiment_score": 0.0} for k in t})
    monkeypatch.setattr(opt, "get_usd_thb_rate", lambda default_rate=34.50: 33.80)
    monkeypatch.setattr(opt, "get_risk_free_rate", lambda default_rate=0.04, currency="USD": 0.0225 if currency == "THB" else 0.0412)
    monkeypatch.setattr(
        opt,
        "get_market_rates_metadata",
        lambda currency="THB": {
            "usd_thb_rate": 33.80,
            "fx_date": "2026-11-17",
            "fx_updated_at": "2026-11-17T09:00:00+00:00",
            "is_fallback_fx": False,
            "risk_free_rate": 0.0225 if currency == "THB" else 0.0412,
            "risk_free_source": "BOT reference (fixed)" if currency == "THB" else "US 13W T-Bill (^IRX)",
            "risk_free_tenor": "อ้างอิงในระบบ" if currency == "THB" else "13 สัปดาห์",
            "risk_free_date": None if currency == "THB" else "2026-11-16",
            "rf_updated_at": "2026-11-17T09:00:00+00:00",
            "is_fallback_rf": False,
        },
        raising=False,
    )

    res = opt.run_portfolio_optimization(
        tickers=tickers,
        start_date="2024-01-01",
        end_date="2024-05-01",
        budget=100000.0,
        currency="THB",
        fx_rate=33.80,
        num_simulations=600,
    )

    meta = res["metadata"]
    required_meta = {
        "tickers", "start_date", "end_date", "trading_days", "aligned_row_count",
        "effective_annual_days", "risk_free_rate", "risk_free_source",
        "risk_free_tenor", "risk_free_date", "budget", "currency", "usd_thb_rate",
        "fx_date", "is_fallback_fx", "is_fallback_rf", "data_as_of", "fetched_at",
        "alignment_method", "model_version",
    }
    missing_meta = required_meta - set(meta.keys())
    assert not missing_meta, f"Missing metadata keys: {missing_meta}"

    for st in res["asset_stats"]:
        for k in ("ticker", "name", "native_currency", "native_price", "price_thb", "price_usd", "latest_price", "latest_price_date", "expected_return", "volatility", "max_drawdown", "max_drawdown_amount", "min_capital_remaining", "drawdown_details"):
            assert k in st, f"Missing asset_stats field: {k}"

    for sk in ("max_sharpe", "min_volatility", "hrp", "equal_weight"):
        s = res["strategies"][sk]
        assert np.isclose(sum(s["weights"].values()), 1.0, atol=1e-2)
        dd = s["drawdown_details"]
        assert abs((dd["peak_value"] - s["min_capital_remaining"]) - s["max_drawdown_amount"]) <= 0.1
        da = s["discrete_allocation"]
        assert abs((da["cash_spent"] + da["leftover"]) - 100000.0) <= 1.0

    pg = res["portfolio_growth"]
    for k in ("dates", "series", "walk_forward_series", "drawdown_amount_series"):
        assert k in pg


def test_api_rf_and_quote_timestamps_and_source(monkeypatch):
    """Endpoints /api/rf and /api/quote must return timestamps, source metadata, and THB vs USD Rf consistency."""
    monkeypatch.setattr(quantfolio_app, "get_usd_thb_rate", lambda: 33.78)
    monkeypatch.setattr(quantfolio_app, "get_risk_free_rate", lambda currency="USD": 0.0225 if currency.upper() == "THB" else 0.0412)
    monkeypatch.setattr(
        opt,
        "get_market_rates_metadata",
        lambda currency="THB": {
            "usd_thb_rate": 33.78,
            "fx_date": "2026-11-17",
            "fx_updated_at": "2026-11-17T09:00:00+00:00",
            "is_fallback_fx": False,
            "risk_free_rate": 0.0225 if currency.upper() == "THB" else 0.0412,
            "risk_free_source": "BOT reference (fixed)" if currency.upper() == "THB" else "US 13W T-Bill (^IRX)",
            "risk_free_tenor": "อ้างอิงในระบบ" if currency.upper() == "THB" else "13 สัปดาห์",
            "risk_free_date": None if currency.upper() == "THB" else "2026-11-16",
            "rf_updated_at": "2026-11-17T09:00:00+00:00",
            "is_fallback_rf": False,
        },
        raising=False,
    )

    client = ASGITestClient(quantfolio_app.app)
    r_thb = client.get("/api/rf?currency=THB")
    assert r_thb.status_code == 200
    d_thb = r_thb.json()
    for field in ("rf_source", "rf_tenor", "rf_date", "fx_date", "fx_updated_at", "rf_updated_at"):
        assert field in d_thb, f"/api/rf missing {field}"
    assert abs(d_thb["risk_free_rate"] - 0.0225) < 1e-6

    r_usd = client.get("/api/rf?currency=USD")
    d_usd = r_usd.json()
    assert abs(d_usd["risk_free_rate"] - 0.0412) < 1e-6
    assert d_usd["rf_date"] == "2026-11-16"

    # Mock /api/quote batch fast_info + history dates
    class DummyFastInfo:
        def __init__(self, last_price, prev_close):
            self.last_price = last_price
            self.previous_close = prev_close

    class DummyTicker:
        def __init__(self, lp, pc, dt_str):
            self.fast_info = DummyFastInfo(lp, pc)
            self._dt = dt_str

        def history(self, period="5d", auto_adjust=True, progress=False):
            return pd.DataFrame({"Close": [self.fast_info.previous_close, self.fast_info.last_price]}, index=pd.to_datetime(["2026-11-13", self._dt]))

    class DummyTickers:
        def __init__(self, symbols_str):
            self.tickers = {
                "PTT.BK": DummyTicker(37.30, 37.00, "2026-11-17"),
                "NVDA": DummyTicker(156.14, 158.00, "2026-11-16"),
                "BTC-USD": DummyTicker(64315.96, 64000.0, "2026-11-17"),
            }

    quantfolio_app._quote_cache.clear()
    monkeypatch.setattr(quantfolio_app.yf, "Tickers", DummyTickers)
    r_q = client.get("/api/quote?tickers=PTT.BK,NVDA,BTC-USD")
    assert r_q.status_code == 200
    dq = r_q.json()
    assert "fx_date" in dq and "fx_updated_at" in dq
    for sym in ("PTT.BK", "NVDA", "BTC-USD"):
        q = dq["quotes"][sym]
        assert "as_of_date" in q and "fetched_at" in q and "market_type" in q


def test_ui_state_lifecycle_and_badge_hiding():
    """Verify idle initial state, stale invalidation triggers, badge hiding, FX unification, and fixed WF chart key."""
    html = _read_text("index.html")
    app_js = _read_text("app.js")

    # 2.2: Must NOT auto-call runOptimization inside DOMContentLoaded
    dom_ready_block = app_js.split("document.addEventListener('DOMContentLoaded'")[1].split("});")[0]
    assert "runOptimization(" not in dom_ready_block, "Initial load must start in idle state without auto-calculating"

    # 2.2: No hardcoded fake demo KPIs left in index.html
    for fake in ("+24.85%", "฿245,850", "-38,352", "฿1,485,200", "148.5%"):
        assert fake not in html, f"Hardcoded demo figure '{fake}' still present in index.html"
    assert "0.2485" not in app_js, "Hardcoded fallback expected return 0.2485 still in app.js"

    # 2.1 & 2.2: Single centralized state + stale invalidation + badge cleared on stale
    assert "resultStatus:" in app_js
    assert "function markResultsStale(" in app_js
    assert "function convertNativePrice(" in app_js
    assert "walk_forward_backtest" not in app_js, "Broken walk_forward_backtest key must be replaced by pg.walk_forward_series"
    assert "pg.walk_forward_series" in app_js

    # Budget quick update must scale drawdown proportionally (NOT overwrite with mddPct * budget)
    budget_fn = app_js.split("function handleBudgetQuickUpdate()")[1].split("\nfunction ")[0]
    assert "s.max_drawdown_amount = Number((mddPct * budget)" not in budget_fn, "handleBudgetQuickUpdate overwrites peak-to-trough drawdown"

    # Stale/idle banners for all 4 result tabs
    for tab_key in ("trade-plan", "insights", "backtest", "goals"):
        assert f'id="tab-state-banner-{tab_key}"' in html, f"Missing state banner for tab {tab_key}"

    # Verify badge cleared when resultStatus !== 'ready'
    assert "navTradeBadge.classList.add('hidden')" in app_js


def test_copy_numbering_disclaimers_and_header_declutter():
    """Verify 2.3 numbering, 2.4 copy/disclaimer, 2.5 status pill, 2.6 plain-language labels, 2.7 order controls, 2.8 header menu."""
    html = _read_text("index.html")
    app_js = _read_text("app.js")
    auth_js = _read_text("supabase_auth.js")

    # 2.3: Only main tabs 1-5 keep step numbers; modes & card headings have no "1. / 2. / 3." numbers
    for numbered_mode in ("1. ลงทุนเงินก้อนใหม่", "2. ปรับพอร์ตเดิม", "3. เป้าหมาย", "1. เงินต้นตั้งต้น", "2. ย่อตัวสูงสุด", "3. เงินคงเหลือต่ำสุด", "4. ช่วงเวลาจุดต่ำสุด", "1. ตารางเปรียบเทียบ", "2. Efficient Frontier", "3. สถิติรายหุ้น", "1. เงินต้นสะสมรวม", "2. มูลค่าพอร์ตคาดการณ์", "3. เงินปันผลคาดการณ์", "4. ความสำเร็จเทียบเป้า"):
        assert numbered_mode not in html, f"Sub-item still numbered '{numbered_mode}'"

    # 2.4: Exact copy replacements & equal strategy treatment & disclaimers
    assert "แกว่งน้อย" not in html, "Found 'แกว่งน้อย' instead of 'ผันผวนต่ำ' in index.html"
    assert "แกว่งน้อย" not in auth_js, "Found 'แกว่งน้อย' instead of 'ผันผวนต่ำ' in supabase_auth.js"
    # No 'แนะนำ' badge inside Max Sharpe strategy card
    max_sharpe_card = html.split('id="goal-card-max_sharpe"')[1].split('id="goal-card-min_volatility"')[0]
    assert "แนะนำ" not in max_sharpe_card, "Strategy bias badge 'แนะนำ' still on max_sharpe card"
    assert "คำนวณพอร์ต &amp; ดูผลลัพธ์" in html
    assert "คำนวณพอร์ต &amp; ดูผลลัพธ์" in app_js or "คำนวณพอร์ต & ดูผลลัพธ์" in app_js
    assert html.count("ผลในอดีตไม่รับประกันผลตอบแทนในอนาคต ผลลัพธ์นี้ไม่ใช่คำแนะนำการลงทุนเฉพาะบุคคล") >= 2, "Disclaimer must appear on both results strip/charts and trade orders"

    # 2.5: Truthful status pill & aligned calendar days wording
    assert 'id="market-data-status-pill"' in html
    assert 'id="stale-market-warning"' in html
    assert "วันทำการ</span>" not in html, "Blind 'วันทำการ' header label must be updated honestly"

    # 2.6: No "Pro" label on view-depth toggle
    assert "ข้อมูลเชิงลึก (Pro)" not in html
    assert "ข้อมูลเชิงลึก (Pro)" not in app_js

    # 2.7: Editable commission, whole vs fractional mode, rounding leftover, assumptions box
    for req_id in ("commission-rate-input", "order-unit-mode-fractional", "order-unit-mode-whole", "order-rounding-leftover", "order-assumptions-box"):
        assert f'id="{req_id}"' in html, f"Missing order control/assumption element #{req_id}"

    # 2.8: Top header utility menu contains theme, privacy, diagnostics, help
    assert 'id="header-utility-menu-btn"' in html
    assert 'id="header-utility-menu"' in html
    menu_block = html.split('id="header-utility-menu"')[1].split('</header>')[0]
    for inner_action in ("theme-btn-light", "theme-btn-dark", "toggleBalancePrivacy()", "openHelpGuideModal()", "runSystemVerificationModal()"):
        assert inner_action in menu_block, f"Utility menu missing {inner_action}"

    # Parity with static/
    for fn in ("index.html", "app.js", "styles.css", "supabase_auth.js"):
        assert _read_text(fn) == _read_text(f"static/{fn}"), f"Root {fn} out of sync with static/{fn}"
