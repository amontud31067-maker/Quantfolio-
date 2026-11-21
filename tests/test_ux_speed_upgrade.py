import os
import time
import numpy as np
import pandas as pd
import pytest
import optimizer as opt
import app as main_app


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel_path: str) -> str:
    with open(os.path.join(ROOT, rel_path), "r", encoding="utf-8") as f:
        return f.read()


def _make_deterministic_prices():
    rng = np.random.default_rng(123)
    dates = pd.bdate_range("2023-01-02", periods=520)
    tickers = ["AAA", "BBB", "CCC", "DDD", "EEE"]
    rets = rng.normal(
        [0.0007, 0.0005, 0.0003, 0.0009, 0.0002],
        [0.015, 0.012, 0.007, 0.022, 0.010],
        size=(len(dates), len(tickers)),
    )
    prices = pd.DataFrame(100.0 * np.cumprod(1.0 + rets, axis=0), index=dates, columns=tickers)
    return prices, tickers


def test_speedup_preserves_exact_mathematical_baseline():
    """Vectorized simplex projection & caching must produce 100% identical numbers to unmodified baseline."""
    prices, tickers = _make_deterministic_prices()
    mu = opt.expected_returns.mean_historical_return(prices, frequency=None)
    S = opt.risk_models.CovarianceShrinkage(prices, frequency=252).ledoit_wolf()
    rdf = prices.pct_change().dropna()

    # Exact baseline values captured from unmodified optimizer.py before speedup edits
    expected = {
        1.0: {
            "max_w": {"AAA": 0.1493, "BBB": 0.0109, "CCC": 0.8398, "DDD": 0.0, "EEE": 0.0},
            "max_ret": 0.252201,
            "max_vol": 0.106668,
            "min_w": {"AAA": 0.0943, "BBB": 0.1793, "CCC": 0.4367, "DDD": 0.0382, "EEE": 0.2515},
            "hrp_w": {"AAA": 0.0989, "BBB": 0.1709, "CCC": 0.4637, "DDD": 0.0468, "EEE": 0.2197},
            "wf_last": {"max_sharpe": 1.340129, "min_volatility": 1.2673, "hrp": 1.285349, "equal_weight": 1.125807},
        },
        0.35: {
            "max_w": {"AAA": 0.293, "BBB": 0.1775, "CCC": 0.35, "DDD": 0.0, "EEE": 0.1795},
            "max_ret": 0.165066,
            "max_vol": 0.092776,
            "min_w": {"AAA": 0.113, "BBB": 0.2079, "CCC": 0.35, "DDD": 0.0442, "EEE": 0.2849},
            "hrp_w": {"AAA": 0.1199, "BBB": 0.2071, "CCC": 0.35, "DDD": 0.0567, "EEE": 0.2663},
            "wf_last": {"max_sharpe": 1.223508, "min_volatility": 1.231392, "hrp": 1.229862, "equal_weight": 1.125807},
        },
    }

    opt._wf_cache.clear()
    for hi, ref in expected.items():
        sol = opt._solve_all_strategies(mu, S, rdf, tickers, (0.0, hi), 0.035, None)
        for k, exp_w in ref["max_w"].items():
            assert abs(sol["max_sharpe"]["weights"][k] - exp_w) <= 1e-4
        assert abs(sol["max_sharpe"]["ret"] - ref["max_ret"]) <= 1e-5
        assert abs(sol["max_sharpe"]["vol"] - ref["max_vol"]) <= 1e-5
        for k, exp_w in ref["min_w"].items():
            assert abs(sol["min_volatility"]["weights"][k] - exp_w) <= 1e-4
        for k, exp_w in ref["hrp_w"].items():
            assert abs(sol["hrp"]["weights"][k] - exp_w) <= 1e-4

        wf1 = opt.compute_walk_forward_backtest(prices, tickers, (0.0, hi), 0.035, 252)
        for strat_k, exp_last in ref["wf_last"].items():
            assert abs(float(wf1[strat_k].iloc[-1]) - exp_last) <= 1e-5

        # Second call hits TTL cache and completes near-instantly with identical values
        t0 = time.perf_counter()
        wf2 = opt.compute_walk_forward_backtest(prices, tickers, (0.0, hi), 0.035, 252)
        dt_cached = time.perf_counter() - t0
        assert dt_cached < 0.05, f"Expected cached walk-forward < 0.05s, took {dt_cached:.3f}s"
        for strat_k in ref["wf_last"]:
            assert abs(float(wf2[strat_k].iloc[-1]) - float(wf1[strat_k].iloc[-1])) == 0.0


