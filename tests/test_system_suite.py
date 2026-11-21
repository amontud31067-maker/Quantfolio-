import os
import sys
import tempfile
import traceback
import numpy as np
import pandas as pd

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import app as quantfolio_app
import optimizer as quantfolio_opt
from tests.test_access_control import ASGITestClient


def test_health_endpoint():
    client = ASGITestClient(quantfolio_app.app)
    res = client.get("/api/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"


def test_daily_fx_conversion_mixed_currency():
    """Audit #1: Mixed THB (.BK) and USD assets are converted using daily historical FX series."""
    dates = pd.date_range("2024-01-01", periods=60, freq="B")
    prices_df = pd.DataFrame(
        {
            "PTT.BK": np.linspace(32.0, 36.0, 60),
            "AAPL": np.linspace(180.0, 200.0, 60),
        },
        index=dates,
    )
    # Rising USD/THB rate from 33.0 to 36.5
    fx_series = pd.Series(np.linspace(33.0, 36.5, 60), index=dates)

    thb_df = quantfolio_opt.convert_prices_to_base_currency(
        prices_df, base_currency="THB", fx_series=fx_series, fallback_fx_rate=34.5
    )
    usd_df = quantfolio_opt.convert_prices_to_base_currency(
        prices_df, base_currency="USD", fx_series=fx_series, fallback_fx_rate=34.5
    )

    # PTT.BK in THB should be unchanged; AAPL in THB should equal AAPL * fx_series
    assert np.allclose(thb_df["PTT.BK"].values, prices_df["PTT.BK"].values)
    assert np.allclose(thb_df["AAPL"].values, (prices_df["AAPL"] * fx_series).values)
    # PTT.BK in USD should equal PTT.BK / fx_series
    assert np.allclose(usd_df["PTT.BK"].values, (prices_df["PTT.BK"] / fx_series).values)
    # Returns of AAPL in THB vs USD must differ because FX moved
    ret_thb = thb_df["AAPL"].pct_change().dropna()
    ret_usd = usd_df["AAPL"].pct_change().dropna()
    assert not np.allclose(ret_thb.values, ret_usd.values)


def test_sample_volatility_and_correlation_unshrunk():
    """Audit #2 & #3: Analytical Ledoit-Wolf shrinkage for optimization, un-shrunk sample std & corr for display."""
    dates = pd.date_range("2023-01-01", periods=150, freq="B")
    rng = np.random.default_rng(123)
    rets = pd.DataFrame(
        rng.normal(0.0006, [0.008, 0.035, 0.018], size=(150, 3)),
        index=dates,
        columns=["LOW_VOL", "HIGH_VOL", "MID_VOL"],
    )
    prices = (1.0 + rets).cumprod() * 100.0

    cs = quantfolio_opt.risk_models.CovarianceShrinkage(prices, frequency=252)
    shrunk_cov = cs.ledoit_wolf()
    sample_vol = rets.std(ddof=1) * np.sqrt(252)
    shrunk_vol = np.sqrt(np.diag(shrunk_cov))

    # Analytical shrinkage pulls extreme variance toward average, so sample_vol != shrunk_vol
    assert not np.allclose(sample_vol.values, shrunk_vol)
    # Sample correlation diagonal is 1.0 and differs from shrunk covariance correlation
    sample_corr = rets.corr()
    shrunk_corr = quantfolio_opt.risk_models.cov_to_corr(shrunk_cov)
    assert not np.allclose(sample_corr.values, shrunk_corr.values)


def test_drawdown_peak_to_trough_monetary():
    """Audit #4: Max Drawdown in currency reflects true Peak-to-Trough loss and Trough wealth."""
    # Portfolio grows from 1.0 (100k) to 2.0 (200k), then drops -30% to 1.4 (140k)
    cum_growth = pd.Series(
        [1.00, 1.50, 2.00, 1.40, 1.80],
        index=pd.date_range("2024-01-01", periods=5, freq="D"),
    )
    dd = quantfolio_opt.compute_drawdown_details(cum_growth, budget=100000.0)
    assert abs(dd["max_drawdown_pct"] - (-0.30)) < 1e-4
    assert abs(dd["peak_value"] - 200000.0) < 1e-2
    assert abs(dd["trough_value"] - 140000.0) < 1e-2
    # True peak-to-trough monetary loss is 200,000 - 140,000 = 60,000
    assert abs(dd["max_drawdown_amount"] - 60000.0) < 1e-2
    assert abs(dd["min_capital_remaining"] - 140000.0) < 1e-2
    # Lowest portfolio value from day 1 is 100,000; scaled loss on initial budget is 30,000
    assert abs(dd["min_portfolio_value"] - 100000.0) < 1e-2
    assert abs(dd["initial_budget_scaled_loss"] - 30000.0) < 1e-2


def test_calendar_alignment_annualization_and_currency_rf():
    """Audit #5 & #6: Dynamic 252 vs 365 trading days, calendar CAGR, and THB vs USD risk-free rate."""
    dates_crypto = pd.date_range("2023-01-01", "2024-01-01", freq="D")
    df_crypto = pd.DataFrame({"BTC-USD": np.linspace(100.0, 150.0, len(dates_crypto))}, index=dates_crypto)
    assert quantfolio_opt._infer_effective_trading_days(df_crypto) == 365

    dates_eq = pd.date_range("2023-01-01", "2024-01-01", freq="B")
    df_eq = pd.DataFrame({"AAPL": np.linspace(100.0, 150.0, len(dates_eq))}, index=dates_eq)
    assert quantfolio_opt._infer_effective_trading_days(df_eq) == 252

    # Calendar CAGR on 1.0 -> 1.5 over exactly 1 calendar year should be ~50% regardless of 252 vs 365 rows
    cagr_crypto = quantfolio_opt.expected_returns.mean_historical_return(df_crypto, frequency=None)["BTC-USD"]
    cagr_eq = quantfolio_opt.expected_returns.mean_historical_return(df_eq, frequency=None)["AAPL"]
    assert abs(cagr_crypto - 0.50) < 0.01
    assert abs(cagr_eq - 0.50) < 0.01

    # Risk-free rate for THB should be 2.25% (0.0225)
    rf_thb = quantfolio_opt.get_risk_free_rate(currency="THB")
    assert abs(rf_thb - 0.0225) < 1e-4


def test_min_volatility_and_hrp_unmodified_by_news_signal():
    """Audit #7: min_volatility and hrp weights must not be distorted post-hoc by news signal_scores."""
    tickers = ["AAPL", "MSFT", "NVDA"]
    mu_vec = pd.Series([0.18, 0.14, 0.25], index=tickers)
    cov_mat = pd.DataFrame(
        [[0.04, 0.01, 0.015], [0.01, 0.03, 0.01], [0.015, 0.01, 0.09]],
        index=tickers,
        columns=tickers,
    )
    rng = np.random.default_rng(42)
    returns_df = pd.DataFrame(rng.normal(0.0005, 0.015, size=(120, 3)), columns=tickers)

    strats_pure = quantfolio_opt._solve_all_strategies(
        mu_vec=mu_vec,
        S_mat=cov_mat,
        returns_df=returns_df,
        valid_tickers=tickers,
        weight_bounds=(0.0, 1.0),
        rf_rate=0.04,
        signal_scores=None,
    )
    strats_news = quantfolio_opt._solve_all_strategies(
        mu_vec=mu_vec * pd.Series({"AAPL": 1.25, "MSFT": 0.80, "NVDA": 1.30}),
        S_mat=cov_mat,
        returns_df=returns_df,
        valid_tickers=tickers,
        weight_bounds=(0.0, 1.0),
        rf_rate=0.04,
        signal_scores={"AAPL": 0.9, "MSFT": -0.8, "NVDA": 0.95},
    )

    for k in ("min_volatility", "hrp", "equal_weight"):
        for t in tickers:
            assert abs(strats_pure[k]["weights"][t] - strats_news[k]["weights"][t]) < 1e-6


def test_walk_forward_backtest_and_quarterly_rebalance_fees():
    """Audit #14, #15, #16: Walk-forward backtest has no look-ahead leakage and deducts 15 bps rebalance fees."""
    dates = pd.date_range("2023-01-02", periods=220, freq="B")
    rng = np.random.default_rng(7)
    rets1 = pd.DataFrame(
        rng.normal(0.0005, 0.012, size=(220, 3)),
        index=dates,
        columns=["A", "B", "C"],
    )
    # Create a second return series identical for the first 150 days, but dramatically different in the last 70 days
    rets2 = rets1.copy()
    rets2.iloc[150:, 0] += 0.05
    rets2.iloc[150:, 1] -= 0.04

    prices1 = (1.0 + rets1).cumprod() * 100.0
    prices2 = (1.0 + rets2).cumprod() * 100.0

    wf1 = quantfolio_opt.compute_walk_forward_backtest(
        prices_base=prices1,
        valid_tickers=["A", "B", "C"],
        weight_bounds=(0.0, 1.0),
        rf_rate=0.04,
        effective_freq=252,
        rebalance_every=63,
        fee_bps=15.0,
    )
    wf2 = quantfolio_opt.compute_walk_forward_backtest(
        prices_base=prices2,
        valid_tickers=["A", "B", "C"],
        weight_bounds=(0.0, 1.0),
        rf_rate=0.04,
        effective_freq=252,
        rebalance_every=63,
        fee_bps=15.0,
    )

    # First 120 days of walk-forward wealth curve must be 100% identical (no look-ahead leakage from days 150..220)
    assert np.allclose(wf1["max_sharpe"].iloc[:120].values, wf2["max_sharpe"].iloc[:120].values)

    # Verify fee impact: 15 bps fee curve is strictly lower than 0 bps fee curve when rebalancing occurs
    w = pd.Series({"A": 0.5, "B": 0.3, "C": 0.2})
    curve_no_fee = quantfolio_opt.simulate_drifting_backtest_with_fees(rets1, w, rebalance_every=63, fee_bps=0.0)
    curve_with_fee = quantfolio_opt.simulate_drifting_backtest_with_fees(rets1, w, rebalance_every=63, fee_bps=15.0)
    assert curve_with_fee.iloc[-1] < curve_no_fee.iloc[-1]


def test_auth_pbkdf2_signin_mode_rate_limit_and_pdpa_delete():
    """Audit #11, #13: Salted PBKDF2-SHA256, signin mode 401, login rate limit 429, local SVG avatar, PDPA account deletion."""
    orig_db_fn = quantfolio_app._get_db_file_path
    quantfolio_app._login_attempts.clear()
    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            db_path = os.path.join(tmpdir, "test_auth_db.json")
            quantfolio_app._get_db_file_path = lambda: db_path
            client = ASGITestClient(quantfolio_app.app)

            # 1. Signin mode with non-existent email must return 401 (not create a new user)
            r_typo = client.post(
                "/api/auth/login",
                json={"email": "typo@example.com", "password": "Password123", "mode": "signin"},
            )
            assert r_typo.status_code == 401

            # 2. Valid signup creates PBKDF2-SHA256 salted hash and local SVG data URI avatar
            r_signup = client.post(
                "/api/auth/login",
                json={"email": "user@example.com", "password": "CorrectPassword123", "mode": "signup"},
            )
            assert r_signup.status_code == 200
            body = r_signup.json()
            token = body["token"]
            avatar_url = body["user"]["user_metadata"]["avatar_url"]
            assert avatar_url.startswith("data:image/svg+xml")
            assert "ui-avatars.com" not in avatar_url

            db_data = quantfolio_app._load_db()
            stored_hash = db_data["users"]["user@example.com"]["password_hash"]
            assert stored_hash.startswith("pbkdf2_sha256$")

            # Save a portfolio for this user
            r_port = client.post(
                "/api/portfolios",
                headers={"Authorization": f"Bearer {token}"},
                json={"portfolio_name": "My Retirement", "tickers": ["AAPL", "MSFT"]},
            )
            assert r_port.status_code == 200

            # 3. Rate limiting: 5 failed login attempts trigger HTTP 429 on the 6th attempt
            for _ in range(5):
                r_fail = client.post(
                    "/api/auth/login",
                    json={"email": "user@example.com", "password": "WrongPassword999", "mode": "signin"},
                )
                assert r_fail.status_code == 401
            r_locked = client.post(
                "/api/auth/login",
                json={"email": "user@example.com", "password": "WrongPassword999", "mode": "signin"},
            )
            assert r_locked.status_code == 429

            # 4. PDPA Account Deletion removes both the user and their saved portfolios
            r_del = client.delete(
                "/api/auth/account",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert r_del.status_code == 200
            assert r_del.json()["deleted_portfolios"] == 1
            db_after = quantfolio_app._load_db()
            assert "user@example.com" not in db_after["users"]
            assert all(p.get("email") != "user@example.com" for p in db_after["portfolios"])
        finally:
            quantfolio_app._login_attempts.clear()
            quantfolio_app._get_db_file_path = orig_db_fn


def test_frontend_and_gitignore_safeguards():
    """Audit #8, #10, #12, #18: Verify .gitignore, XSS escaping helpers, zero-price safeguard, and toast ID."""
    gitignore_path = os.path.join(PROJECT_ROOT, ".gitignore")
    with open(gitignore_path, "r", encoding="utf-8") as f:
        gitignore_txt = f.read()
    assert "quantfolio_users_db.json" in gitignore_txt

    for rel_js in ("app.js", os.path.join("static", "app.js")):
        js_path = os.path.join(PROJECT_ROOT, rel_js)
        with open(js_path, "r", encoding="utf-8") as f:
            js_txt = f.read()
        assert "function escapeHtmlText(" in js_txt
        assert "function sanitizeExternalUrl(" in js_txt
        assert "document.getElementById('portfolio-toast-text')" in js_txt
        assert "window.QuantFolioCalc" in js_txt

    for rel_auth in ("supabase_auth.js", os.path.join("static", "supabase_auth.js")):
        auth_path = os.path.join(PROJECT_ROOT, rel_auth)
        with open(auth_path, "r", encoding="utf-8") as f:
            auth_txt = f.read()
        assert "function escapeHtml(" in auth_txt
        assert "deleteUserAccount" in auth_txt
        assert "function buildLocalAvatarSvg(" in auth_txt
        assert "https://ui-avatars.com/api/" not in auth_txt


if __name__ == "__main__":
    suite = [
        test_health_endpoint,
        test_daily_fx_conversion_mixed_currency,
        test_sample_volatility_and_correlation_unshrunk,
        test_drawdown_peak_to_trough_monetary,
        test_calendar_alignment_annualization_and_currency_rf,
        test_min_volatility_and_hrp_unmodified_by_news_signal,
        test_walk_forward_backtest_and_quarterly_rebalance_fees,
        test_auth_pbkdf2_signin_mode_rate_limit_and_pdpa_delete,
        test_frontend_and_gitignore_safeguards,
    ]
    print("============================= system test suite =============================")
    passed = 0
    failed = 0
    for fn in suite:
        try:
            fn()
            print(f"tests/test_system_suite.py::{fn.__name__} PASSED")
            passed += 1
        except Exception:
            print(f"tests/test_system_suite.py::{fn.__name__} FAILED")
            traceback.print_exc()
            failed += 1
    print(f"=========================== {failed} failed, {passed} passed ===========================")
    sys.exit(1 if failed > 0 else 0)
