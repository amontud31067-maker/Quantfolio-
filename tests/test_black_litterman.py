"""
Regression & mathematical verification suite for QuantFolio's analytical
Black-Litterman engine (He-Litterman + Idzorek 2005), phrase/negation-aware
sentiment analysis, core-formula preservation, and Tab 3 Hybrid UI controls.
"""
import os
import numpy as np
import pandas as pd

import optimizer as opt_module
import app as quantfolio_app

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read_text(rel_path: str) -> str:
    with open(os.path.join(PROJECT_ROOT, rel_path), "r", encoding="utf-8") as f:
        return f.read()


def _build_correlated_cov_and_mu():
    tickers = ["AAA", "BBB", "CCC"]
    vols = np.array([0.30, 0.28, 0.20])
    corr = np.array([
        [1.00, 0.85, 0.00],
        [0.85, 1.00, 0.00],
        [0.00, 0.00, 1.00],
    ])
    cov_arr = np.outer(vols, vols) * corr
    S = pd.DataFrame(cov_arr, index=tickers, columns=tickers)
    mu = pd.Series({"AAA": 0.18, "BBB": 0.14, "CCC": 0.09})
    w_prior = {"AAA": 0.25, "BBB": 0.25, "CCC": 0.50}
    return tickers, mu, S, w_prior


def test_bl_equilibrium_recovery_at_zero_confidence_and_zero_views():
    tickers, mu, S, w_prior = _build_correlated_cov_and_mu()
    rf = 0.025

    res_conf0 = opt_module.compute_black_litterman_posterior(
        mu_hist=mu,
        S_mat=S,
        prior_weights=w_prior,
        valid_tickers=tickers,
        rf_rate=rf,
        views_delta={"AAA": 0.08, "CCC": -0.04},
        confidence=0.0,
        tau=0.05,
    )
    assert np.allclose(res_conf0["mu_bl"].values, res_conf0["pi_total"].values, atol=1e-10)
    assert np.allclose(res_conf0["Sigma_bl"].values, S.values, atol=1e-10)
    assert res_conf0["active_view_count"] == 0

    # Maximizing Sharpe on (pi_total, S) recovers w_prior cleanly
    ef = opt_module.EfficientFrontier(res_conf0["mu_bl"], res_conf0["Sigma_bl"], weight_bounds=(0.0, 1.0))
    ef.max_sharpe(risk_free_rate=rf)
    w_rec = opt_module._cap_and_normalize_weights(ef.clean_weights(), tickers, 0.0, 1.0)
    for t in tickers:
        assert abs(w_rec[t] - w_prior[t]) < 0.01, f"Expected prior recovery for {t}: {w_rec[t]} vs {w_prior[t]}"

    # Zero views with high confidence also equals pure equilibrium prior
    res_zero_views = opt_module.compute_black_litterman_posterior(
        mu_hist=mu,
        S_mat=S,
        prior_weights=w_prior,
        valid_tickers=tickers,
        rf_rate=rf,
        views_delta={"AAA": 0.0, "BBB": 0.0, "CCC": 0.0},
        confidence=0.90,
        tau=0.05,
    )
    assert np.allclose(res_zero_views["mu_bl"].values, res_zero_views["pi_total"].values, atol=1e-10)


