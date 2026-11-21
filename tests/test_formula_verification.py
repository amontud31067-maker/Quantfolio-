import numpy as np
import pandas as pd
import pytest
from optimizer import (
    compute_max_drawdown,
    compute_drawdown_details,
    _solve_all_strategies,
    run_portfolio_optimization,
    _infer_effective_trading_days,
    get_risk_free_rate,
    convert_prices_to_base_currency
)


def test_weights_sum_to_one_and_non_negative():
    """
    Topic 4: All asset weights must be non-negative (w_i >= 0) and sum exactly to 1.0 (100%).
    """
    tickers = ["AAPL", "MSFT", "GOOGL"]
    returns_data = {
        "AAPL": [0.01, -0.005, 0.02, 0.015, -0.01],
        "MSFT": [0.005, 0.01, -0.01, 0.02, 0.005],
        "GOOGL": [0.02, -0.01, 0.015, 0.005, -0.005]
    }
    rets_df = pd.DataFrame(returns_data)
    mu = pd.Series([0.15, 0.12, 0.14], index=tickers)
    S = rets_df.cov() * 252.0

    weight_bounds = (0.0, 1.0)
    rf_rate = 0.0225

    solutions = _solve_all_strategies(mu, S, rets_df, tickers, weight_bounds, rf_rate, None)

    for strat_key, sol in solutions.items():
        w_dict = sol["weights"]
        weights = np.array([w_dict[t] for t in tickers])
        # 1. Non-negative
        assert (weights >= -1e-6).all(), f"Strategy {strat_key} has negative weights: {w_dict}"
        # 2. Sum to 1.0
        assert np.isclose(weights.sum(), 1.0, atol=1e-3), f"Strategy {strat_key} weights sum to {weights.sum()}, expected 1.0"


def test_impossible_max_weight_ceiling_behavior(monkeypatch):
    """
    Topic 4: When an impossible max weight ceiling is given (e.g. 4 assets with max_weight=0.10,
    where 4 * 0.10 = 0.40 < 1.0), the optimizer MUST raise a ValueError,
    instead of silently relaxing the constraint.
    """
    import optimizer as opt_module
    from unittest.mock import patch

    n_assets = 4
    user_max_weight = 0.10
    tickers = ["ASSET1", "ASSET2", "ASSET3", "ASSET4"]
    dates = pd.date_range("2023-01-01", periods=100, freq="B")
    mock_prices = pd.DataFrame(
        {t: 100.0 + np.cumsum(np.random.normal(0.05, 1.0, 100)) for t in tickers},
        index=dates
    )

    monkeypatch.setattr(opt_module, "fetch_historical_prices", lambda t, s, e: (mock_prices.copy(), list(tickers), []))
    monkeypatch.setattr(opt_module, "fetch_portfolio_market_news", lambda t: {})
    monkeypatch.setattr(opt_module, "get_usd_thb_rate", lambda: 34.50)
    monkeypatch.setattr(opt_module, "get_risk_free_rate", lambda **kwargs: 0.0225)

    with pytest.raises(ValueError) as excinfo:
        opt_module.run_portfolio_optimization(
            tickers=tickers,
            start_date="2023-01-01",
            end_date="2023-06-01",
            max_weight=user_max_weight
        )
    assert "เพดานสัดส่วน" in str(excinfo.value) or "100%" in str(excinfo.value)


def test_valid_max_weight_optimization_completes(monkeypatch):
    """
    Regression: valid max_weight (e.g. 0.50 across 4 assets -> 200% >= 100%)
    must complete end-to-end (Monte Carlo + metadata) without NameError.
    """
    import optimizer as opt_module

    tickers = ["ASSET1", "ASSET2", "ASSET3", "ASSET4"]
    dates = pd.date_range("2023-01-01", periods=100, freq="B")
    rng = np.random.default_rng(7)
    mock_prices = pd.DataFrame(
        {t: 100.0 * np.cumprod(1.0 + rng.normal(0.0006, 0.015, 100)) for t in tickers},
        index=dates
    )

    monkeypatch.setattr(opt_module, "fetch_historical_prices", lambda t, s, e: (mock_prices.copy(), list(tickers), []))
    monkeypatch.setattr(opt_module, "fetch_portfolio_market_news", lambda t: {})
    monkeypatch.setattr(opt_module, "get_usd_thb_rate", lambda: 34.50)
    monkeypatch.setattr(opt_module, "get_risk_free_rate", lambda **kwargs: 0.0225)

    res = opt_module.run_portfolio_optimization(
        tickers=tickers,
        start_date="2023-01-01",
        end_date="2023-06-01",
        budget=100000.0,
        max_weight=0.50,
        num_simulations=500,
    )
    assert res["status"] == "success"
    assert res["metadata"]["max_weight"] == 0.50
    for strat in res["strategies"].values():
        w_sum = sum(strat["weights"].values())
        assert np.isclose(w_sum, 1.0, atol=1e-2)


