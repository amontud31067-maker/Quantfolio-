"""
QuantFolio Pro - High Performance Portfolio Optimization Engine
Production-hardened with Thread-Safety & Multi-User TTL Caching
"""

import os
import time
import tempfile
import threading
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
import requests
import numpy as np
import pandas as pd

# Ensure matplotlib and yfinance caches have a writable directory inside cloud containers
os.environ.setdefault("MPLCONFIGDIR", os.path.join(tempfile.gettempdir(), "mpl_cache"))

import yfinance as yf
from typing import List, Dict, Any, Optional, Tuple

# Use PyPortfolioOpt + SciPy when installed locally/Docker, with built-in pure NumPy/Pandas fallback for Vercel Serverless (<250MB limit)
try:
    import scipy.cluster.hierarchy as sch
    if not hasattr(sch, '_LINKAGE_METHODS'):
        sch._LINKAGE_METHODS = {
            'single': 0, 'complete': 1, 'average': 2, 'centroid': 3,
            'median': 4, 'ward': 5, 'weighted': 6
        }
    from pypfopt import expected_returns, risk_models, EfficientFrontier, HRPOpt
    from pypfopt import DiscreteAllocation, get_latest_prices
except ImportError:
    def get_latest_prices(prices: pd.DataFrame) -> pd.Series:
        return prices.ffill().iloc[-1]

    class expected_returns:
        @staticmethod
        def mean_historical_return(prices: pd.DataFrame, frequency: int = 252) -> pd.Series:
            rets = prices.pct_change().dropna()
            if len(rets) == 0:
                return pd.Series(0.0, index=prices.columns)
            return (1.0 + rets).prod() ** (frequency / len(rets)) - 1.0

    class risk_models:
        class CovarianceShrinkage:
            def __init__(self, prices: pd.DataFrame, frequency: int = 252):
                self.rets = prices.pct_change().dropna()
                self.frequency = frequency

            def ledoit_wolf(self) -> pd.DataFrame:
                X = self.rets.values
                t, n = X.shape
                if t <= 1:
                    return pd.DataFrame(np.eye(n) * 0.04, index=self.rets.columns, columns=self.rets.columns)
                X_centered = X - X.mean(axis=0, keepdims=True)
                sample_cov = (X_centered.T @ X_centered) / (t - 1)
                mu_tr = np.trace(sample_cov) / n
                F = np.eye(n) * mu_tr
                delta = 0.15
                shrunk = (1.0 - delta) * sample_cov + delta * F
                return pd.DataFrame(shrunk * self.frequency, index=self.rets.columns, columns=self.rets.columns)

        @staticmethod
        def cov_to_corr(S: pd.DataFrame) -> pd.DataFrame:
            std = np.sqrt(np.diag(S.values))
            std_safe = np.where(std > 0, std, 1.0)
            corr = S.values / np.outer(std_safe, std_safe)
            np.fill_diagonal(corr, 1.0)
            return pd.DataFrame(np.clip(corr, -1.0, 1.0), index=S.index, columns=S.columns)

    def _project_capped_simplex(v: np.ndarray, low: float, high: float) -> np.ndarray:
        n = len(v)
        low = max(0.0, float(low))
        high = min(1.0, max(float(high), 1.0 / n + 1e-6))
        lo_lam = float(np.min(v) - high)
        hi_lam = float(np.max(v) - low)
        for _ in range(50):
            mid = 0.5 * (lo_lam + hi_lam)
            s = np.clip(v - mid, low, high).sum()
            if s > 1.0:
                lo_lam = mid
            else:
                hi_lam = mid
        w = np.clip(v - 0.5 * (lo_lam + hi_lam), low, high)
        w_sum = w.sum()
        return w / w_sum if w_sum > 0 else np.ones(n) / n

    class EfficientFrontier:
        def __init__(self, mu: pd.Series, S: pd.DataFrame, weight_bounds: Tuple[float, float] = (0.0, 1.0)):
            self.tickers = list(mu.index)
            self.mu = mu.values.astype(float)
            self.S = S.loc[self.tickers, self.tickers].values.astype(float)
            self.low, self.high = float(weight_bounds[0]), float(weight_bounds[1])
            self.w = np.ones(len(self.tickers)) / len(self.tickers)

        def min_volatility(self):
            n = len(self.tickers)
            w = _project_capped_simplex(np.ones(n) / n, self.low, self.high)
            step = 1.0 / (float(np.linalg.norm(self.S, ord=2)) + 1e-6)
            for _ in range(350):
                grad = 2.0 * (self.S @ w)
                w = _project_capped_simplex(w - step * grad, self.low, self.high)
            self.w = w
            return self.clean_weights()

        def max_sharpe(self, risk_free_rate: float = 0.04):
            n = len(self.tickers)
            rng = np.random.default_rng(42)
            W_cand = rng.dirichlet(np.ones(n), 2500)
            W_cand = np.array([_project_capped_simplex(row, self.low, self.high) for row in W_cand])
            rets = W_cand @ self.mu
            vols = np.sqrt(np.maximum(1e-12, np.einsum('ij,jk,ik->i', W_cand, self.S, W_cand)))
            srs = (rets - risk_free_rate) / vols
            w = W_cand[int(np.argmax(srs))].copy()
            for it in range(300):
                port_ret = float(w @ self.mu) - risk_free_rate
                port_var = max(1e-12, float(w @ self.S @ w))
                port_vol = np.sqrt(port_var)
                grad = (self.mu * port_vol - port_ret * (self.S @ w) / port_vol) / port_var
                lr = 0.15 / (1.0 + 0.02 * it)
                w_new = _project_capped_simplex(w + lr * grad, self.low, self.high)
                sr_old = port_ret / port_vol
                sr_new = (float(w_new @ self.mu) - risk_free_rate) / np.sqrt(max(1e-12, float(w_new @ self.S @ w_new)))
                if sr_new >= sr_old:
                    w = w_new
            self.w = w
            return self.clean_weights()

        def efficient_return(self, target_return: float):
            n = len(self.tickers)
            w = _project_capped_simplex(np.ones(n) / n, self.low, self.high)
            norm_s = float(np.linalg.norm(self.S, ord=2)) + 1e-6
            penalty = 25.0 * norm_s
            step = 1.0 / (norm_s + penalty * float(np.dot(self.mu, self.mu)) + 1e-6)
            for _ in range(350):
                diff = float(w @ self.mu) - target_return
                grad = 2.0 * (self.S @ w) + 2.0 * penalty * diff * self.mu
                w = _project_capped_simplex(w - step * grad, self.low, self.high)
            self.w = w
            return self.clean_weights()

        def clean_weights(self) -> Dict[str, float]:
            w_clean = np.where(self.w < 1e-4, 0.0, self.w)
            s = w_clean.sum()
            if s > 0:
                w_clean = w_clean / s
            return {self.tickers[i]: round(float(w_clean[i]), 5) for i in range(len(self.tickers))}

        def portfolio_performance(self, risk_free_rate: float = 0.04) -> Tuple[float, float, float]:
            ret = float(self.w @ self.mu)
            vol = float(np.sqrt(max(1e-12, self.w @ self.S @ self.w)))
            sr = (ret - risk_free_rate) / vol if vol > 0 else 0.0
            return ret, vol, sr

    class HRPOpt:
        def __init__(self, returns_df: pd.DataFrame):
            self.returns_df = returns_df

        def optimize(self) -> Dict[str, float]:
            tickers = list(self.returns_df.columns)
            n = len(tickers)
            cov = self.returns_df.cov().values * 252.0
            std = np.sqrt(np.maximum(1e-12, np.diag(cov)))
            corr = np.clip(cov / np.outer(std, std), -1.0, 1.0)
            dist = np.sqrt(np.maximum(0.0, 0.5 * (1.0 - corr)))
            visited = [int(np.argmin(dist.sum(axis=1)))]
            while len(visited) < n:
                last = visited[-1]
                best_j, best_d = -1, 1e9
                for j in range(n):
                    if j not in visited and dist[last, j] < best_d:
                        best_d = dist[last, j]
                        best_j = j
                visited.append(best_j)
            w = np.ones(n)
            clusters = [visited]
            while clusters:
                next_clusters = []
                for c in clusters:
                    if len(c) <= 1:
                        continue
                    mid = len(c) // 2
                    c1, c2 = c[:mid], c[mid:]
                    v1 = self._cluster_var(cov, c1)
                    v2 = self._cluster_var(cov, c2)
                    alpha = 1.0 - v1 / (v1 + v2) if (v1 + v2) > 0 else 0.5
                    for idx in c1:
                        w[idx] *= alpha
                    for idx in c2:
                        w[idx] *= (1.0 - alpha)
                    if len(c1) > 1:
                        next_clusters.append(c1)
                    if len(c2) > 1:
                        next_clusters.append(c2)
                clusters = next_clusters
            w = w / w.sum() if w.sum() > 0 else np.ones(n) / n
            return {tickers[i]: round(float(w[i]), 5) for i in range(n)}

        @staticmethod
        def _cluster_var(cov: np.ndarray, idxs: List[int]) -> float:
            sub_cov = cov[np.ix_(idxs, idxs)]
            ivp = 1.0 / np.maximum(1e-12, np.diag(sub_cov))
            ivp /= ivp.sum()
            return float(ivp @ sub_cov @ ivp)

    class DiscreteAllocation:
        def __init__(self, weights: Dict[str, float], latest_prices: pd.Series, total_portfolio_value: float = 100000.0):
            self.weights = weights
            self.prices = latest_prices
            self.total_val = float(total_portfolio_value)

        def greedy_portfolio(self) -> Tuple[Dict[str, int], float]:
            shares: Dict[str, int] = {}
            available = self.total_val
            for t, w in self.weights.items():
                p = float(self.prices[t])
                if p > 0 and w > 0:
                    n = int((w * self.total_val) // p)
                    if n > 0:
                        shares[t] = n
                        available -= n * p
            while True:
                affordable = [t for t in self.weights if 0 < float(self.prices[t]) <= available]
                if not affordable:
                    break
                spent = self.total_val - available
                best_t = max(
                    affordable,
                    key=lambda t: self.weights[t] - (shares.get(t, 0) * float(self.prices[t]) / max(1.0, spent))
                )
                shares[best_t] = shares.get(best_t, 0) + 1
                available -= float(self.prices[best_t])
            return shares, round(available, 2)

# Set dedicated cache directory for yfinance in temp dir to prevent SQLite locking & permission issues
CACHE_DIR = os.path.join(tempfile.gettempdir(), 'quantfolio_yf_cache')
try:
    os.makedirs(CACHE_DIR, exist_ok=True)
    yf.set_tz_cache_location(CACHE_DIR)
except Exception:
    pass

TRADING_DAYS = 252

# Thread lock & in-memory TTL caches for multi-user concurrency
_yf_lock = threading.Lock()
_price_cache: Dict[Tuple, Tuple[float, pd.DataFrame, List[str], List[str]]] = {}
_rf_cache: Dict[str, Tuple[float, float]] = {}
_fx_cache: Dict[str, Tuple[float, float]] = {}
_news_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}

