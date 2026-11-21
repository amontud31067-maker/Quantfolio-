import os
import inspect
from unittest.mock import patch
import numpy as np
import pandas as pd
import pytest
import optimizer as opt


def test_adjusted_close_audit():
    """
    Topic 5: Verify that price fetching uses dividend- and split-adjusted close.
    Inspection of optimizer.py shows that yf.download is called with auto_adjust=True,
    which automatically adjusts the 'Close' column for dividends and stock splits.
    """
    source = inspect.getsource(opt.fetch_historical_prices)
    assert "auto_adjust=True" in source, "fetch_historical_prices must request auto_adjust=True from Yahoo Finance"
    assert "raw['Close']" in source or "'Close' in raw.columns" in source, \
        "When auto_adjust=True is used, yfinance places split/dividend-adjusted prices in the 'Close' column"


def test_daily_fx_vs_constant_fx_audit():
    """
    Topic 5: Verify daily historical FX conversion vs constant FX rate.
    optimizer.py converts historical prices using daily historical FX (THB=X) aligned to dates.
    If live fetch fails, it falls back to a constant default (fallback_fx_rate).
    Meanwhile, the frontend app.js uses a single spot FX rate for current discrete allocations.
    """
    dates = pd.date_range("2024-01-01", periods=5, freq="B")
    prices_usd = pd.DataFrame({"AAPL": [100.0, 102.0, 101.0, 103.0, 105.0]}, index=dates)
    daily_fx = pd.Series([34.0, 34.5, 35.0, 35.5, 36.0], index=dates)

    converted_daily = opt.convert_prices_to_base_currency(
        prices_usd, base_currency="THB", fx_series=daily_fx
    )

    # AAPL day 1: 100 * 34.0 = 3400.0
    # AAPL day 5: 105 * 36.0 = 3780.0
    assert converted_daily.loc[dates[0], "AAPL"] == 3400.0
    assert converted_daily.loc[dates[-1], "AAPL"] == 3780.0

    # Constant fallback check when network download fails
    with patch("yfinance.download", side_effect=Exception("Network error")):
        opt._price_cache.clear()
        converted_const = opt.convert_prices_to_base_currency(
            prices_usd, base_currency="THB", fx_series=None, fallback_fx_rate=35.0
        )
        assert converted_const.loc[dates[0], "AAPL"] == 3500.0
        assert converted_const.loc[dates[-1], "AAPL"] == 3675.0


def test_calendar_alignment_crypto_vs_equities():
    """
    Topic 5: Calendar alignment between 24/7 Crypto (BTC-USD) and Weekday Equities (SET / US).
    When 24/7 crypto dates are merged with weekday stocks and forward-filled:
    1. Equities have zero returns on weekend dates (Saturday & Sunday).
    2. Zero weekend returns dilute daily return variance for equities (104 zero days out of 365).
    """
    # 7 days including weekend (Sat, Sun)
    dates = pd.date_range("2024-01-01", periods=7, freq="D")
    # BTC traded all 7 days with price changes
    btc_prices = pd.Series([40000, 40500, 41000, 41200, 41500, 42000, 42500], index=dates)
    # AAPL only traded weekdays (first 5 days), weekend is forward-filled
    aapl_raw = pd.Series([180, 182, 181, 183, 185, np.nan, np.nan], index=dates)
    aapl_ffilled = aapl_raw.ffill()

    df = pd.DataFrame({"BTC-USD": btc_prices, "AAPL": aapl_ffilled})
    rets = df.pct_change().dropna()

    # Weekend returns for AAPL are exactly 0.0
    weekend_aapl_rets = rets.loc[dates[5]:dates[6], "AAPL"]
    assert (weekend_aapl_rets == 0.0).all(), "Forward-filled equity has artificial 0.0 return on weekends"
    # Weekend returns for BTC are non-zero
    weekend_btc_rets = rets.loc[dates[5]:dates[6], "BTC-USD"]
    assert (weekend_btc_rets != 0.0).all(), "Crypto continues trading on weekends"


def test_annualization_factor_inference():
    """
    Topic 5: Verify annualization factor:
    - Pure equities: 252 trading days.
    - Pure crypto or high-frequency calendar (>= 310 days/yr): 365 days.
    """
    # 1. Equities calendar: Business days (~252 days/yr)
    b_dates = pd.date_range("2023-01-01", "2023-12-31", freq="B")
    eq_df = pd.DataFrame({"AAPL": 100.0}, index=b_dates)
    freq_eq = opt._infer_effective_trading_days(eq_df)
    assert freq_eq == 252, f"Expected 252 for business-day equities, got {freq_eq}"

    # 2. Crypto calendar: All calendar days (365 days/yr)
    c_dates = pd.date_range("2023-01-01", "2023-12-31", freq="D")
    crypto_df = pd.DataFrame({"BTC-USD": 100.0}, index=c_dates)
    freq_crypto = opt._infer_effective_trading_days(crypto_df)
    assert freq_crypto == 365, f"Expected 365 for 365-day crypto, got {freq_crypto}"


def test_risk_free_rate_currency_matching():
    """
    Topic 5: Risk-free rate currency alignment:
    - THB portfolio: Thai Government Bond / BOT policy rate default (2.25%).
    - USD portfolio: US 13-week Treasury Bill (^IRX) yield.
    """
    rf_thb = opt.get_risk_free_rate(currency="THB")
    assert rf_thb == opt.THB_RISK_FREE_RATE_DEFAULT, \
        f"THB portfolio must use Thai risk-free rate, got {rf_thb}"
    assert rf_thb == 0.0225, f"Expected THB rate 2.25%, got {rf_thb}"

    # USD returns either live ^IRX or default 4.0%
    rf_usd = opt.get_risk_free_rate(currency="USD")
    assert 0.01 <= rf_usd <= 0.10, f"USD risk-free rate should be reasonable yield, got {rf_usd}"


def test_out_of_sample_backtest_audit():
    """
    Topic 5: Out-of-sample backtest audit:
    Audit of optimizer.py lines 1240-1325 and app.js line 2282 reveals:
    1. compute_walk_forward_backtest in optimizer.py computes weights at split_idx
       and uses them backwards for days 0 to split_idx - 1 (in-sample lookahead for warm-up period).
    2. app.js line 2282 renders pg.series (in-sample full-period fixed-weight simulation)
       on the frontend chart, while the walk_forward_series is unused in the primary display!
    """
    # Verify app.js uses pg.series for the chart
    with open("app.js", "r", encoding="utf-8") as f:
        app_js = f.read()

    assert "const sourceSeries = isDrawdownMode ? pg.drawdown_amount_series : pg.series;" in app_js, \
        "app.js plots pg.series (in-sample backtest) instead of walk_forward_series on the chart"