def test_vectorized_frontier_batch_matches_scalar_solver():
    """EfficientFrontier.efficient_return_batch must match scalar efficient_return point-for-point."""
    prices, tickers = _make_deterministic_prices()
    mu = opt.expected_returns.mean_historical_return(prices, frequency=None)
    S = opt.risk_models.CovarianceShrinkage(prices, frequency=252).ledoit_wolf()
    ef = opt.EfficientFrontier(mu, S, weight_bounds=(0.0, 0.45))
    if not hasattr(ef, "efficient_return_batch"):
        pytest.skip("Using external pypfopt EfficientFrontier")

    targets = np.linspace(float(mu.min()) + 0.02, float(mu.max()) - 0.02, 10)
    batch_pts = ef.efficient_return_batch(targets, risk_free_rate=0.035)
    assert len(batch_pts) == len(targets)

    for i, tr in enumerate(targets):
        ef_single = opt.EfficientFrontier(mu, S, weight_bounds=(0.0, 0.45))
        ef_single.efficient_return(float(tr))
        r_s, v_s, sr_s = ef_single.portfolio_performance(risk_free_rate=0.035)
        assert abs(batch_pts[i]["ret"] - round(float(r_s), 4)) <= 1e-4
        assert abs(batch_pts[i]["vol"] - round(float(v_s), 4)) <= 1e-4
        assert abs(batch_pts[i]["sharpe"] - round(float(sr_s), 3)) <= 1e-3


def test_quote_cache_ttl_and_batch_guard():
    assert main_app.QUOTE_CACHE_TTL >= 60
    app_src = _read("app.py")
    assert "yf.download(" in app_src
    assert "remaining_symbols" in app_src


def test_frontend_ux_speed_loading_dark_mode_and_mobile_guards():
    for html_path in ("index.html", "static/index.html"):
        h = _read(html_path)
        for token in (
            'id="loading-card" class="hidden fixed inset-0',
            'id="loading-elapsed-timer"',
            'id="header-brand-wordmark"',
            'id="btn-refresh-market-news"',
            'id="deep-dive-body-milestones"',
            'id="goal-milestone-table-body"',
            'จากจุดสูงสุดสู่จุดต่ำสุด',
        ):
            assert token in h, f"Missing {token} in {html_path}"
        assert "(Peak ➔ Trough)" not in h, f"Untranslated Peak->Trough heading still in {html_path}"

    for css_path in ("styles.css", "static/styles.css"):
        c = _read(css_path)
        for token in (
            "html body.theme-dark .hover\\:bg-slate-50\\/90:hover",
            ".qf-inline-shimmer",
            "html body.theme-dark #loading-card .qf-loading-overlay-card",
            "body.qf-view-workspace #header-brand-wordmark",
        ):
            assert token in c, f"Missing {token} in {css_path}"

    for js_path in ("app.js", "static/app.js"):
        j = _read(js_path)
        for token in (
            "qf-view-workspace",
            "ไม่จัดสรรในแผนนี้ (0%)",
            "แผนนี้ชนะ 1/N",
            "แผนนี้แพ้ 1/N",
            "loading-elapsed-timer",
            "goal-milestone-table-body",
            "setup-advanced-drawer",
            "frontierAnnotations",
            "1ด:",
        ):
            assert token in j, f"Missing {token} in {js_path}"
        assert "| 1M:" not in j, f"Legacy mixed English '1M:' label still in {js_path}"