PRICE_CACHE_TTL = 900   # 15 minutes
RF_CACHE_TTL = 3600     # 1 hour
FX_CACHE_TTL = 1800     # 30 minutes
NEWS_CACHE_TTL = 600    # 10 minutes

# Well-known asset display names for institutional look
KNOWN_NAMES = {
    'NVDA': 'NVIDIA Corp.',
    'AAPL': 'Apple Inc.',
    'MSFT': 'Microsoft Corp.',
    'AMZN': 'Amazon.com Inc.',
    'TSLA': 'Tesla Inc.',
    'GOOGL': 'Alphabet Inc.',
    'GOOG': 'Alphabet Inc.',
    'META': 'Meta Platforms Inc.',
    'BRK-B': 'Berkshire Hathaway',
    'JPM': 'JPMorgan Chase & Co.',
    'V': 'Visa Inc.',
    'JNJ': 'Johnson & Johnson',
    'WMT': 'Walmart Inc.',
    'PG': 'Procter & Gamble',
    'MA': 'Mastercard Inc.',
    'KO': 'Coca-Cola Co.',
    'PEP': 'PepsiCo Inc.',
    'COST': 'Costco Wholesale',
    'AVGO': 'Broadcom Inc.',
    'AMD': 'Advanced Micro Devices',
    'NFLX': 'Netflix Inc.',
    'DIS': 'Walt Disney Co.',
    'SPY': 'SPDR S&P 500 ETF',
    'QQQ': 'Invesco QQQ Trust',
    'VOO': 'Vanguard S&P 500 ETF',
    'VTI': 'Vanguard Total Stock ETF',
    'GLD': 'SPDR Gold Shares ETF',
    'SLV': 'iShares Silver Trust',
    'TLT': 'iShares 20+ Yr Treasury ETF',
    'BND': 'Vanguard Total Bond ETF',
    'VNQ': 'Vanguard Real Estate ETF',
    'DBC': 'Invesco DB Commodity ETF',
    'BTC-USD': 'Bitcoin (USD)',
    'ETH-USD': 'Ethereum (USD)',
    'SOL-USD': 'Solana (USD)',
    'BNB-USD': 'BNB (USD)',
    'PTT.BK': 'บมจ. ปตท. (PTT)',
    'AOT.BK': 'บมจ. ท่าอากาศยานไทย (AOT)',
    'CPALL.BK': 'บมจ. ซีพี ออลล์ (CPALL)',
    'DELTA.BK': 'บมจ. เดลต้า อีเลคโทรนิคส์ (DELTA)',
    'BDMS.BK': 'บมจ. กรุงเทพดุสิตเวชการ (BDMS)',
    'ADVANC.BK': 'บมจ. แอดวานซ์ อินโฟร์ เซอร์วิส (AIS)',
    'SCB.BK': 'บมจ. เอสซีบี เอกซ์ (SCBX)',
    'KBANK.BK': 'บมจ. ธนาคารกสิกรไทย (KBANK)',
    'BBL.BK': 'บมจ. ธนาคารกรุงเทพ (BBL)',
    'PTTEP.BK': 'บมจ. ปตท.สผ. (PTTEP)',
    'SCC.BK': 'บมจ. ปูนซิเมนต์ไทย (SCG)',
    'GULF.BK': 'บมจ. กัลฟ์ เอ็นเนอร์จี (GULF)',
    'CPN.BK': 'บมจ. เซ็นทรัลพัฒนา (CPN)',
    'BH.BK': 'บมจ. โรงพยาบาลบำรุงราษฎร์ (BH)',
    'MINT.BK': 'บมจ. ไมเนอร์ อินเตอร์เนชั่นแนล (MINT)'
}


def get_asset_name(ticker: str) -> str:
    return KNOWN_NAMES.get(ticker.upper(), ticker.upper())


def get_ticker_currency(ticker: str) -> str:
    """Identify native trading currency of ticker (.BK -> THB, others -> USD)."""
    return "THB" if ticker.strip().upper().endswith(".BK") else "USD"


def get_usd_thb_rate(default_rate: float = 34.50) -> float:
    """Fetch current USD/THB exchange rate (THB=X) from Yahoo Finance with 30-minute cache."""
    now = time.time()
    if 'usd_thb' in _fx_cache:
        ts, cached_val = _fx_cache['usd_thb']
        if now - ts < FX_CACHE_TTL:
            return cached_val

    try:
        with _yf_lock:
            fx_df = yf.download('THB=X', period='5d', auto_adjust=True, progress=False)['Close']
        if not fx_df.empty:
            clean = fx_df.dropna()
            if not clean.empty:
                val = clean.iloc[-1]
                latest = float(val.values[0]) if hasattr(val, 'values') else float(val)
                if 20.0 <= latest <= 60.0:
                    rate = round(latest, 2)
                    _fx_cache['usd_thb'] = (now, rate)
                    return rate
    except Exception as e:
        print(f"Notice: Failed to fetch THB=X ({e}), using default {default_rate:.2f}")

    _fx_cache['usd_thb'] = (now, default_rate)
    return default_rate


def get_risk_free_rate(default_rate: float = 0.04) -> float:
    """Fetch current 13-week US Treasury Bill yield (^IRX) with 1-hour cache."""
    now = time.time()
    if 'rf' in _rf_cache:
        ts, cached_val = _rf_cache['rf']
        if now - ts < RF_CACHE_TTL:
            return cached_val

    try:
        with _yf_lock:
            irx = yf.download('^IRX', period='1mo', auto_adjust=True, progress=False)['Close']
        if not irx.empty:
            clean = irx.dropna()
            if not clean.empty:
                val = clean.iloc[-1]
                latest = float(val.values[0]) if hasattr(val, 'values') else float(val)
                rate = round(latest / 100.0, 4)
                _rf_cache['rf'] = (now, rate)
                return rate
    except Exception as e:
        print(f"Notice: Failed to fetch ^IRX ({e}), using default {default_rate:.2%}")

    _rf_cache['rf'] = (now, default_rate)
    return default_rate