def test_bl_idzorek_monotonicity_and_covariance_spillover():
    tickers, mu, S, w_prior = _build_correlated_cov_and_mu()
    rf = 0.025
    view_delta = {"AAA": 0.06}

    post_aaa = []
    post_bbb = []
    post_ccc = []
    prior_map = None

    for conf in (0.0, 0.25, 0.50, 0.85, 1.0):
        res = opt_module.compute_black_litterman_posterior(
            mu_hist=mu,
            S_mat=S,
            prior_weights=w_prior,
            valid_tickers=tickers,
            rf_rate=rf,
            views_delta=view_delta,
            confidence=conf,
            tau=0.05,
        )
        prior_map = res["pi_total"]
        assert np.all(np.isfinite(res["mu_bl"].values))
        assert np.all(np.isfinite(res["Sigma_bl"].values))
        eigvals = np.linalg.eigvalsh(res["Sigma_bl"].values)
        assert np.all(eigvals > 0), f"Posterior covariance not positive definite at conf={conf}"

        post_aaa.append(float(res["mu_bl"]["AAA"]))
        post_bbb.append(float(res["mu_bl"]["BBB"]))
        post_ccc.append(float(res["mu_bl"]["CCC"]))

    # Strict monotonic increase for viewed asset AAA as confidence rises
    for i in range(len(post_aaa) - 1):
        assert post_aaa[i + 1] > post_aaa[i], f"Non-monotonic AAA posterior: {post_aaa}"

    # At confidence=1.0, AAA posterior hits pi_total[AAA] + 0.06 exactly
    assert np.isclose(post_aaa[-1], float(prior_map["AAA"]) + 0.06, atol=1e-5)

    # Covariance spillover: positively correlated BBB moves upward significantly, while uncorrelated CCC stays flat
    bbb_shift = post_bbb[-1] - float(prior_map["BBB"])
    ccc_shift = abs(post_ccc[-1] - float(prior_map["CCC"]))
    assert bbb_shift > 0.03, f"Expected strong positive covariance spillover to BBB, got {bbb_shift}"
    assert ccc_shift < 1e-6, f"Expected ~0 spillover to uncorrelated CCC, got {ccc_shift}"


def test_core_formulas_untouched_and_non_max_sharpe_invariance(monkeypatch):
    rng = np.random.default_rng(123)
    dates = pd.bdate_range("2023-01-02", periods=140)
    tickers = ["AAA", "BBB", "CCC", "DDD"]
    rets = pd.DataFrame(
        rng.normal(loc=[0.0008, 0.0005, 0.0003, 0.0006], scale=[0.018, 0.015, 0.010, 0.022], size=(len(dates), 4)),
        index=dates,
        columns=tickers,
    )
    mock_prices = 100.0 * (1.0 + rets).cumprod()
    mock_prices.attrs["raw_last_dates"] = {t: dates[-1].strftime("%Y-%m-%d") for t in tickers}

    monkeypatch.setattr(opt_module, "fetch_historical_prices", lambda t, s, e: (mock_prices.copy(), list(tickers), []))
    monkeypatch.setattr(opt_module, "fetch_portfolio_market_news", lambda t: {})
    monkeypatch.setattr(opt_module, "get_usd_thb_rate", lambda: 34.50)
    monkeypatch.setattr(opt_module, "get_risk_free_rate", lambda **kwargs: 0.0225)
    monkeypatch.setattr(opt_module, "convert_prices_to_base_currency", lambda prices, **kwargs: prices.copy())

    res_hist = opt_module.run_portfolio_optimization(
        tickers=tickers,
        start_date="2023-01-02",
        end_date="2023-07-15",
        budget=100000.0,
        currency="USD",
        fx_rate=34.50,
        risk_free_rate=0.0225,
        num_simulations=500,
        use_news_adjustment=False,
    )
    res_bl = opt_module.run_portfolio_optimization(
        tickers=tickers,
        start_date="2023-01-02",
        end_date="2023-07-15",
        budget=100000.0,
        currency="USD",
        fx_rate=34.50,
        risk_free_rate=0.0225,
        num_simulations=500,
        use_news_adjustment=True,
        bl_confidence=0.75,
        bl_views={"AAA": 0.06, "DDD": -0.04},
    )

    # 1. Core individual asset statistics remain 100% identical
    hist_assets = {a["ticker"]: a for a in res_hist["asset_stats"]}
    bl_assets = {a["ticker"]: a for a in res_bl["asset_stats"]}
    for t in tickers:
        for field in ("expected_return", "volatility", "total_return", "sharpe_ratio", "max_drawdown"):
            assert hist_assets[t][field] == bl_assets[t][field], f"Core asset formula changed for {t}.{field}"

    # 2. Min Volatility, HRP, and Equal Weight stay 100% identical in weights & metrics
    for sk in ("min_volatility", "hrp", "equal_weight"):
        assert res_hist["strategies"][sk]["weights"] == res_bl["strategies"][sk]["weights"]
        assert res_hist["strategies"][sk]["expected_return"] == res_bl["strategies"][sk]["expected_return"]
        assert res_hist["strategies"][sk]["volatility"] == res_bl["strategies"][sk]["volatility"]
        assert res_hist["strategies"][sk]["sharpe_ratio"] == res_bl["strategies"][sk]["sharpe_ratio"]

    # 3. Black-Litterman Max Sharpe sums to 100% and exposes full transparency metadata
    bl_meta = res_bl["black_litterman"]
    assert bl_meta["enabled"] is True
    assert bl_meta["prior_source"] == "hrp_equilibrium"
    assert bl_meta["confidence"] == 0.75
    assert bl_meta["applied_views"]["AAA"] == 0.06
    assert bl_meta["applied_views"]["DDD"] == -0.04
    assert np.isclose(sum(res_bl["strategies"]["max_sharpe"]["weights"].values()), 1.0, atol=1e-3)