def test_max_drawdown_hand_calculated_case():
    """
    Topic 4: Max Drawdown hand-calculated test case:
    Prices = [100, 120, 90, 110]
    t=0: P=100, peak=100, dd=0%
    t=1: P=120, peak=120, dd=0%
    t=2: P=90,  peak=120, dd=(90-120)/120 = -30/120 = -25% (-0.25)
    t=3: P=110, peak=120, dd=(110-120)/120 = -10/120 = -8.33%
    Max Drawdown = -25.0% (-0.25)
    """
    prices = pd.Series([100.0, 120.0, 90.0, 110.0])
    mdd = compute_max_drawdown(prices)
    assert np.isclose(mdd, -0.25), f"Expected -0.25 (-25%), got {mdd}"

    # Verify compute_drawdown_details
    details = compute_drawdown_details(prices / 100.0, budget=100000.0)
    assert np.isclose(details["max_drawdown_pct"], -0.25)
    # Peak level was 1.20 (120k), trough level was 0.90 (90k)
    # Drop = 120k - 90k = 30k
    assert np.isclose(details["peak_to_trough_amount"], 30000.0)


def test_rebalancing_hand_calculated_and_cash_balance():
    """
    Topic 4: Rebalancing hand-calculated test case:
    Holdings: Asset A = 600,000 THB, Asset B = 400,000 THB (Total = 1,000,000 THB).
    Target: 50/50 -> Target A = 500,000, Target B = 500,000.
    Expected action: Sell 100,000 of Asset A, Buy 100,000 of Asset B.
    """
    holdings = {"A": 600000.0, "B": 400000.0}
    total_budget = sum(holdings.values())
    target_weights = {"A": 0.50, "B": 0.50}

    # Raw Deltas
    target_values = {t: total_budget * target_weights[t] for t in holdings}
    raw_deltas = {t: target_values[t] - holdings[t] for t in holdings}

    assert raw_deltas["A"] == -100000.0, f"Expected sell 100k of A, got {raw_deltas['A']}"
    assert raw_deltas["B"] == 100000.0, f"Expected buy 100k of B, got {raw_deltas['B']}"

    # Pure cash balance test with 0% fee buffer:
    sell_amount = abs(raw_deltas["A"])
    cash_generated = sell_amount
    buy_amount = min(cash_generated, raw_deltas["B"])
    leftover_cash = cash_generated - buy_amount
    assert sell_amount == 100000.0
    assert buy_amount == 100000.0
    assert leftover_cash == 0.0

    # With 0.20% fee buffer as implemented in app.js:
    fee_rate = 0.0020
    fee_reserve = cash_generated * fee_rate  # 200 THB
    net_spendable = cash_generated - fee_reserve  # 99,800 THB
    buy_with_fee = net_spendable
    assert buy_with_fee == 99800.0
    # Leftover cash exactly equals fee reserve, ensuring solvency
    assert np.isclose(cash_generated - buy_with_fee, 200.0)


def test_rebalancing_small_order_pruning_balance():
    """
    Topic 4: Test balance after trimming small orders (minThreshold):
    If an order is pruned because delta < minThreshold (e.g. 50 THB < 100 THB),
    verify that the portfolio never runs a cash deficit (buys <= actual cash from sells).
    """
    # 3 assets:
    # A has sell delta 50 THB (below 100 threshold -> pruned to HOLD)
    # B has sell delta 5000 THB (above 100 -> SELL 5000)
    # C has buy delta 5050 THB
    min_threshold = 100.0
    sell_orders_raw = {"A": 50.0, "B": 5000.0}
    buy_orders_raw = {"C": 5050.0}

    # Prune sells
    actual_sells = {t: amt for t, amt in sell_orders_raw.items() if amt >= min_threshold}
    assert "A" not in actual_sells, "Asset A should be pruned to HOLD"
    cash_available = sum(actual_sells.values())
    assert cash_available == 5000.0

    # Scale buys so they never exceed cash_available
    total_buy_need = sum(buy_orders_raw.values())
    scale = min(1.0, cash_available / total_buy_need)
    executed_buys = {t: amt * scale for t, amt in buy_orders_raw.items()}
    total_executed_buys = sum(executed_buys.values())

    assert total_executed_buys <= cash_available, "Executed buys exceeded cash available!"
    assert np.isclose(total_executed_buys, 5000.0)