def fetch_historical_prices(
    tickers: List[str],
    start_date: str,
    end_date: str
) -> Tuple[pd.DataFrame, List[str], List[str]]:
    """
    Download adjusted close prices for tickers between start_date and end_date.
    Thread-safe and cached for multi-user performance.
    """
    clean_tickers = []
    for t in tickers:
        s = t.strip().upper()
        if s and s not in clean_tickers:
            clean_tickers.append(s)

    if not clean_tickers:
        raise ValueError("กรุณาเลือกสินทรัพย์อย่างน้อย 2 รายการ")

    cache_key = (tuple(clean_tickers), start_date, end_date)
    now = time.time()
    if cache_key in _price_cache:
        ts, cached_df, cached_valid, cached_missing = _price_cache[cache_key]
        if now - ts < PRICE_CACHE_TTL:
            return cached_df.copy(), list(cached_valid), list(cached_missing)

    try:
        with _yf_lock:
            raw = yf.download(
                clean_tickers,
                start=start_date,
                end=end_date,
                auto_adjust=True,
                progress=False
            )
    except Exception as e:
        raise ValueError(f"ไม่สามารถดึงข้อมูลจาก Yahoo Finance ได้: {str(e)}")

    if raw.empty:
        raise ValueError(f"ไม่พบข้อมูลราคาของ {clean_tickers} ในช่วงเวลา {start_date} ถึง {end_date}")

    if 'Close' in raw.columns:
        close_df = raw['Close']
    else:
        close_df = raw

    if isinstance(close_df, pd.Series):
        close_df = close_df.to_frame(name=clean_tickers[0])

    valid_tickers = []
    missing_tickers = []

    for t in clean_tickers:
        if t in close_df.columns and not close_df[t].dropna().empty:
            valid_tickers.append(t)
        else:
            missing_tickers.append(t)

    if len(valid_tickers) < 2:
        raise ValueError(
            f"ต้องมีสินทรัพย์ที่มีข้อมูลราคาสมบูรณ์อย่างน้อย 2 รายการขึ้นไป "
            f"(พบข้อมูล: {valid_tickers}, ไม่พบข้อมูล: {missing_tickers})"
        )

    prices = close_df[valid_tickers].dropna()

    if len(prices) < 20:
        raise ValueError(f"จำนวนวันทำการที่ข้อมูลทับซ้อนกันน้อยเกินไป ({len(prices)} วัน) กรุณาขยายช่วงเวลาให้กว้างขึ้น")

    # Save to cache (limit cache size to 100 entries)
    if len(_price_cache) > 100:
        _price_cache.clear()
    _price_cache[cache_key] = (now, prices.copy(), list(valid_tickers), list(missing_tickers))

    return prices, valid_tickers, missing_tickers


def compute_max_drawdown(wealth_series: pd.Series) -> float:
    """Compute maximum percentage drawdown from peak."""
    running_max = wealth_series.cummax()
    drawdown = (wealth_series - running_max) / running_max
    return float(drawdown.min())


def compute_drawdown_details(cum_growth: pd.Series, budget: float) -> Dict[str, Any]:
    """
    Compute comprehensive drawdown analytics both as percentage and as exact
    monetary amount (Baht) based on user's initial capital (`budget`), plus
    historical peak-to-trough dates and recovery duration.
    """
    if cum_growth.empty:
        return {
            "max_drawdown_pct": 0.0,
            "max_drawdown_amount": 0.0,
            "min_capital_remaining": round(budget, 2),
            "peak_to_trough_amount": 0.0,
            "peak_value": round(budget, 2),
            "trough_value": round(budget, 2),
            "peak_date": "-",
            "trough_date": "-",
            "recovery_date": None,
            "recovery_days": None
        }

    # Include starting point = 1.0 so drawdowns from initial capital on day 1 are captured accurately
    running_max = cum_growth.cummax().clip(lower=1.0)
    dd_series = (cum_growth - running_max) / running_max
    mdd_pct = float(dd_series.min())

    # 1. Exact monetary amount lost relative to user's initial budget
    max_loss_amount = round(abs(mdd_pct) * budget, 2)
    min_remaining = round(max(0.0, budget - max_loss_amount), 2)

    # 2. Historical Peak, Trough, and Recovery Dates
    trough_idx = dd_series.idxmin()
    peak_slice = cum_growth.loc[:trough_idx]
    peak_idx = peak_slice.idxmax() if not peak_slice.empty else trough_idx

    peak_level = max(1.0, float(cum_growth.loc[peak_idx]))
    trough_level = float(cum_growth.loc[trough_idx])

    peak_wealth = round(peak_level * budget, 2)
    trough_wealth = round(trough_level * budget, 2)
    peak_to_trough_loss = round(max(0.0, peak_wealth - trough_wealth), 2)

    after_trough = cum_growth.loc[trough_idx:]
    recovered = after_trough[after_trough >= peak_level]
    if not recovered.empty and len(recovered) > 1:
        rec_idx = recovered.index[0]
        recovery_date = rec_idx.strftime('%Y-%m-%d')
        recovery_days = int((rec_idx - peak_idx).days)
    else:
        recovery_date = None
        recovery_days = None

    return {
        "max_drawdown_pct": round(mdd_pct, 4),
        "max_drawdown_amount": max_loss_amount,
        "min_capital_remaining": min_remaining,
        "peak_to_trough_amount": peak_to_trough_loss,
        "peak_value": peak_wealth,
        "trough_value": trough_wealth,
        "peak_date": peak_idx.strftime('%Y-%m-%d') if hasattr(peak_idx, 'strftime') else str(peak_idx),
        "trough_date": trough_idx.strftime('%Y-%m-%d') if hasattr(trough_idx, 'strftime') else str(trough_idx),
        "recovery_date": recovery_date,
        "recovery_days": recovery_days
    }


def compute_discrete_allocation(
    weights: Dict[str, float],
    latest_prices: pd.Series,
    budget: float,
    budget_currency: str = "THB",
    usd_thb_rate: float = 34.50
) -> Dict[str, Any]:
    """
    Calculate integer share quantities, fractional shares, and leftover cash.
    Automatically converts asset prices to the user's budget currency (default THB)
    so Baht amounts and share quantities are 100% consistent and accurate.
    """
    try:
        active_weights = {k: v for k, v in weights.items() if v > 0.0001}
        if not active_weights:
            return {"shares": {}, "leftover": budget, "cash_spent": 0, "allocated_percent": 0, "allocations": []}

        # Convert prices into budget_currency for accurate share count calculation
        converted_prices_dict = {}
        for ticker in active_weights.keys():
            raw_p = float(latest_prices[ticker])
            native_curr = get_ticker_currency(ticker)
            if budget_currency.upper() == "THB" and native_curr == "USD":
                converted_prices_dict[ticker] = round(raw_p * usd_thb_rate, 4)
            elif budget_currency.upper() == "USD" and native_curr == "THB":
                converted_prices_dict[ticker] = round(raw_p / usd_thb_rate, 4) if usd_thb_rate > 0 else raw_p
            else:
                converted_prices_dict[ticker] = raw_p

        sub_prices = pd.Series(converted_prices_dict)
        da = DiscreteAllocation(active_weights, sub_prices, total_portfolio_value=budget)
        shares, leftover = da.greedy_portfolio()

        allocations = []
        total_spent = 0.0
        sorted_keys = sorted(active_weights.keys(), key=lambda x: active_weights[x], reverse=True)

        for ticker in sorted_keys:
            n_shares = int(shares.get(ticker, 0))
            price_in_budget_curr = float(sub_prices[ticker])
            raw_native_price = float(latest_prices[ticker])
            native_curr = get_ticker_currency(ticker)
            price_thb = round(raw_native_price * usd_thb_rate, 2) if native_curr == "USD" else round(raw_native_price, 2)
            price_usd = round(raw_native_price, 2) if native_curr == "USD" else (round(raw_native_price / usd_thb_rate, 2) if usd_thb_rate > 0 else round(raw_native_price, 2))

            target_amount = budget * float(active_weights[ticker])
            fractional = round(target_amount / price_in_budget_curr, 4) if price_in_budget_curr > 0 else 0.0
            val = n_shares * price_in_budget_curr
            total_spent += val
            allocations.append({
                "ticker": ticker,
                "name": get_asset_name(ticker),
                "native_currency": native_curr,
                "native_price": round(raw_native_price, 2),
                "price_thb": price_thb,
                "price_usd": price_usd,
                "current_price": round(price_in_budget_curr, 2),
                "target_weight": round(float(active_weights[ticker]), 4),
                "target_value": round(target_amount, 2),
                "shares": n_shares,
                "fractional_shares": fractional,
                "allocated_value": round(val, 2),
                "actual_weight": round(val / budget, 4) if budget > 0 else 0
            })

        return {
            "shares": {k: int(v) for k, v in shares.items()},
            "leftover": round(float(leftover), 2),
            "cash_spent": round(total_spent, 2),
            "allocated_percent": round((total_spent / budget) * 100, 2) if budget > 0 else 0,
            "allocations": allocations
        }
    except Exception as e:
        print(f"Error in discrete allocation: {e}")
        return {"shares": {}, "leftover": budget, "cash_spent": 0, "allocated_percent": 0, "allocations": []}