def test_upgraded_headline_sentiment_idioms_word_boundaries_and_negations():
    sent, score, _ = opt_module.analyze_headline_sentiment("Fed rate cut boosts tech stocks")
    assert sent == "positive" and score > 0

    sent, score, _ = opt_module.analyze_headline_sentiment("Fed rate hike pressures equities")
    assert sent == "negative" and score < 0

    sent, score, _ = opt_module.analyze_headline_sentiment("Why AAPL is NOT a buy right now")
    assert sent == "negative" and score < 0

    sent, score, _ = opt_module.analyze_headline_sentiment("High risk ahead for speculative tokens")
    assert sent == "negative" and score < 0

    # Word boundary check: "executes" must not match "cut", "waterfall" must not match "fall"
    sent, score, _ = opt_module.analyze_headline_sentiment("Company executes waterfall roadmap smoothly")
    assert sent == "neutral" and score == 0.0

    # Thai idioms & negation
    sent, score, _ = opt_module.analyze_headline_sentiment("หุ้นกลุ่มแบงก์กำไรโตเกินคาดรับลดดอกเบี้ย")
    assert sent == "positive" and score > 0

    sent, score, _ = opt_module.analyze_headline_sentiment("นักวิเคราะห์ไม่แนะนำซื้อหลังความเสี่ยงสูง")
    assert sent == "negative" and score < 0


def test_api_schema_and_frontend_bl_controls():
    req = quantfolio_app.OptimizeRequest()
    assert req.use_news_adjustment is False
    assert req.bl_confidence == 0.50
    assert req.bl_views is None

    req_custom = quantfolio_app.OptimizeRequest(
        use_news_adjustment=True,
        bl_confidence=0.80,
        bl_views={"NVDA": 0.04, "AAPL": -0.02},
    )
    assert req_custom.bl_confidence == 0.80
    assert req_custom.bl_views == {"NVDA": 0.04, "AAPL": -0.02}

    html = _read_text("index.html")
    app_js = _read_text("app.js")
    css = _read_text("styles.css")

    assert 'id="bl-controls-panel"' in html
    assert "Black-Litterman (Max Sharpe)" in html
    assert "function renderBlackLittermanControlsPanel(" in app_js
    assert "function handleBLConfidenceInput(" in app_js
    assert "function setBLAssetView(" in app_js
    assert "function fillBLViewsFromSignals(" in app_js
    assert "function resetBLViewsNeutral(" in app_js
    assert 'id="bl-confidence-slider"' in app_js
    assert "bl_confidence:" in app_js and "bl_views:" in app_js
    assert "มุมมอง BL:" in app_js
    assert "/api/market-news?tickers=${q}&force=true" in app_js
    assert "html body.theme-dark #bl-controls-panel" in css
    assert "html body.theme-dark .qf-bl-pill-pos-active" in css