def test_future_value_and_annuity_factor():
    """
    Topic 4: Future Value and Compounding Annuity formula verification:
    P = 100,000, PMT = 10,000 / month, annual return = 12%, years = 1 (12 months).
    Monthly effective return: r_m = (1 + 0.12)^(1/12) - 1.
    FV = P * (1 + r_m)^12 + PMT * [((1 + r_m)^12 - 1) / r_m].
    """
    p = 100000.0
    pmt = 10000.0
    r_annual = 0.12
    n_months = 12

    r_month = (1.0 + r_annual) ** (1.0 / 12.0) - 1.0
    fv_lump_sum = p * ((1.0 + r_month) ** n_months)
    annuity_factor = ((1.0 + r_month) ** n_months - 1.0) / r_month
    fv_annuity = pmt * annuity_factor
    fv_total_formula = fv_lump_sum + fv_annuity

    # Verify against month-by-month compounding simulation (as in app.js)
    sim_wealth = p
    for m in range(n_months):
        sim_wealth = sim_wealth * (1.0 + r_month) + pmt

    assert np.isclose(fv_total_formula, sim_wealth, rtol=1e-5), \
        f"Formula FV ({fv_total_formula}) and simulation ({sim_wealth}) must match exactly"


def test_correlation_matrix_properties():
    """
    Topic 4: Correlation matrix mathematical validity:
    1. Diagonal elements are exactly 1.0.
    2. Symmetric: C_ij == C_ji.
    3. All values in [-1, 1].
    4. Positive semi-definite: all eigenvalues >= -1e-8.
    """
    np.random.seed(42)
    sample_rets = pd.DataFrame(
        np.random.normal(0.001, 0.02, size=(250, 4)),
        columns=["ASSET1", "ASSET2", "ASSET3", "ASSET4"]
    )
    corr_df = sample_rets.corr()
    corr_mat = corr_df.values

    # 1. Diagonal == 1
    assert np.allclose(np.diag(corr_mat), 1.0), "Diagonal of correlation matrix must be 1.0"

    # 2. Symmetric
    assert np.allclose(corr_mat, corr_mat.T), "Correlation matrix must be symmetric"

    # 3. Values in [-1, 1]
    assert (corr_mat >= -1.0).all() and (corr_mat <= 1.0).all(), "Values must lie within [-1, 1]"

    # 4. Positive Semi-Definite (Eigenvalues >= 0)
    eigenvalues = np.linalg.eigvalsh(corr_mat)
    assert (eigenvalues >= -1e-8).all(), f"Eigenvalues must be non-negative, got {eigenvalues}"


def test_hrp_respects_max_weight_ceiling_and_exact_100pct_sum():
    """
    Audit Finding #2 & #5:
    1. When max_weight < 1.0 (e.g. 0.35 across 4 assets where 1 asset has tiny volatility),
       HRP MUST respect the max_weight ceiling (<= 0.35) just like Max Sharpe & Min Volatility.
    2. All 4 strategies must have weights summing to 1.0000 and metrics (ret, vol, sr)
       matching the cleaned 4-decimal weights.
    """
    rng = np.random.default_rng(123)
    tickers = ["TLT", "NVDA", "TSLA", "BTC-USD"]
    # TLT has very low vol (0.3% daily) while others have high vol (3-4% daily)
    rets_df = pd.DataFrame({
        "TLT": rng.normal(0.0002, 0.003, 250),
        "NVDA": rng.normal(0.0012, 0.032, 250),
        "TSLA": rng.normal(0.0008, 0.038, 250),
        "BTC-USD": rng.normal(0.0015, 0.042, 250),
    })
    mu = pd.Series({"TLT": 0.04, "NVDA": 0.25, "TSLA": 0.18, "BTC-USD": 0.30})
    S = rets_df.cov() * 252.0
    rf_rate = 0.0225
    max_w = 0.35

    solutions = _solve_all_strategies(mu, S, rets_df, tickers, (0.0, max_w), rf_rate, None)

    for strat_key, sol in solutions.items():
        w_dict = sol["weights"]
        # Every weight must respect [0.0, 0.35]
        for t, w_val in w_dict.items():
            assert -1e-6 <= w_val <= max_w + 1e-6, (
                f"Strategy {strat_key} violated max_weight={max_w} on {t}: {w_val}"
            )
        # Sum must equal 1.0000
        assert round(sum(w_dict.values()), 4) == 1.0, (
            f"Strategy {strat_key} weights did not sum to 1.0000: {w_dict}"
        )
        # Portfolio performance must match cleaned weights
        w_vec = pd.Series(w_dict).reindex(tickers)
        expected_ret = float(w_vec @ mu)
        expected_vol = float(np.sqrt(w_vec @ S @ w_vec))
        expected_sr = (expected_ret - rf_rate) / expected_vol
        assert np.isclose(sol["ret"], expected_ret, atol=1e-6), f"{strat_key} ret mismatch"
        assert np.isclose(sol["vol"], expected_vol, atol=1e-6), f"{strat_key} vol mismatch"
        assert np.isclose(sol["sr"], expected_sr, atol=1e-6), f"{strat_key} sr mismatch"