POSITIVE_NEWS_KEYWORDS = [
    "beat", "beats", "surge", "surges", "soar", "soars", "record", "upgrade", "upgraded",
    "bullish", "outperform", "growth", "profit", "gain", "gains", "rally", "rallies",
    "buy", "strong", "optimism", "breakthrough", "partnership", "dividend", "buyback",
    "demand", "accumulate", "upside", "positive", "jump", "jumps", "high", "boom",
    "กำไรพุ่ง", "นิวไฮ", "เติบโต", "โดดเด่น", "ปันผล", "แนะซื้อ", "บวก", "ขาขึ้น", "ทะยาน",
    "แข็งแกร่ง", "หนุน", "ฟื้นตัว", "สดใส", "เป้าใหม่", "สูงสุด"
]

NEGATIVE_NEWS_KEYWORDS = [
    "miss", "misses", "plunge", "plunges", "drop", "drops", "fall", "falls", "downgrade",
    "downgraded", "bearish", "underperform", "loss", "decline", "declines", "lawsuit",
    "probe", "investigation", "recall", "delay", "warning", "cut", "cuts", "tariff",
    "layoff", "layoffs", "weak", "risk", "sell", "slump", "crash", "concern", "headwind",
    "ขาดทุน", "ร่วง", "ดิ่ง", "ลดเป้า", "กังวล", "กดดัน", "ชะลอตัว", "เสี่ยง", "หั่นเป้า", "ลบ", "ขาลง", "ผันผวน"
]


def analyze_headline_sentiment(title: str) -> Tuple[str, float, str]:
    """
    Analyze financial news headline sentiment (English & Thai).
    Returns (sentiment_type, score_in_[-1,1], thai_label).
    """
    lower_t = (title or "").lower()
    pos_hits = sum(1 for kw in POSITIVE_NEWS_KEYWORDS if kw in lower_t)
    neg_hits = sum(1 for kw in NEGATIVE_NEWS_KEYWORDS if kw in lower_t)

    if pos_hits > neg_hits:
        score = min(1.0, 0.45 + 0.25 * (pos_hits - neg_hits))
        return "positive", round(score, 2), "ข่าวหนุนเชิงบวก"
    elif neg_hits > pos_hits:
        score = -min(1.0, 0.45 + 0.25 * (neg_hits - pos_hits))
        return "negative", round(score, 2), "ข่าวกดดัน/ควรระวัง"
    return "neutral", 0.0, "ข่าวติดตามสภาวะตลาด"