def test_bl_volatility_and_weight_continuity_near_zero_confidence():
    """
    Audit Finding #1: Ensure confidence 0% -> 1% has zero step jump in Sigma_bl / portfolio volatility.
    """
    tickers, mu, S, w_prior = _build_correlated_cov_and_mu()
    rf = 0.025
    view_delta = {"AAA": 0.04}

    res_0 = opt_module.compute_black_litterman_posterior(
        mu_hist=mu, S_mat=S, prior_weights=w_prior, valid_tickers=tickers,
        rf_rate=rf, views_delta=view_delta, confidence=0.0, tau=0.05
    )
    res_1pct = opt_module.compute_black_litterman_posterior(
        mu_hist=mu, S_mat=S, prior_weights=w_prior, valid_tickers=tickers,
        rf_rate=rf, views_delta=view_delta, confidence=0.01, tau=0.05
    )

    assert np.allclose(res_0["Sigma_bl"].values, res_1pct["Sigma_bl"].values, atol=1e-12)
    assert np.allclose(res_0["mu_bl"].values, res_1pct["mu_bl"].values, atol=1e-3)

    ef0 = opt_module.EfficientFrontier(res_0["mu_bl"], res_0["Sigma_bl"], weight_bounds=(0.0, 1.0))
    ef0.max_sharpe(risk_free_rate=rf)
    w0 = pd.Series(opt_module._cap_and_normalize_weights(ef0.clean_weights(), tickers, 0.0, 1.0))
    vol0 = float(np.sqrt(w0 @ res_0["Sigma_bl"] @ w0))

    ef1 = opt_module.EfficientFrontier(res_1pct["mu_bl"], res_1pct["Sigma_bl"], weight_bounds=(0.0, 1.0))
    ef1.max_sharpe(risk_free_rate=rf)
    w1 = pd.Series(opt_module._cap_and_normalize_weights(ef1.clean_weights(), tickers, 0.0, 1.0))
    vol1 = float(np.sqrt(w1 @ res_1pct["Sigma_bl"] @ w1))

    assert abs(vol1 - vol0) < 0.002, f"Volatility jumped discontinuously between 0% and 1% confidence: {vol0} -> {vol1}"


def test_clause_boundary_negation_and_force_refresh_dedup(monkeypatch):
    """
    Audit Findings #2 & #3:
    - Clause punctuation (',', ';', 'but') prevents negation from leaking across clauses.
    - fetch_market_news_for_ticker supports force_refresh=True and deduplicates identical titles.
    """
    # Comma stops 'No' in first clause from negating 'profit' / 'surges' in second clause
    sent, score, _ = opt_module.analyze_headline_sentiment("No delay in chip production, profit surges")
    assert sent == "positive" and score > 0

    # Thai negated negative word ('ไม่ร่วง') is not penalized as negative
    sent_th, score_th, _ = opt_module.analyze_headline_sentiment("หุ้นไทยไม่ร่วงและฟื้นตัวแข็งแกร่ง")
    assert sent_th == "positive" and score_th > 0

    # Force refresh + deduplication check
    class _FakeResp:
        status_code = 200
        content = b"<rss><channel><item><title>AAPL profit surges to record</title><source>Reuters</source></item></channel></rss>"
        def json(self):
            return {
                "news": [
                    {"title": "AAPL profit surges to record", "publisher": "Yahoo"},
                    {"title": "AAPL profit   surges to record ", "publisher": "Yahoo Duplicate"},
                ]
            }

    call_counter = {"count": 0}
    def _fake_get(url, headers=None, timeout=3.5):
        call_counter["count"] += 1
        return _FakeResp()

    monkeypatch.setattr(opt_module.requests, "get", _fake_get)
    res_first = opt_module.fetch_market_news_for_ticker("AAPL", max_items=4, force_refresh=True)
    # Duplicate headline across Yahoo + RSS must be deduplicated to 1 unique article
    assert len(res_first["articles"]) == 1
    first_calls = call_counter["count"]

    # Cached call without force_refresh makes 0 new HTTP requests
    opt_module.fetch_market_news_for_ticker("AAPL", max_items=4, force_refresh=False)
    assert call_counter["count"] == first_calls

    # force_refresh=True bypasses cache and fetches fresh
    opt_module.fetch_market_news_for_ticker("AAPL", max_items=4, force_refresh=True)
    assert call_counter["count"] > first_calls