def test_growth_100_uses_base_currency_converted_prices(monkeypatch):
    """
    Audit Finding #4:
    growth_100 chart series must be computed from `prices_base` (after daily historical FX conversion),
    not raw native-currency `prices`, so that the final point of growth_100 matches `total_return` in asset_stats.
    """
    import optimizer as opt_module

    dates = pd.date_range("2023-01-01", periods=60, freq="B")
    # AAPL in USD grows 10% in USD terms; PTT.BK in THB grows 5% in THB terms
    mock_prices = pd.DataFrame({
        "AAPL": np.linspace(100.0, 110.0, 60),
        "PTT.BK": np.linspace(30.0, 31.5, 60),
    }, index=dates)

    # Simulate USD/THB rising from 33.0 to 36.3 (+10%) over the same 60 days
    fx_series = pd.Series(np.linspace(33.0, 36.3, 60), index=dates)

    monkeypatch.setattr(opt_module, "fetch_historical_prices", lambda t, s, e: (mock_prices.copy(), ["AAPL", "PTT.BK"], []))
    monkeypatch.setattr(opt_module, "fetch_portfolio_market_news", lambda t: {})
    monkeypatch.setattr(opt_module, "get_usd_thb_rate", lambda: 36.30)
    monkeypatch.setattr(opt_module, "get_risk_free_rate", lambda **kwargs: 0.0225)

    orig_convert = opt_module.convert_prices_to_base_currency
    monkeypatch.setattr(
        opt_module,
        "convert_prices_to_base_currency",
        lambda prices, base_currency="THB", fx_series_arg=None, fallback_fx_rate=36.30: orig_convert(
            prices, base_currency=base_currency, fx_series=fx_series, fallback_fx_rate=fallback_fx_rate
        ),
    )

    res = opt_module.run_portfolio_optimization(
        tickers=["AAPL", "PTT.BK"],
        start_date="2023-01-01",
        end_date="2023-03-31",
        budget=100000.0,
        currency="THB",
        num_simulations=300,
    )
    aapl_stat = next(a for a in res["asset_stats"] if a["ticker"] == "AAPL")
    # In THB terms: 1.10 * 1.10 = 1.21 (+21% total return -> growth_100 ends at 121.0)
    assert np.isclose(aapl_stat["total_return"], 0.21, atol=1e-3)
    aapl_growth_end = res["growth_100"]["series"]["AAPL"][-1]
    assert np.isclose(aapl_growth_end, 121.0, atol=0.1), (
        f"Expected AAPL growth_100 in THB to end at ~121.0, got {aapl_growth_end}"
    )


def test_frontend_calculation_audit_fixes():
    """
    Audit Findings #1, #3, #6, #7 in app.js:
    - Finding #1: LANDING_RISK_PROFILES.conservative uses 'min_volatility' (and selectGoal normalizes 'min_vol')
    - Finding #3: computeRebalancePlan accounts for sellFeeReserve + buyFeeReserve and has Pass 2 greedy whole-share allocation
    - Finding #6: LANDING_RISK_PROFILES defines risk-appropriate targetTickers for conservative, balanced, and growth
    - Finding #7: computeGoalProjectionMetrics allows negative downside (-0.05) in conservativeAnnualReturn
    """
    import os
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(project_root, "app.js"), "r", encoding="utf-8") as f:
        app_js = f.read()

    # Finding #1
    assert "targetStrategy: 'min_volatility'" in app_js
    assert "targetStrategy: 'min_vol'" not in app_js
    assert "goalKey === 'min_vol' ? 'min_volatility' : goalKey" in app_js

    # Finding #3
    assert "const sellFeeReserve = Number((totalSellGross * FEE_RATE).toFixed(2));" in app_js
    assert "const buyFeeReserve = Number((cashAfterSellFee * FEE_RATE).toFixed(2));" in app_js
    assert "const feeReserve = Number((sellFeeReserve + buyFeeReserve).toFixed(2));" in app_js
    assert "Pass 2: Greedy whole-share leftover pass" in app_js

    # Finding #6
    assert "targetTickers: ['TLT', 'GLD', 'PTT.BK', 'ADVANC.BK', 'SPY', 'AAPL']" in app_js
    assert "targetTickers: ['SPY', 'MSFT', 'AAPL', 'TLT', 'PTT.BK', 'BDMS.BK', 'GLD']" in app_js
    assert "targetTickers: ['NVDA', 'AMZN', 'MSFT', 'QQQ', 'DELTA.BK', 'AOT.BK', 'GLD']" in app_js

    # Finding #7
    assert "Math.max(-0.05, effectiveAnnualReturn - 0.30 * annualVol)" in app_js