def fetch_market_news_for_ticker(ticker: str, max_items: int = 4) -> Dict[str, Any]:
    """
    Fetch live market news for a ticker from Yahoo Finance Search API and Google News RSS.
    Thread-safe and cached for 10 minutes.
    """
    clean_t = ticker.strip().upper()
    now = time.time()
    if clean_t in _news_cache:
        ts, cached_val = _news_cache[clean_t]
        if now - ts < NEWS_CACHE_TTL:
            return cached_val

    articles: List[Dict[str, Any]] = []
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    }

    # 1. Try Yahoo Finance Search News first for non-.BK tickers
    if not clean_t.endswith(".BK"):
        try:
            yf_url = f"https://query2.finance.yahoo.com/v1/finance/search?q={requests.utils.quote(clean_t)}&quotesCount=1&newsCount=6"
            res = requests.get(yf_url, headers=headers, timeout=3.5)
            if res.status_code == 200:
                raw_news = res.json().get("news", [])
                for item in raw_news:
                    title = (item.get("title") or "").strip()
                    if not title:
                        continue
                    pub_ts = item.get("providerPublishTime")
                    pub_str = (
                        datetime.fromtimestamp(pub_ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
                        if pub_ts else "ล่าสุด"
                    )
                    sent_type, sent_score, sent_label = analyze_headline_sentiment(title)
                    articles.append({
                        "ticker": clean_t,
                        "title": title,
                        "publisher": item.get("publisher") or "Yahoo Finance",
                        "link": item.get("link") or f"https://finance.yahoo.com/quote/{clean_t}",
                        "published_at": pub_str,
                        "sentiment": sent_type,
                        "sentiment_score": sent_score,
                        "sentiment_label_th": sent_label
                    })
                    if len(articles) >= max_items:
                        break
        except Exception:
            pass

    # 2. Fallback / Supplement via Google News Financial RSS (supports both Thai .BK and Global stocks)
    if len(articles) < 2:
        try:
            is_thai = clean_t.endswith(".BK")
            base_sym = clean_t.replace(".BK", "")
            query_str = f"{base_sym} หุ้น" if is_thai else f"{clean_t} stock market"
            hl_param = "th&gl=TH&ceid=TH:th" if is_thai else "en-US&gl=US&ceid=US:en"
            rss_url = f"https://news.google.com/rss/search?q={requests.utils.quote(query_str)}&hl={hl_param}"
            res = requests.get(rss_url, headers=headers, timeout=3.5)
            if res.status_code == 200:
                root = ET.fromstring(res.content)
                for item in root.findall(".//item"):
                    raw_title = (item.findtext("title") or "").strip()
                    if not raw_title:
                        continue
                    source_el = item.find("source")
                    publisher = source_el.text.strip() if (source_el is not None and source_el.text) else "Google Finance News"
                    if " - " in raw_title and raw_title.endswith(publisher):
                        raw_title = raw_title[: -len(publisher) - 3].strip()
                    link = (item.findtext("link") or f"https://finance.yahoo.com/quote/{clean_t}").strip()
                    pub_date = (item.findtext("pubDate") or "")[:16].strip() or "ล่าสุด"
                    sent_type, sent_score, sent_label = analyze_headline_sentiment(raw_title)
                    articles.append({
                        "ticker": clean_t,
                        "title": raw_title,
                        "publisher": publisher,
                        "link": link,
                        "published_at": pub_date,
                        "sentiment": sent_type,
                        "sentiment_score": sent_score,
                        "sentiment_label_th": sent_label
                    })
                    if len(articles) >= max_items:
                        break
        except Exception:
            pass

    pos_cnt = sum(1 for a in articles if a["sentiment"] == "positive")
    neg_cnt = sum(1 for a in articles if a["sentiment"] == "negative")
    neu_cnt = sum(1 for a in articles if a["sentiment"] == "neutral")

    if articles:
        avg_score = sum(float(a["sentiment_score"]) for a in articles) / len(articles)
    else:
        avg_score = 0.0

    result = {
        "ticker": clean_t,
        "name": get_asset_name(clean_t),
        "news_sentiment_score": round(float(np.clip(avg_score, -1.0, 1.0)), 3),
        "positive_count": pos_cnt,
        "negative_count": neg_cnt,
        "neutral_count": neu_cnt,
        "articles": articles[:max_items]
    }
    if len(_news_cache) > 200:
        _news_cache.clear()
    _news_cache[clean_t] = (now, result)
    return result


def fetch_portfolio_market_news(tickers: List[str]) -> Dict[str, Dict[str, Any]]:
    """Fetch market news concurrently for all tickers in portfolio."""
    from concurrent.futures import ThreadPoolExecutor
    results: Dict[str, Dict[str, Any]] = {}
    clean_list = [t.strip().upper() for t in tickers if t.strip()]
    if not clean_list:
        return results

    with ThreadPoolExecutor(max_workers=min(6, len(clean_list))) as executor:
        future_map = {executor.submit(fetch_market_news_for_ticker, t): t for t in clean_list}
        for fut, t in future_map.items():
            try:
                results[t] = fut.result(timeout=4.5)
            except Exception:
                results[t] = {
                    "ticker": t,
                    "name": get_asset_name(t),
                    "news_sentiment_score": 0.0,
                    "positive_count": 0,
                    "negative_count": 0,
                    "neutral_count": 0,
                    "articles": []
                }
    return results


def compute_technical_signals(price_series: pd.Series) -> Dict[str, Any]:
    """
    Compute credible technical indicators from historical close prices:
    - 14-day RSI
    - 50-day & 200-day Simple Moving Averages (SMA)
    - 1-Month (21d) & 3-Month (63d) price momentum
    """
    s = price_series.dropna()
    if len(s) < 15:
        return {
            "rsi_14": 50.0,
            "sma_50": float(s.iloc[-1]) if len(s) else 0.0,
            "sma_200": float(s.iloc[-1]) if len(s) else 0.0,
            "price_vs_sma50_pct": 0.0,
            "price_vs_sma200_pct": 0.0,
            "momentum_1m": 0.0,
            "momentum_3m": 0.0,
            "trend_status": "CONSOLIDATION",
            "trend_label_th": "แกว่งตัวสะสมกำลัง",
            "rsi_status_th": "ระดับสมดุลปกติ",
            "technical_score": 0.0
        }

    latest = float(s.iloc[-1])
    delta = s.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.rolling(window=14, min_periods=14).mean().iloc[-1]
    avg_loss = loss.rolling(window=14, min_periods=14).mean().iloc[-1]
    if avg_loss == 0:
        rsi_14 = 75.0 if avg_gain > 0 else 50.0
    else:
        rs = float(avg_gain / avg_loss)
        rsi_14 = 100.0 - (100.0 / (1.0 + rs))

    w50 = min(50, len(s))
    w200 = min(200, len(s))
    sma_50 = float(s.iloc[-w50:].mean())
    sma_200 = float(s.iloc[-w200:].mean())
    vs_50 = (latest / sma_50 - 1.0) if sma_50 > 0 else 0.0
    vs_200 = (latest / sma_200 - 1.0) if sma_200 > 0 else 0.0

    idx_1m = max(0, len(s) - 22)
    idx_3m = max(0, len(s) - 64)
    mom_1m = (latest / float(s.iloc[idx_1m]) - 1.0) if float(s.iloc[idx_1m]) > 0 else 0.0
    mom_3m = (latest / float(s.iloc[idx_3m]) - 1.0) if float(s.iloc[idx_3m]) > 0 else 0.0

    # Trend classification
    if latest >= sma_50 and sma_50 >= sma_200:
        trend_status = "UPTREND"
        trend_label_th = "ขาขึ้นแข็งแกร่ง (ราคาเหนือค่าเฉลี่ย 50 และ 200 วัน)"
        trend_score = 0.55
    elif latest >= sma_50 and sma_50 < sma_200:
        trend_status = "RECOVERY"
        trend_label_th = "ฟื้นตัวระยะสั้น (กลับมายืนเหนือเส้น 50 วัน)"
        trend_score = 0.25
    elif latest < sma_50 and latest >= sma_200:
        trend_status = "CONSOLIDATION"
        trend_label_th = "ย่อตัวพักฐานบนแนวโน้มหลัก"
        trend_score = 0.05
    else:
        trend_status = "DOWNTREND"
        trend_label_th = "ชะลอตัว (ราคาต่ำกว่าค่าเฉลี่ย 50 และ 200 วัน)"
        trend_score = -0.45

    # RSI interpretation for prudent entry
    if rsi_14 >= 72.0:
        rsi_status_th = f"RSI {rsi_14:.0f} (ซื้อมากเกินไป ระวังการไล่ราคา)"
        rsi_adj = -0.20
    elif rsi_14 <= 32.0:
        rsi_status_th = f"RSI {rsi_14:.0f} (ขายมากเกินไป โซนราคาอ่อนตัวสะสม)"
        rsi_adj = 0.20
    else:
        rsi_status_th = f"RSI {rsi_14:.0f} (ระดับสมดุลปกติ)"
        rsi_adj = 0.10 if 45.0 <= rsi_14 <= 65.0 else 0.0

    tech_score = float(np.clip(trend_score + rsi_adj, -1.0, 1.0))

    return {
        "rsi_14": round(float(rsi_14), 1),
        "sma_50": round(sma_50, 2),
        "sma_200": round(sma_200, 2),
        "price_vs_sma50_pct": round(float(vs_50), 4),
        "price_vs_sma200_pct": round(float(vs_200), 4),
        "momentum_1m": round(float(mom_1m), 4),
        "momentum_3m": round(float(mom_3m), 4),
        "trend_status": trend_status,
        "trend_label_th": trend_label_th,
        "rsi_status_th": rsi_status_th,
        "technical_score": round(tech_score, 3)
    }


def build_asset_decision_intelligence(
    ticker: str,
    raw_expected_return: float,
    volatility: float,
    tech_info: Dict[str, Any],
    news_info: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Combine historical stats, live market news sentiment, and technical trend/RSI
    into a prudent, actionable buy/hold/reduce decision recommendation and Black-Litterman return tilt.
    """
    news_score = float(news_info.get("news_sentiment_score", 0.0))
    tech_score = float(tech_info.get("technical_score", 0.0))
    rsi = float(tech_info.get("rsi_14", 50.0))
    trend = tech_info.get("trend_status", "CONSOLIDATION")

    # Composite confidence score in [-1, +1]
    composite = round(float(np.clip(0.55 * news_score + 0.45 * tech_score, -1.0, 1.0)), 3)

    # Prudent Bayesian / Black-Litterman expected return adjustment (capped at +/- 4.5% annual)
    max_tilt = min(0.045, max(0.015, 0.12 * volatility))
    return_tilt = round(float(composite * max_tilt), 4)
    adjusted_return = round(float(raw_expected_return + return_tilt), 4)

    if composite >= 0.20 and rsi < 72.0:
        signal_level = "POSITIVE_BUY"
        signal_badge_th = "สัญญาณบวกหนุนซื้อ"
        execution_tactic_th = "ทยอยซื้อเข้าพอร์ตได้ตามสัดส่วนเป้าหมาย"
        decision_reason_th = f"{tech_info['trend_label_th']} ประกอบกับกระแสข่าวตลาดอยู่ในเกณฑ์บวก ({tech_info['rsi_status_th']})"
    elif rsi >= 72.0:
        signal_level = "OVERBOUGHT_TRANCHE"
        signal_badge_th = "ราคาตึงตัว (แบ่งไม้ซื้อ)"
        execution_tactic_th = "แนะนำแบ่งเงินซื้อเป็น 2-3 ไม้ ไม่ไล่ราคาครั้งเดียว"
        decision_reason_th = f"แนวโน้มระยะยาวยังดี แต่ระยะสั้น {tech_info['rsi_status_th']} จึงควรแบ่งไม้เข้าซื้อเพื่อลดต้นทุนเฉลี่ย"
    elif composite <= -0.18 or trend == "DOWNTREND":
        signal_level = "CAUTIOUS_SHIELD"
        signal_badge_th = "ชะลอตัว/ลดเพดานเสี่ยง"
        execution_tactic_th = "ลดน้ำหนักลงบางส่วน หรือรอจังหวะราคาสร้างฐาน"
        decision_reason_th = f"{tech_info['trend_label_th']} และมีปัจจัยข่าวระยะสั้นที่ต้องเฝ้าระวัง ระบบจึงปรับลดน้ำหนักลงอย่างรอบคอบ"
    else:
        signal_level = "NEUTRAL_ACCUMULATE"
        signal_badge_th = "สมดุล/สะสมตามแผน"
        execution_tactic_th = "จัดสรรตามสัดส่วนมาตรฐานของกลยุทธ์"
        decision_reason_th = f"{tech_info['trend_label_th']} และ {tech_info['rsi_status_th']} เหมาะสำหรับการถือครองตามแผนระยะยาว"

    return {
        "ticker": ticker,
        "news_sentiment_score": news_score,
        "technical_score": tech_score,
        "composite_signal_score": composite,
        "raw_expected_return": round(raw_expected_return, 4),
        "return_tilt": return_tilt,
        "adjusted_expected_return": adjusted_return,
        "signal_level": signal_level,
        "signal_badge_th": signal_badge_th,
        "execution_tactic_th": execution_tactic_th,
        "decision_reason_th": decision_reason_th
    }


def _solve_all_strategies(
    mu_vec: pd.Series,
    S_mat: pd.DataFrame,
    returns_df: pd.DataFrame,
    valid_tickers: List[str],
    weight_bounds: Tuple[float, float],
    rf_rate: float,
    signal_scores: Optional[Dict[str, float]] = None
) -> Dict[str, Dict[str, Any]]:
    """Solve Max Sharpe, Min Volatility, HRP, and Equal Weight for a given expected return vector."""
    # 1. Min Volatility
    ef_min = EfficientFrontier(mu_vec, S_mat, weight_bounds=weight_bounds)
    ef_min.min_volatility()
    w_min = ef_min.clean_weights()
    if signal_scores:
        # Apply gentle risk-shield tilt on Min Volatility when news/trend signals are negative
        adj_min = {}
        for t in valid_tickers:
             tilt_factor = 1.0 + 0.15 * float(signal_scores.get(t, 0.0))
             adj_min[t] = max(weight_bounds[0], float(w_min.get(t, 0.0)) * max(0.75, min(1.25, tilt_factor)))
        s_min = sum(adj_min.values())
        if s_min > 0:
            w_min = {t: round(adj_min[t] / s_min, 5) for t in valid_tickers}
    w_min_s = pd.Series(w_min).reindex(valid_tickers).fillna(0.0)
    ret_min = float(w_min_s @ mu_vec)
    vol_min = float(np.sqrt(max(1e-12, w_min_s @ S_mat @ w_min_s)))
    sr_min = (ret_min - rf_rate) / vol_min if vol_min > 0 else 0.0

    # 2. Max Sharpe
    max_sharpe_error = None
    try:
        ef_max = EfficientFrontier(mu_vec, S_mat, weight_bounds=weight_bounds)
        ef_max.max_sharpe(risk_free_rate=rf_rate)
        w_max = ef_max.clean_weights()
        ret_max, vol_max, sr_max = ef_max.portfolio_performance(risk_free_rate=rf_rate)
    except Exception as e:
        max_sharpe_error = str(e)
        w_max = dict(w_min)
        ret_max, vol_max, sr_max = ret_min, vol_min, sr_min

    # 3. Equal Weight (1/N)
    w_eq = {t: 1.0 / len(valid_tickers) for t in valid_tickers}
    w_eq_s = pd.Series(w_eq)
    ret_eq = float(w_eq_s @ mu_vec)
    vol_eq = float(np.sqrt(max(1e-12, w_eq_s @ S_mat @ w_eq_s)))
    sr_eq = (ret_eq - rf_rate) / vol_eq if vol_eq > 0 else 0.0

    # 4. HRP (with optional signal tilt)
    hrp = HRPOpt(returns_df)
    w_hrp_raw = hrp.optimize()
    w_hrp = {t: float(w_hrp_raw.get(t, 0.0)) for t in valid_tickers}
    if signal_scores:
        adj_hrp = {}
        for t in valid_tickers:
            tilt_factor = 1.0 + 0.18 * float(signal_scores.get(t, 0.0))
            adj_hrp[t] = max(0.0, w_hrp[t] * max(0.75, min(1.25, tilt_factor)))
        s_hrp = sum(adj_hrp.values())
        if s_hrp > 0:
            w_hrp = {t: round(adj_hrp[t] / s_hrp, 5) for t in valid_tickers}
    w_hrp_s = pd.Series(w_hrp).reindex(valid_tickers).fillna(0.0)
    ret_hrp = float(w_hrp_s @ mu_vec)
    vol_hrp = float(np.sqrt(max(1e-12, w_hrp_s @ S_mat @ w_hrp_s)))
    sr_hrp = (ret_hrp - rf_rate) / vol_hrp if vol_hrp > 0 else 0.0

    return {
        "max_sharpe": {"weights": w_max, "ret": ret_max, "vol": vol_max, "sr": sr_max, "error": max_sharpe_error},
        "min_volatility": {"weights": w_min, "ret": ret_min, "vol": vol_min, "sr": sr_min, "error": None},
        "hrp": {"weights": w_hrp, "ret": ret_hrp, "vol": vol_hrp, "sr": sr_hrp, "error": None},
        "equal_weight": {"weights": w_eq, "ret": ret_eq, "vol": vol_eq, "sr": sr_eq, "error": None}
    }


def run_portfolio_optimization(
    tickers: List[str],
    start_date: str,
    end_date: str,
    budget: float = 100000.0,
    max_weight: float = 1.0,
    min_weight: float = 0.0,
    risk_free_rate: Optional[float] = None,
    num_simulations: int = 3500,
    backtest_split: Optional[str] = None,
    currency: str = "THB",
    fx_rate: Optional[float] = None,
    use_news_adjustment: bool = True
) -> Dict[str, Any]:
    """
    Execute full Markowitz, HRP, Monte Carlo, Portfolio Growth, and Live Market News & Technical Intelligence.
    """
    prices, valid_tickers, missing_tickers = fetch_historical_prices(tickers, start_date, end_date)

    if risk_free_rate is None or risk_free_rate <= 0:
        rf_rate = get_risk_free_rate()
    else:
        rf_rate = float(risk_free_rate)

    usd_thb = float(fx_rate) if (fx_rate is not None and fx_rate > 0) else get_usd_thb_rate()

    # 1. Expected Returns (CAGR) & Covariance Shrinkage (Ledoit-Wolf)
    mu = expected_returns.mean_historical_return(prices, frequency=TRADING_DAYS)
    S = risk_models.CovarianceShrinkage(prices, frequency=TRADING_DAYS).ledoit_wolf()
    returns_df = prices.pct_change().dropna()

    # Fetch live market news & compute technical signals for each ticker
    news_map = fetch_portfolio_market_news(valid_tickers)

    vols = np.sqrt(np.diag(S))
    asset_stats = []
    latest_prices = get_latest_prices(prices)
    mu_adjusted_dict: Dict[str, float] = {}
    signal_scores_map: Dict[str, float] = {}
    all_news_articles: List[Dict[str, Any]] = []

    for i, t in enumerate(valid_tickers):
        ret_val = float(mu[t])
        vol_val = float(vols[i])
        sr_val = (ret_val - rf_rate) / vol_val if vol_val > 0 else 0
        asset_wealth = (1 + returns_df[t]).cumprod()
        asset_dd = compute_drawdown_details(asset_wealth, budget)
        total_cum_return = float((prices[t].iloc[-1] / prices[t].iloc[0]) - 1.0)
        raw_p = float(latest_prices[t])
        native_curr = get_ticker_currency(t)
        price_thb = round(raw_p * usd_thb, 2) if native_curr == "USD" else round(raw_p, 2)
        price_usd = round(raw_p, 2) if native_curr == "USD" else (round(raw_p / usd_thb, 2) if usd_thb > 0 else round(raw_p, 2))
        price_in_budget_curr = price_thb if currency.upper() == "THB" else price_usd

        tech_info = compute_technical_signals(prices[t])
        t_news = news_map.get(t, {"news_sentiment_score": 0.0, "positive_count": 0, "negative_count": 0, "neutral_count": 0, "articles": []})
        decision_info = build_asset_decision_intelligence(t, ret_val, vol_val, tech_info, t_news)

        mu_adjusted_dict[t] = decision_info["adjusted_expected_return"]
        signal_scores_map[t] = decision_info["composite_signal_score"]
        for art in t_news.get("articles", []):
            all_news_articles.append(art)

        asset_stats.append({
            "ticker": t,
            "name": get_asset_name(t),
            "native_currency": native_curr,
            "native_price": round(raw_p, 2),
            "price_thb": price_thb,
            "price_usd": price_usd,
            "latest_price": price_in_budget_curr,
            "expected_return": round(ret_val, 4),
            "adjusted_expected_return": decision_info["adjusted_expected_return"],
            "return_tilt": decision_info["return_tilt"],
            "total_return": round(total_cum_return, 4),
            "volatility": round(vol_val, 4),
            "max_drawdown": asset_dd["max_drawdown_pct"],
            "max_drawdown_amount": asset_dd["max_drawdown_amount"],
            "min_capital_remaining": asset_dd["min_capital_remaining"],
            "drawdown_details": asset_dd,
            "sharpe_ratio": round(sr_val, 3),
            "technical": tech_info,
            "news": t_news,
            "decision": decision_info
        })

    mu_adjusted = pd.Series(mu_adjusted_dict).reindex(valid_tickers)

    corr_df = risk_models.cov_to_corr(S)
    correlation_data = {
        "tickers": valid_tickers,
        "names": [get_asset_name(t) for t in valid_tickers],
        "matrix": [[round(float(corr_df.loc[r, c]), 3) for c in valid_tickers] for r in valid_tickers]
    }

    # 2. Optimization Models (Compute BOTH Pure Historical AND News/Trend-Adjusted)
    min_feasible_max_weight = round(1.0 / len(valid_tickers) + 0.01, 2)
    effective_max_weight = max(max_weight, min_feasible_max_weight)
    weight_bounds = (min_weight, min(1.0, effective_max_weight))

    hist_solutions = _solve_all_strategies(mu, S, returns_df, valid_tickers, weight_bounds, rf_rate, None)
    adj_solutions = _solve_all_strategies(mu_adjusted, S, returns_df, valid_tickers, weight_bounds, rf_rate, signal_scores_map)

    active_solutions = adj_solutions if use_news_adjustment else hist_solutions

    w_max = active_solutions["max_sharpe"]["weights"]
    ret_max, vol_max, sr_max = active_solutions["max_sharpe"]["ret"], active_solutions["max_sharpe"]["vol"], active_solutions["max_sharpe"]["sr"]
    max_sharpe_error = active_solutions["max_sharpe"]["error"]
    da_max = compute_discrete_allocation(w_max, latest_prices, budget, currency, usd_thb)

    w_min = active_solutions["min_volatility"]["weights"]
    ret_min, vol_min, sr_min = active_solutions["min_volatility"]["ret"], active_solutions["min_volatility"]["vol"], active_solutions["min_volatility"]["sr"]
    da_min = compute_discrete_allocation(w_min, latest_prices, budget, currency, usd_thb)

    w_hrp = active_solutions["hrp"]["weights"]
    ret_hrp, vol_hrp, sr_hrp = active_solutions["hrp"]["ret"], active_solutions["hrp"]["vol"], active_solutions["hrp"]["sr"]
    da_hrp = compute_discrete_allocation(w_hrp, latest_prices, budget, currency, usd_thb)

    w_eq = active_solutions["equal_weight"]["weights"]
    ret_eq, vol_eq, sr_eq = active_solutions["equal_weight"]["ret"], active_solutions["equal_weight"]["vol"], active_solutions["equal_weight"]["sr"]
    da_eq = compute_discrete_allocation(w_eq, latest_prices, budget, currency, usd_thb)

    # 3. Historical Portfolio Wealth Simulation & Drawdown Analytics (Starting with `budget` capital)
    strat_weights_map = {
        "max_sharpe": pd.Series(w_max),
        "min_volatility": pd.Series(w_min),
        "hrp": pd.Series(w_hrp),
        "equal_weight": pd.Series(w_eq)
    }

    strat_wealth_df = pd.DataFrame(index=returns_df.index)
    strat_dd_amount_df = pd.DataFrame(index=returns_df.index)
    strat_drawdowns = {}
    strat_dd_details = {}
    strat_final_values = {}

    for key, w_s in strat_weights_map.items():
        w_aligned = w_s.reindex(valid_tickers).fillna(0.0)
        port_daily_ret = returns_df[valid_tickers] @ w_aligned
        cum_growth = (1.0 + port_daily_ret).cumprod()
        strat_wealth_df[key] = (cum_growth * budget).round(2)

        running_max = cum_growth.cummax().clip(lower=1.0)
        dd_pct_series = (cum_growth - running_max) / running_max
        # Monetary drawdown series relative to initial budget
        strat_dd_amount_df[key] = (dd_pct_series * budget).round(2)

        dd_info = compute_drawdown_details(cum_growth, budget)
        strat_drawdowns[key] = dd_info["max_drawdown_pct"]
        strat_dd_details[key] = dd_info
        strat_final_values[key] = round(float(strat_wealth_df[key].iloc[-1]), 2)

    step = max(1, len(strat_wealth_df) // 160)
    sampled_wealth = strat_wealth_df.iloc[::step]
    sampled_dd_amount = strat_dd_amount_df.iloc[::step]
    if strat_wealth_df.index[-1] not in sampled_wealth.index:
        sampled_wealth = pd.concat([sampled_wealth, strat_wealth_df.iloc[[-1]]])
        sampled_dd_amount = pd.concat([sampled_dd_amount, strat_dd_amount_df.iloc[[-1]]])

    portfolio_growth_chart = {
        "dates": [d.strftime('%Y-%m-%d') for d in sampled_wealth.index],
        "series": {
            k: sampled_wealth[k].tolist() for k in strat_weights_map.keys()
        },
        "drawdown_amount_series": {
            k: sampled_dd_amount[k].tolist() for k in strat_weights_map.keys()
        }
    }

    # 4. Monte Carlo Random Portfolios for Efficient Frontier
    rng = np.random.default_rng(42)
    W_rand = rng.dirichlet(np.ones(len(valid_tickers)), num_simulations)
    valid_mask = (W_rand <= (effective_max_weight + 1e-6)).all(axis=1)
    if valid_mask.sum() > 200:
        W_rand = W_rand[valid_mask]

    rand_rets = (W_rand * mu.values).sum(axis=1)
    rand_vols = np.sqrt(np.einsum('ij,jk,ik->i', W_rand, S.values, W_rand))
    rand_sr = np.where(rand_vols > 0, (rand_rets - rf_rate) / rand_vols, 0)

    sample_size = min(len(rand_rets), 1800)
    indices = np.linspace(0, len(rand_rets) - 1, sample_size, dtype=int)

    monte_carlo_points = [
        {
            "vol": round(float(rand_vols[idx]), 4),
            "ret": round(float(rand_rets[idx]), 4),
            "sharpe": round(float(rand_sr[idx]), 3)
        }
        for idx in indices
    ]

    frontier_curve = []
    try:
        min_target = float(ret_min)
        max_target = float(ret_min + 0.95 * (mu.max() - ret_min))
        if max_target > min_target:
            target_returns = np.linspace(min_target, max_target, 35)
            for tr in target_returns:
                try:
                    ef_curve = EfficientFrontier(mu, S, weight_bounds=weight_bounds)
                    ef_curve.efficient_return(tr)
                    r_perf, v_perf, s_perf = ef_curve.portfolio_performance(risk_free_rate=rf_rate)
                    frontier_curve.append({
                        "vol": round(float(v_perf), 4),
                        "ret": round(float(r_perf), 4),
                        "sharpe": round(float(s_perf), 3)
                    })
                except Exception:
                    continue
    except Exception:
        pass

    growth_100 = (prices / prices.iloc[0] * 100).round(2)
    growth_sampled = growth_100.iloc[::step]
    if growth_100.index[-1] not in growth_sampled.index:
        growth_sampled = pd.concat([growth_sampled, growth_100.iloc[[-1]]])

    growth_chart_data = {
        "dates": [d.strftime('%Y-%m-%d') for d in growth_sampled.index],
        "series": {t: growth_sampled[t].tolist() for t in valid_tickers}
    }

    cov_matrix_data = {
        "tickers": valid_tickers,
        "matrix": [[round(float(S.loc[r, c]), 6) for c in valid_tickers] for r in valid_tickers]
    }

    pos_assets = [a["ticker"] for a in asset_stats if a["decision"]["signal_level"] == "POSITIVE_BUY"]
    caution_assets = [a["ticker"] for a in asset_stats if a["decision"]["signal_level"] in ("CAUTIOUS_SHIELD", "OVERBOUGHT_TRANCHE")]

    market_intelligence = {
        "use_news_adjustment": bool(use_news_adjustment),
        "positive_signal_tickers": pos_assets,
        "caution_signal_tickers": caution_assets,
        "total_articles_analyzed": len(all_news_articles),
        "articles": all_news_articles[:16]
    }

    return {
        "status": "success",
        "metadata": {
            "tickers": valid_tickers,
            "missing_tickers": missing_tickers,
            "start_date": prices.index[0].strftime('%Y-%m-%d'),
            "end_date": prices.index[-1].strftime('%Y-%m-%d'),
            "trading_days": len(prices),
            "risk_free_rate": round(rf_rate, 4),
            "budget": budget,
            "currency": currency.upper(),
            "usd_thb_rate": usd_thb,
            "max_weight": effective_max_weight,
            "use_news_adjustment": bool(use_news_adjustment)
        },
        "asset_stats": asset_stats,
        "correlation": correlation_data,
        "covariance": cov_matrix_data,
        "market_intelligence": market_intelligence,
        "growth_100": growth_chart_data,
        "portfolio_growth": portfolio_growth_chart,
        "strategies": {
            "max_sharpe": {
                "key": "max_sharpe",
                "name": "พอร์ตผลตอบแทนคุ้มความเสี่ยงสูงสุด (Max Sharpe)",
                "short_name": "Max Sharpe Ratio",
                "tagline": "เหมาะสำหรับผู้ที่ต้องการผลตอบแทนเติบโตสูงสุดเมื่อเทียบกับความเสี่ยงที่รับได้",
                "weights": {k: round(float(v), 4) for k, v in w_max.items()},
                "historical_weights": {k: round(float(v), 4) for k, v in hist_solutions["max_sharpe"]["weights"].items()},
                "news_adjusted_weights": {k: round(float(v), 4) for k, v in adj_solutions["max_sharpe"]["weights"].items()},
                "historical_metrics": {
                    "expected_return": round(float(hist_solutions["max_sharpe"]["ret"]), 4),
                    "volatility": round(float(hist_solutions["max_sharpe"]["vol"]), 4),
                    "sharpe_ratio": round(float(hist_solutions["max_sharpe"]["sr"]), 2)
                },
                "news_adjusted_metrics": {
                    "expected_return": round(float(adj_solutions["max_sharpe"]["ret"]), 4),
                    "volatility": round(float(adj_solutions["max_sharpe"]["vol"]), 4),
                    "sharpe_ratio": round(float(adj_solutions["max_sharpe"]["sr"]), 2)
                },
                "expected_return": round(float(ret_max), 4),
                "expected_annual_profit": round(float(ret_max * budget), 2),
                "volatility": round(float(vol_max), 4),
                "max_drawdown": strat_drawdowns["max_sharpe"],
                "max_drawdown_amount": strat_dd_details["max_sharpe"]["max_drawdown_amount"],
                "min_capital_remaining": strat_dd_details["max_sharpe"]["min_capital_remaining"],
                "drawdown_details": strat_dd_details["max_sharpe"],
                "final_historical_value": strat_final_values["max_sharpe"],
                "sharpe_ratio": round(float(sr_max), 2),
                "discrete_allocation": da_max,
                "error_notice": max_sharpe_error
            },
            "min_volatility": {
                "key": "min_volatility",
                "name": "พอร์ตความเสี่ยงต่ำ ผันผวนน้อย (Min Volatility)",
                "short_name": "Min Volatility",
                "tagline": "เหมาะสำหรับผู้ที่เน้นรักษาเงินต้น ลดการแกว่งตัวของพอร์ตในช่วงตลาดผันผวน",
                "weights": {k: round(float(v), 4) for k, v in w_min.items()},
                "historical_weights": {k: round(float(v), 4) for k, v in hist_solutions["min_volatility"]["weights"].items()},
                "news_adjusted_weights": {k: round(float(v), 4) for k, v in adj_solutions["min_volatility"]["weights"].items()},
                "historical_metrics": {
                    "expected_return": round(float(hist_solutions["min_volatility"]["ret"]), 4),
                    "volatility": round(float(hist_solutions["min_volatility"]["vol"]), 4),
                    "sharpe_ratio": round(float(hist_solutions["min_volatility"]["sr"]), 2)
                },
                "news_adjusted_metrics": {
                    "expected_return": round(float(adj_solutions["min_volatility"]["ret"]), 4),
                    "volatility": round(float(adj_solutions["min_volatility"]["vol"]), 4),
                    "sharpe_ratio": round(float(adj_solutions["min_volatility"]["sr"]), 2)
                },
                "expected_return": round(float(ret_min), 4),
                "expected_annual_profit": round(float(ret_min * budget), 2),
                "volatility": round(float(vol_min), 4),
                "max_drawdown": strat_drawdowns["min_volatility"],
                "max_drawdown_amount": strat_dd_details["min_volatility"]["max_drawdown_amount"],
                "min_capital_remaining": strat_dd_details["min_volatility"]["min_capital_remaining"],
                "drawdown_details": strat_dd_details["min_volatility"],
                "final_historical_value": strat_final_values["min_volatility"],
                "sharpe_ratio": round(float(sr_min), 2),
                "discrete_allocation": da_min
            },
            "hrp": {
                "key": "hrp",
                "name": "พอร์ตกระจายความเสี่ยงสมดุล (Risk Parity / HRP)",
                "short_name": "Risk Parity (HRP)",
                "tagline": "จัดกลุ่มสินทรัพย์ด้วย Machine Learning เพื่อกระจายความเสี่ยงอย่างสมดุล ไม่กระจุกตัว",
                "weights": {k: round(float(v), 4) for k, v in w_hrp.items()},
                "historical_weights": {k: round(float(v), 4) for k, v in hist_solutions["hrp"]["weights"].items()},
                "news_adjusted_weights": {k: round(float(v), 4) for k, v in adj_solutions["hrp"]["weights"].items()},
                "historical_metrics": {
                    "expected_return": round(float(hist_solutions["hrp"]["ret"]), 4),
                    "volatility": round(float(hist_solutions["hrp"]["vol"]), 4),
                    "sharpe_ratio": round(float(hist_solutions["hrp"]["sr"]), 2)
                },
                "news_adjusted_metrics": {
                    "expected_return": round(float(adj_solutions["hrp"]["ret"]), 4),
                    "volatility": round(float(adj_solutions["hrp"]["vol"]), 4),
                    "sharpe_ratio": round(float(adj_solutions["hrp"]["sr"]), 2)
                },
                "expected_return": round(float(ret_hrp), 4),
                "expected_annual_profit": round(float(ret_hrp * budget), 2),
                "volatility": round(float(vol_hrp), 4),
                "max_drawdown": strat_drawdowns["hrp"],
                "max_drawdown_amount": strat_dd_details["hrp"]["max_drawdown_amount"],
                "min_capital_remaining": strat_dd_details["hrp"]["min_capital_remaining"],
                "drawdown_details": strat_dd_details["hrp"],
                "final_historical_value": strat_final_values["hrp"],
                "sharpe_ratio": round(float(sr_hrp), 2),
                "discrete_allocation": da_hrp
            },
            "equal_weight": {
                "key": "equal_weight",
                "name": "พอร์ตลงทุนสัดส่วนเท่ากัน (Equal Weight 1/N)",
                "short_name": "Equal Weight (1/N)",
                "tagline": "แบ่งเงินลงทุนเท่ากันในสินทรัพย์ทุกตัว ใช้เป็นเกณฑ์มาตรฐานเปรียบเทียบ",
                "weights": {k: round(float(v), 4) for k, v in w_eq.items()},
                "historical_weights": {k: round(float(v), 4) for k, v in hist_solutions["equal_weight"]["weights"].items()},
                "news_adjusted_weights": {k: round(float(v), 4) for k, v in adj_solutions["equal_weight"]["weights"].items()},
                "historical_metrics": {
                    "expected_return": round(float(hist_solutions["equal_weight"]["ret"]), 4),
                    "volatility": round(float(hist_solutions["equal_weight"]["vol"]), 4),
                    "sharpe_ratio": round(float(hist_solutions["equal_weight"]["sr"]), 2)
                },
                "news_adjusted_metrics": {
                    "expected_return": round(float(adj_solutions["equal_weight"]["ret"]), 4),
                    "volatility": round(float(adj_solutions["equal_weight"]["vol"]), 4),
                    "sharpe_ratio": round(float(adj_solutions["equal_weight"]["sr"]), 2)
                },
                "expected_return": round(float(ret_eq), 4),
                "expected_annual_profit": round(float(ret_eq * budget), 2),
                "volatility": round(float(vol_eq), 4),
                "max_drawdown": strat_drawdowns["equal_weight"],
                "max_drawdown_amount": strat_dd_details["equal_weight"]["max_drawdown_amount"],
                "min_capital_remaining": strat_dd_details["equal_weight"]["min_capital_remaining"],
                "drawdown_details": strat_dd_details["equal_weight"],
                "final_historical_value": strat_final_values["equal_weight"],
                "sharpe_ratio": round(float(sr_eq), 2),
                "discrete_allocation": da_eq
            }
        },
        "efficient_frontier": {
            "monte_carlo": monte_carlo_points,
            "curve": frontier_curve
        }
    }
