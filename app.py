"""
QuantFolio Pro - Production FastAPI Server
Supports Multi-User Concurrency, Caching, Cloud Hosting (Hugging Face Spaces / Render) & Public Tunneling
"""

import os
import re
import time
import json
import html
import uuid
import hmac
import base64
import secrets
import hashlib
import tempfile
import threading
import contextvars
import concurrent.futures
import math
import requests
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any, Tuple
from fastapi import FastAPI, HTTPException, Query, Depends, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from pydantic import BaseModel, Field
import yfinance as yf
import optimizer as _opt_module
from storage_repo import (
    StorageConfigError,
    StorageConflictError,
    StorageNotFoundError,
    StorageUnavailableError,
    build_repository,
    is_production_runtime,
    normalize_code,
    normalize_email,
    resolve_auth_secret_bytes,
)

from optimizer import (
    run_portfolio_optimization,
    fetch_portfolio_market_news,
    get_risk_free_rate,
    get_usd_thb_rate,
    get_market_rates_metadata,
    get_asset_market_type,
    get_ticker_currency,
    get_asset_name,
    _yf_lock
)

# Thread-safe context propagation so Guest /api/optimize requests skip external news scraping without modifying optimizer.py
_GUEST_SKIP_NEWS_CV: contextvars.ContextVar[bool] = contextvars.ContextVar("_guest_skip_news_cv", default=False)
_orig_tpe_submit = concurrent.futures.ThreadPoolExecutor.submit


def _context_aware_tpe_submit(self, fn, /, *args, **kwargs):
    ctx = contextvars.copy_context()
    return _orig_tpe_submit(self, ctx.run, fn, *args, **kwargs)


if getattr(concurrent.futures.ThreadPoolExecutor.submit, "__name__", "") != "_context_aware_tpe_submit":
    concurrent.futures.ThreadPoolExecutor.submit = _context_aware_tpe_submit

_orig_opt_fetch_news = _opt_module.fetch_portfolio_market_news


def _entitlement_guarded_fetch_news(tickers: List[str], force_refresh: bool = False) -> Dict[str, Any]:
    clean_list = [str(t).strip().upper() for t in (tickers or []) if str(t).strip()]
    if _GUEST_SKIP_NEWS_CV.get():
        return {
            t: {
                "ticker": t,
                "news_sentiment_score": 0.0,
                "positive_count": 0,
                "negative_count": 0,
                "neutral_count": 0,
                "articles": [],
            }
            for t in clean_list
        }
    if len(clean_list) > 10:
        results: Dict[str, Any] = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(12, len(clean_list))) as executor:
            future_map = {
                executor.submit(_opt_module.fetch_market_news_for_ticker, t, 4, force_refresh): t
                for t in clean_list
            }
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
                        "articles": [],
                    }
        return results
    return _orig_opt_fetch_news(clean_list, force_refresh=force_refresh)


if getattr(_opt_module.fetch_portfolio_market_news, "__name__", "") != "_entitlement_guarded_fetch_news":
    _opt_module.fetch_portfolio_market_news = _entitlement_guarded_fetch_news

app = FastAPI(
    title="QuantFolio Wealth Analytics API",
    description="Real-time Financial Portfolio Optimization Engine",
    version="4.2.0"
)

ALLOWED_ORIGINS = [
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "https://quantfolio-project.vercel.app",
    "https://quantfolio.vercel.app",
]
env_origins = os.environ.get("QUANTFOLIO_ALLOWED_ORIGINS", "")
if env_origins:
    ALLOWED_ORIGINS.extend([o.strip() for o in env_origins.split(",") if o.strip()])

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Multi-user in-memory caches
_quote_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_search_cache: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}
_popular_assets_cache: Optional[Tuple[float, Dict[str, Any]]] = None
_popular_assets_lock = threading.Lock()
QUOTE_CACHE_TTL = 90              # 90 seconds
SEARCH_CACHE_TTL = 600            # 10 minutes
POPULAR_ASSETS_CACHE_TTL = 86400  # 24 hours (auto-evolves over years with zero deploys)


class OptimizeRequest(BaseModel):
    tickers: List[str] = Field(default=["NVDA", "TSLA", "AMZN", "BTC-USD", "AAPL"])
    start_date: str = Field(default="2020-01-01")
    end_date: str = Field(default="2024-01-01")
    budget: float = Field(default=100000.0, ge=10.0)
    currency: str = Field(default="THB")
    fx_rate: Optional[float] = Field(default=None)
    max_weight: float = Field(default=1.0, ge=0.05, le=1.0)
    min_weight: float = Field(default=0.0, ge=0.0, le=0.5)
    risk_free_rate: Optional[float] = Field(default=None)
    backtest_split: Optional[str] = Field(default=None)
    num_simulations: int = Field(default=3500, ge=500, le=10000)
    use_news_adjustment: bool = Field(default=False)
    bl_confidence: float = Field(default=0.50, ge=0.0, le=1.0)
    bl_views: Optional[Dict[str, float]] = Field(default=None)


@app.exception_handler(StorageConfigError)
async def _handle_storage_config_error(request: Request, exc: StorageConfigError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.exception_handler(StorageUnavailableError)
async def _handle_storage_unavailable_error(request: Request, exc: StorageUnavailableError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.get("/api/health")
def health_check():
    storage_backend = "unconfigured"
    storage_ready = False
    try:
        repo = _get_repo()
        storage_backend = repo.backend_name
        _get_auth_secret_key()
        storage_ready = True
    except StorageConfigError as exc:
        if storage_backend == "unconfigured":
            storage_backend = "misconfigured"
        return {
            "status": "degraded",
            "app": "QuantFolio Wealth Analytics",
            "version": app.version,
            "production_runtime": is_production_runtime(),
            "storage_backend": storage_backend,
            "storage_ready": False,
            "detail": str(exc),
        }
    return {
        "status": "ok",
        "app": "QuantFolio Wealth Analytics",
        "version": app.version,
        "production_runtime": is_production_runtime(),
        "storage_backend": storage_backend,
        "storage_ready": storage_ready,
    }


@app.get("/api/rf")
def fetch_risk_free_rate(currency: str = Query(default="USD")):
    """Fetch current risk-free rate (matched to currency) and USD/THB exchange rate with source & timestamps"""
    import optimizer as _opt
    curr = (currency or "USD").strip().upper()
    rate = get_risk_free_rate(currency=curr)
    fx = get_usd_thb_rate()
    meta = _opt.get_market_rates_metadata(currency=curr) if hasattr(_opt, "get_market_rates_metadata") else {}
    return {
        "risk_free_rate": rate,
        "percentage": f"{rate * 100:.2f}%",
        "currency": curr,
        "usd_thb_rate": fx,
        "is_fallback_fx": bool(getattr(_opt, "_last_fx_is_fallback", meta.get("is_fallback_fx", False))),
        "is_fallback_rf": bool(getattr(_opt, "_last_rf_is_fallback", meta.get("is_fallback_rf", False))),
        "rf_source": meta.get("risk_free_source", "BOT / พันธบัตรรัฐบาลไทย" if curr == "THB" else "US 13W Treasury Bill (^IRX)"),
        "rf_tenor": meta.get("risk_free_tenor", "อ้างอิงในระบบ" if curr == "THB" else "13 สัปดาห์"),
        "rf_date": meta.get("risk_free_date"),
        "rf_updated_at": meta.get("rf_updated_at") or datetime.now(timezone.utc).isoformat(),
        "fx_date": meta.get("fx_date"),
        "fx_updated_at": meta.get("fx_updated_at") or datetime.now(timezone.utc).isoformat()
    }


@app.get("/api/search")
def search_tickers(q: str = Query(..., min_length=1)):
    """Search global tickers, ETFs, and crypto via Yahoo Finance Search API"""
    clean_q = q.strip().lower()
    now = time.time()
    if clean_q in _search_cache:
        ts, cached_res = _search_cache[clean_q]
        if now - ts < SEARCH_CACHE_TTL:
            return {"query": q, "results": cached_res}

    try:
        url = f"https://query2.finance.yahoo.com/v1/finance/search?q={requests.utils.quote(q)}&quotesCount=8&newsCount=0"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }
        res = requests.get(url, headers=headers, timeout=5)
        if res.status_code == 200:
            data = res.json()
            quotes = data.get("quotes", [])
            results = []
            for item in quotes:
                symbol = item.get("symbol")
                if not symbol:
                    continue
                results.append({
                    "symbol": symbol,
                    "name": item.get("shortname") or item.get("longname") or get_asset_name(symbol),
                    "type": item.get("quoteType", "EQUITY"),
                    "exchange": item.get("exchDisp", item.get("exchange", "")),
                    "score": item.get("score", 0)
                })
            if len(_search_cache) > 200:
                _search_cache.clear()
            _search_cache[clean_q] = (now, results)
            return {"query": q, "results": results}
        return {"query": q, "results": []}
    except Exception as e:
        return {"query": q, "results": [], "error": str(e)}


# ==============================================================================
# DYNAMIC POPULAR ASSETS ENGINE (5-YEAR FUTURE-PROOF TOP MARKET CAP + FALLBACK)
# ==============================================================================
_POPULAR_ASSET_LABEL_MAP: Dict[str, str] = {
    # Thailand SET Blue Chips (Thai + English friendly names)
    "DELTA.BK": "DELTA (เดลต้า)",
    "PTT.BK": "PTT (ปตท.)",
    "ADVANC.BK": "ADVANC (AIS)",
    "GULF.BK": "GULF (กัลฟ์)",
    "AOT.BK": "AOT (ทอท.)",
    "KBANK.BK": "KBANK (กสิกรไทย)",
    "KTB.BK": "KTB (กรุงไทย)",
    "PTTEP.BK": "PTTEP (ปตท.สผ.)",
    "SCB.BK": "SCB (เอสซีบี เอกซ์)",
    "CPALL.BK": "CPALL (7-Eleven)",
    "TRUE.BK": "TRUE (ทรู)",
    "BBL.BK": "BBL (กรุงเทพ)",
    "BDMS.BK": "BDMS (รพ.กรุงเทพ)",
    "CPN.BK": "CPN (เซ็นทรัลพัฒนา)",
    "BAY.BK": "BAY (กรุงศรี)",
    "SCC.BK": "SCC (ปูนซิเมนต์ไทย)",
    "TTB.BK": "TTB (ทีทีบี)",
    "CRC.BK": "CRC (เซ็นทรัล รีเทล)",
    "BH.BK": "BH (รพ.บำรุงราษฎร์)",
    "MINT.BK": "MINT (ไมเนอร์)",
    "TISCO.BK": "TISCO (ทิสโก้)",
    "OR.BK": "OR (ปตท. น้ำมันและการค้าปลีก)",
    "CPF.BK": "CPF (ซีพีเอฟ)",
    "GPSC.BK": "GPSC (โกลบอล เพาเวอร์)",
    "IVL.BK": "IVL (อินโดรามา)",
    "BEM.BK": "BEM (ทางด่วนและรถไฟฟ้า)",
    "BTS.BK": "BTS (บีทีเอส)",
    "HMPRO.BK": "HMPRO (โฮมโปร)",
    "LH.BK": "LH (แลนด์ แอนด์ เฮ้าส์)",
    "TLI.BK": "TLI (ไทยประกันชีวิต)",
    "AWC.BK": "AWC (แอสเสท เวิรด์)",
    "MTC.BK": "MTC (เมืองไทย แคปปิตอล)",
    "SAWAD.BK": "SAWAD (ศรีสวัสดิ์)",
    "TOP.BK": "TOP (ไทยออยล์)",
    "WHA.BK": "WHA (ดับบลิวเอชเอ)",
    # US Mega-Cap Equities
    "NVDA": "NVDA (NVIDIA)",
    "AAPL": "AAPL (Apple)",
    "MSFT": "MSFT (Microsoft)",
    "AMZN": "AMZN (Amazon)",
    "GOOGL": "GOOGL (Alphabet)",
    "META": "META (Meta)",
    "TSLA": "TSLA (Tesla)",
    "AVGO": "AVGO (Broadcom)",
    "TSM": "TSM (TSMC)",
    "BRK-B": "BRK-B (Berkshire)",
    "LLY": "LLY (Eli Lilly)",
    "WMT": "WMT (Walmart)",
    "JPM": "JPM (JPMorgan)",
    "V": "V (Visa)",
    "MA": "MA (Mastercard)",
    "XOM": "XOM (ExxonMobil)",
    "COST": "COST (Costco)",
    "ORCL": "ORCL (Oracle)",
    "NFLX": "NFLX (Netflix)",
    "AMD": "AMD",
    "JNJ": "JNJ (Johnson & Johnson)",
    "KO": "KO (Coca-Cola)",
    "PG": "PG (P&G)",
    "HD": "HD (Home Depot)",
    "UNH": "UNH (UnitedHealth)",
    "BAC": "BAC (Bank of America)",
    "PLTR": "PLTR (Palantir)",
    # Evergreen Multi-Asset ETFs
    "SPY": "SPY (S&P 500 ETF)",
    "QQQ": "QQQ (Nasdaq 100 ETF)",
    "VOO": "VOO (Vanguard S&P 500)",
    "VTI": "VTI (US Total Stock)",
    "GLD": "GLD (ทองคำโลก ETF)",
    "SLV": "SLV (แร่เงิน ETF)",
    "TLT": "TLT (พันธบัตรสหรัฐฯ 20 ปี+)",
    "BND": "BND (ตราสารหนี้รวมสหรัฐฯ)",
    "VNQ": "VNQ (อสังหาฯ สหรัฐฯ REIT)",
    "DBC": "DBC (สินค้าโภคภัณฑ์รวม)",
    # Top Crypto
    "BTC-USD": "BTC-USD (Bitcoin)",
    "ETH-USD": "ETH-USD (Ethereum)",
    "BNB-USD": "BNB-USD (BNB)",
    "XRP-USD": "XRP-USD (XRP)",
    "SOL-USD": "SOL-USD (Solana)",
    "ADA-USD": "ADA-USD (Cardano)",
    "TRX-USD": "TRX-USD (TRON)",
    "DOGE-USD": "DOGE-USD (Dogecoin)",
    "LINK-USD": "LINK-USD (Chainlink)",
    "AVAX-USD": "AVAX-USD (Avalanche)",
}

FALLBACK_POPULAR_ASSETS: Dict[str, List[Dict[str, str]]] = {
    "thai_set50": [
        {"symbol": s, "label": _POPULAR_ASSET_LABEL_MAP[s]}
        for s in [
            "DELTA.BK", "PTT.BK", "ADVANC.BK", "GULF.BK", "AOT.BK", "KBANK.BK",
            "KTB.BK", "PTTEP.BK", "SCB.BK", "CPALL.BK", "TRUE.BK", "BBL.BK",
            "BDMS.BK", "CPN.BK", "SCC.BK", "BH.BK", "MINT.BK", "TISCO.BK",
        ]
    ],
    "us_equities": [
        {"symbol": s, "label": _POPULAR_ASSET_LABEL_MAP[s]}
        for s in [
            "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO",
            "BRK-B", "LLY", "WMT", "JPM", "V", "MA", "COST", "AMD", "NFLX", "KO",
        ]
    ],
    "etf_gold_bonds": [
        {"symbol": s, "label": _POPULAR_ASSET_LABEL_MAP[s]}
        for s in ["SPY", "QQQ", "VOO", "VTI", "GLD", "SLV", "TLT", "BND", "VNQ", "DBC"]
    ],
    "crypto": [
        {"symbol": s, "label": _POPULAR_ASSET_LABEL_MAP[s]}
        for s in ["BTC-USD", "ETH-USD", "BNB-USD", "XRP-USD", "SOL-USD", "ADA-USD"]
    ],
}

_PUBLIC_US_EXCHANGES = {"NMS", "NYQ", "NGM", "NCM", "ASE", "PCX", "BTS"}
_US_DUAL_CLASS_SKIP = {"GOOG", "BRK-A", "BRK.A", "FOX", "NWS", "UHAL-B", "HEI-A", "LEN-B", "BF-A"}
_THAI_DR_SUFFIX_RE = re.compile(r"(01|03|06|11|13|19|23|41|80)$")
_CRYPTO_SYMBOL_RE = re.compile(r"^[A-Z]{2,8}-USD$")
_MIN_TRADING_HISTORY_DAYS = 365  # Require >=1 year of public history so brand-new IPOs never collapse multi-year covariance/backtests


def _has_sufficient_trading_history(quote: Dict[str, Any], min_days: int = _MIN_TRADING_HISTORY_DAYS) -> bool:
    """Exclude brand-new IPOs (<1Y history) that would truncate multi-year portfolio backtests; graduate them automatically once mature."""
    ftd_ms = quote.get("firstTradeDateMilliseconds")
    if ftd_ms is None:
        return True
    try:
        cutoff_ms = (time.time() - min_days * 86400) * 1000.0
        return float(ftd_ms) <= cutoff_ms
    except Exception:
        return True
_CRYPTO_EXCLUDED = {
    "USDT-USD", "USDC-USD", "DAI-USD", "FDUSD-USD", "USDE-USD", "PYUSD-USD",
    "TUSD-USD", "USDD-USD", "RLUSD-USD", "USD1-USD", "BUSD-USD", "USDS-USD",
    "EURC-USD", "USDP-USD", "GUSD-USD", "FRAX-USD",
    "STETH-USD", "WSTETH-USD", "WETH-USD", "WBTC-USD", "WEETH-USD",
    "SUSDS-USD", "CBETH-USD", "CBBTC-USD", "WBNB-USD", "BETH-USD", "RETH-USD",
}


def _format_popular_asset_label(symbol: str, raw_name: str = "") -> str:
    """Return bilingual institutional label for known assets and clean auto-formatted label for future newcomers."""
    sym = str(symbol or "").strip().upper()
    if sym in _POPULAR_ASSET_LABEL_MAP:
        return _POPULAR_ASSET_LABEL_MAP[sym]

    display_sym = sym[:-3] if sym.endswith(".BK") else sym
    name = str(raw_name or "").strip()
    if not name:
        return display_sym

    # Yahoo SET quotes often arrive as "DELTA_DELTA ELECTRONICS" -> strip "DELTA_" prefix
    if "_" in name:
        prefix, rest = name.split("_", 1)
        if prefix.strip().upper() == display_sym:
            name = rest.strip()

    # Clean corporate suffixes and trailing USD for crypto
    name = re.sub(r"\s+USD$", "", name, flags=re.IGNORECASE)
    name = re.sub(
        r",?\s*\b(Public Company Limited|Public Co\.?,?\s*Ltd\.?|Corporation|Corp\.?|Incorporated|Inc\.?|Limited|Ltd\.?|Holdings?|PLC|N\.V\.|S\.A\.|AG|Co\.?)\b\.?",
        "",
        name,
        flags=re.IGNORECASE,
    )
    name = re.sub(r"\s+", " ", name).strip(" ,.-")
    if not name or name.upper() == display_sym.upper() or name.upper() == sym.upper():
        return display_sym

    if name.isupper() and len(name) > 5:
        name = name.title()
    if len(name) > 22:
        name = name[:21].rstrip(" ,.-") + "…"
    return f"{display_sym} ({name})"


def _filter_thai_top_quotes(quotes: List[Dict[str, Any]], limit: int = 18) -> List[Dict[str, str]]:
    """Filter Yahoo Finance TH screener quotes down to pure active SET common stocks (no DR, NVDR, foreign board, or shells)."""
    out: List[Dict[str, str]] = []
    seen = set()
    for q in quotes or []:
        sym = str(q.get("symbol") or "").strip().upper()
        if not sym.endswith(".BK") or sym in seen:
            continue
        base = sym[:-3]
        if not base or "-" in base or "." in base:
            continue
        name = str(q.get("shortName") or q.get("longName") or "")
        name_upper = name.upper()
        if "_DR" in name_upper or " DR" in name_upper or "#" in name or _THAI_DR_SUFFIX_RE.search(base):
            continue
        price = q.get("regularMarketPrice")
        vol = q.get("regularMarketVolume") or q.get("averageDailyVolume3Month") or 0
        if (price is not None and float(price) <= 0) or float(vol) <= 0:
            continue
        if not _has_sufficient_trading_history(q):
            continue
        seen.add(sym)
        out.append({"symbol": sym, "label": _format_popular_asset_label(sym, name)})
        if len(out) >= limit:
            break
    return out


def _filter_us_top_quotes(quotes: List[Dict[str, Any]], limit: int = 18) -> List[Dict[str, str]]:
    """Filter Yahoo Finance US screener quotes down to public mega-cap equities (no pre-IPO placeholders or dual-class duplicates)."""
    out: List[Dict[str, str]] = []
    seen = set()
    for q in quotes or []:
        sym = str(q.get("symbol") or "").strip().upper()
        if not sym or sym in seen or sym in _US_DUAL_CLASS_SKIP:
            continue
        exch = str(q.get("exchange") or "").strip().upper()
        qtype = str(q.get("quoteType") or "EQUITY").strip().upper()
        if not exch or exch not in _PUBLIC_US_EXCHANGES:
            continue
        if qtype != "EQUITY":
            continue
        price = q.get("regularMarketPrice")
        vol = q.get("regularMarketVolume") or q.get("averageDailyVolume3Month") or 0
        if price is None or float(price) <= 0 or float(vol) <= 0:
            continue
        if not _has_sufficient_trading_history(q):
            continue
        name = str(q.get("shortName") or q.get("longName") or "")
        seen.add(sym)
        out.append({"symbol": sym, "label": _format_popular_asset_label(sym, name)})
        if len(out) >= limit:
            break
    return out


def _filter_crypto_top_quotes(quotes: List[Dict[str, Any]], limit: int = 6) -> List[Dict[str, str]]:
    """Filter Yahoo Finance crypto screener quotes down to major non-stablecoin, non-wrapped digital assets."""
    out: List[Dict[str, str]] = []
    seen = set()
    for q in quotes or []:
        sym = str(q.get("symbol") or "").strip().upper()
        if not sym or sym in seen or sym in _CRYPTO_EXCLUDED or not _CRYPTO_SYMBOL_RE.match(sym):
            continue
        price = q.get("regularMarketPrice")
        vol = q.get("regularMarketVolume") or q.get("volume24Hr") or 0
        if price is not None and float(price) <= 0:
            continue
        if vol is not None and float(vol) <= 0:
            continue
        name = str(q.get("shortName") or q.get("longName") or "")
        seen.add(sym)
        out.append({"symbol": sym, "label": _format_popular_asset_label(sym, name)})
        if len(out) >= limit:
            break
    return out


def _fetch_live_thai_top_market_cap(limit: int = 18) -> Optional[List[Dict[str, str]]]:
    try:
        from yfinance import EquityQuery
        q_th = EquityQuery("and", [
            EquityQuery("eq", ["region", "th"]),
            EquityQuery("gt", ["intradaymarketcap", 10_000_000_000]),
        ])
        res = yf.screen(q_th, sortField="intradaymarketcap", sortAsc=False, size=100)
        cleaned = _filter_thai_top_quotes((res or {}).get("quotes", []), limit=limit)
        return cleaned if len(cleaned) >= 8 else None
    except Exception:
        return None


def _fetch_live_us_top_market_cap(limit: int = 18) -> Optional[List[Dict[str, str]]]:
    try:
        from yfinance import EquityQuery
        q_us = EquityQuery("and", [
            EquityQuery("eq", ["region", "us"]),
            EquityQuery("gt", ["intradaymarketcap", 50_000_000_000]),
        ])
        res = yf.screen(q_us, sortField="intradaymarketcap", sortAsc=False, size=60)
        cleaned = _filter_us_top_quotes((res or {}).get("quotes", []), limit=limit)
        return cleaned if len(cleaned) >= 8 else None
    except Exception:
        return None


def _fetch_live_crypto_top_market_cap(limit: int = 6) -> Optional[List[Dict[str, str]]]:
    try:
        url = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=all_cryptocurrencies_us&count=30"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }
        res = requests.get(url, headers=headers, timeout=6)
        if res.status_code != 200:
            return None
        data = res.json()
        quotes = (data.get("finance", {}).get("result") or [{}])[0].get("quotes", [])
        cleaned = _filter_crypto_top_quotes(quotes, limit=limit)
        return cleaned if len(cleaned) >= 3 else None
    except Exception:
        return None


def _build_popular_assets_payload() -> Dict[str, Any]:
    """Fetch live Top Market Cap catalogs in parallel with strict timeouts and institutional fallbacks."""
    live_categories: List[str] = []
    categories: Dict[str, List[Dict[str, str]]] = {
        "thai_set50": list(FALLBACK_POPULAR_ASSETS["thai_set50"]),
        "us_equities": list(FALLBACK_POPULAR_ASSETS["us_equities"]),
        "etf_gold_bonds": list(FALLBACK_POPULAR_ASSETS["etf_gold_bonds"]),
        "crypto": list(FALLBACK_POPULAR_ASSETS["crypto"]),
    }

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futs = {
            "thai_set50": pool.submit(_fetch_live_thai_top_market_cap, 18),
            "us_equities": pool.submit(_fetch_live_us_top_market_cap, 18),
            "crypto": pool.submit(_fetch_live_crypto_top_market_cap, 6),
        }
        for key, fut in futs.items():
            try:
                items = fut.result(timeout=7.5)
                if items:
                    categories[key] = items
                    live_categories.append(key)
            except Exception:
                pass

    now_utc = datetime.now(timezone.utc)
    if len(live_categories) == 3:
        source_mode = "live_market_cap"
    elif len(live_categories) > 0:
        source_mode = "partial_live"
    else:
        source_mode = "curated_fallback"

    return {
        "source": source_mode,
        "ranking_method": "Top Market Cap",
        "updated_at": now_utc.isoformat(),
        "as_of_date": now_utc.strftime("%Y-%m-%d"),
        "cache_ttl_sec": POPULAR_ASSETS_CACHE_TTL,
        "live_categories": live_categories,
        "categories": categories,
        "presets": {
            "thai_set50": [x["symbol"] for x in categories["thai_set50"][:5]],
            "tech_titans": [x["symbol"] for x in categories["us_equities"][:7]],
            "all_weather": ["SPY", "QQQ", "GLD", "TLT", "DBC"],
        },
    }


@app.get("/api/popular-assets")
def get_popular_assets(refresh: bool = Query(default=False)):
    """Return auto-updating Top Market Cap popular asset catalog (24h server + CDN cache, zero-downtime fallback)."""
    global _popular_assets_cache
    now = time.time()
    with _popular_assets_lock:
        if _popular_assets_cache is not None:
            ts, cached_payload = _popular_assets_cache
            age = now - ts
            # Ignore forced refresh if cache is younger than 5 minutes to protect upstream rate limits
            if age < POPULAR_ASSETS_CACHE_TTL and (not refresh or age < 300):
                resp_payload = dict(cached_payload)
                resp_payload["is_cached"] = True
                resp_payload["cache_age_sec"] = round(age, 1)
                return JSONResponse(
                    content=resp_payload,
                    headers={"Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400"},
                )

    payload = _build_popular_assets_payload()
    with _popular_assets_lock:
        _popular_assets_cache = (time.time(), payload)

    resp_payload = dict(payload)
    resp_payload["is_cached"] = False
    resp_payload["cache_age_sec"] = 0.0
    return JSONResponse(
        content=resp_payload,
        headers={"Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400"},
    )


@app.get("/api/quote")
def get_realtime_quotes(tickers: str = Query(..., description="Comma-separated tickers")):
    """Get quotes, latest close/bar dates, and day change for selected tickers"""
    ticker_list = []
    for t in tickers.split(","):
        s = t.strip().upper()
        if s and s not in ticker_list:
            ticker_list.append(s)

    rates_meta = get_market_rates_metadata(currency="USD")
    if not ticker_list:
        return {
            "quotes": {},
            "usd_thb_rate": rates_meta["usd_thb_rate"],
            "fx_date": rates_meta.get("fx_date"),
            "fx_updated_at": rates_meta.get("fx_updated_at"),
            "is_fallback_fx": rates_meta.get("is_fallback_fx", False),
        }

    now = time.time()
    quotes = {}
    to_fetch = []

    for symbol in ticker_list:
        if symbol in _quote_cache:
            ts, cached_q = _quote_cache[symbol]
            if now - ts < QUOTE_CACHE_TTL:
                q_copy = dict(cached_q)
                q_copy["is_cached"] = True
                q_copy["cache_age_sec"] = round(now - ts, 1)
                quotes[symbol] = q_copy
                continue
        to_fetch.append(symbol)

    fx = float(rates_meta["usd_thb_rate"])
    if to_fetch:
        fetched_at_iso = datetime.now(timezone.utc).isoformat()
        today_utc = datetime.now(timezone.utc).date()

        def _store_quote(symbol: str, last_price: Optional[float], prev_close: Optional[float], as_of_date: Optional[str]):
            market_type = get_asset_market_type(symbol)
            is_stale = False
            if as_of_date:
                try:
                    dt_obs = datetime.strptime(as_of_date[:10], "%Y-%m-%d").date()
                    cal_age = (today_utc - dt_obs).days
                    # Warn if equity data is older than 5 calendar days (>~3 business days) or crypto > 1 day
                    is_stale = cal_age > (1 if market_type == "crypto" else 5)
                except Exception:
                    is_stale = False

            if last_price is not None:
                chg = 0.0
                chg_pct = 0.0
                if prev_close and prev_close > 0:
                    chg = last_price - prev_close
                    chg_pct = (chg / prev_close) * 100.0

                native_curr = get_ticker_currency(symbol)
                price_thb = round(float(last_price) * fx, 2) if native_curr == "USD" else round(float(last_price), 2)
                price_usd = round(float(last_price), 2) if native_curr == "USD" else (round(float(last_price) / fx, 2) if fx > 0 else round(float(last_price), 2))

                q_data = {
                    "symbol": symbol,
                    "name": get_asset_name(symbol),
                    "market_type": market_type,
                    "price": round(float(last_price), 2),
                    "price_thb": price_thb,
                    "price_usd": price_usd,
                    "prev_close": round(float(prev_close), 2) if prev_close else None,
                    "change": round(float(chg), 2),
                    "change_pct": round(float(chg_pct), 2),
                    "currency": native_curr,
                    "as_of_date": as_of_date,
                    "fetched_at": fetched_at_iso,
                    "is_cached": False,
                    "cache_age_sec": 0.0,
                    "is_stale": is_stale
                }
                quotes[symbol] = q_data
                _quote_cache[symbol] = (now, q_data)

        try:
            remaining_symbols = list(to_fetch)
            is_real_yfinance = (getattr(yf.Tickers, "__module__", "") or "").startswith("yfinance")

            # Fast single-request batch download for all tickers simultaneously (avoids N*2 serial Yahoo calls)
            if is_real_yfinance and remaining_symbols:
                try:
                    with _yf_lock:
                        batch_df = yf.download(
                            remaining_symbols,
                            period="5d",
                            auto_adjust=True,
                            progress=False,
                            threads=True,
                        )
                    if batch_df is not None and not batch_df.empty:
                        close_part = batch_df["Close"] if "Close" in batch_df.columns else batch_df
                        still_missing = []
                        for symbol in remaining_symbols:
                            try:
                                if hasattr(close_part, "columns"):
                                    if symbol in close_part.columns:
                                        s = close_part[symbol].dropna()
                                    elif len(remaining_symbols) == 1 and len(close_part.columns) == 1:
                                        s = close_part.iloc[:, 0].dropna()
                                    else:
                                        still_missing.append(symbol)
                                        continue
                                else:
                                    s = close_part.dropna() if len(remaining_symbols) == 1 else None
                                if s is not None and not s.empty:
                                    last_idx = s.index[-1]
                                    as_of_date = last_idx.strftime('%Y-%m-%d') if hasattr(last_idx, 'strftime') else str(last_idx)[:10]
                                    last_price = float(s.iloc[-1])
                                    prev_close = float(s.iloc[-2]) if len(s) >= 2 else None
                                    _store_quote(symbol, last_price, prev_close, as_of_date)
                                else:
                                    still_missing.append(symbol)
                            except Exception:
                                still_missing.append(symbol)
                        remaining_symbols = still_missing
                except Exception:
                    pass

            # Fallback to yf.Tickers for any symbols missed by batch download (or when monkeypatched in tests)
            if remaining_symbols:
                with _yf_lock:
                    t_objs = yf.Tickers(" ".join(remaining_symbols))
                    for symbol in remaining_symbols:
                        try:
                            t = t_objs.tickers.get(symbol)
                            if not t:
                                continue
                            info = t.fast_info
                            last_price = getattr(info, 'last_price', None)
                            prev_close = getattr(info, 'previous_close', None)

                            as_of_date = None
                            try:
                                if hasattr(t, "history"):
                                    hist = t.history(period="5d", auto_adjust=True, progress=False)
                                    if hist is not None and not hist.empty:
                                        last_idx = hist.index[-1]
                                        as_of_date = last_idx.strftime('%Y-%m-%d') if hasattr(last_idx, 'strftime') else str(last_idx)[:10]
                                        if last_price is None and "Close" in hist.columns:
                                            last_price = float(hist["Close"].dropna().iloc[-1])
                                        if prev_close is None and "Close" in hist.columns and len(hist["Close"].dropna()) >= 2:
                                            prev_close = float(hist["Close"].dropna().iloc[-2])
                            except Exception:
                                as_of_date = None

                            if last_price is not None:
                                _store_quote(symbol, last_price, prev_close, as_of_date)
                            else:
                                err_q = {"symbol": symbol, "name": get_asset_name(symbol), "error": "ไม่พบข้อมูลราคาล่าสุด"}
                                quotes[symbol] = err_q
                                _quote_cache[symbol] = (now, err_q)
                        except Exception as item_err:
                            err_q = {"symbol": symbol, "name": get_asset_name(symbol), "error": str(item_err)}
                            quotes[symbol] = err_q
                            _quote_cache[symbol] = (now, err_q)
        except Exception as e:
            return {
                "quotes": quotes,
                "error": str(e),
                "usd_thb_rate": fx,
                "fx_date": rates_meta.get("fx_date"),
                "fx_updated_at": rates_meta.get("fx_updated_at"),
                "is_fallback_fx": rates_meta.get("is_fallback_fx", False),
            }

    return {
        "quotes": quotes,
        "usd_thb_rate": fx,
        "fx_date": rates_meta.get("fx_date"),
        "fx_updated_at": rates_meta.get("fx_updated_at"),
        "is_fallback_fx": rates_meta.get("is_fallback_fx", False),
    }


@app.post("/api/optimize")
def optimize_portfolio(
    req: OptimizeRequest,
    authorization: Optional[str] = Header(default=None),
    x_qf_admin_preview_tier: Optional[str] = Header(default=None, alias="X-QF-Admin-Preview-Tier")
):
    """Run full Markowitz, HRP, Monte Carlo, Portfolio Growth, and Market News Signal calculations with tier enforcement."""
    _, entitlements = _resolve_request_user_and_entitlements(authorization, x_qf_admin_preview_tier)
    max_assets = int(entitlements.get("max_assets", 5))
    clean_tickers = [t.strip().upper() for t in (req.tickers or []) if str(t).strip()]
    if len(clean_tickers) > max_assets:
        plan_tier = str(entitlements.get("plan_tier") or "guest")
        if plan_tier == "guest":
            upgrade_hint = "กรุณาสมัครสมาชิกฟรีเพื่อเพิ่มเป็น 8 สินทรัพย์ หรืออัปเกรดเป็น QuantFolio Pro (15 สินทรัพย์) / Advisor Pro (25 สินทรัพย์)"
        elif plan_tier == "free":
            upgrade_hint = "กรุณาอัปเกรดเป็น QuantFolio Pro (15 สินทรัพย์) หรือ Advisor Pro (25 สินทรัพย์)"
        elif plan_tier == "pro":
            upgrade_hint = "กรุณาอัปเกรดเป็น Advisor Pro (IC / IP) เพื่อขยายเพดานพอร์ตขนาดใหญ่ได้สูงสุด 25 สินทรัพย์"
        else:
            upgrade_hint = "ระบบรองรับสูงสุด 25 สินทรัพย์ต่อพอร์ต กรุณาลดจำนวนสินทรัพย์ลง"
        raise HTTPException(
            status_code=403,
            detail=(
                f"แพ็กเกจปัจจุบันของคุณ ({entitlements['label_th']}) รองรับสูงสุด {max_assets} สินทรัพย์ต่อพอร์ต "
                f"(คุณเลือก {len(clean_tickers)} สินทรัพย์) {upgrade_hint}"
            ),
        )

    can_view_news = bool(entitlements.get("can_view_news", False))
    can_customize_bl = bool(entitlements.get("can_customize_bl_views", False))
    safe_conf_cap = float(entitlements.get("safe_bl_confidence_cap", 0.35))

    try:
        effective_use_news = bool(req.use_news_adjustment) if can_view_news else False
        effective_bl_confidence = float(req.bl_confidence)
        if not can_customize_bl:
            # Free Member safe confidence cap (35%) prevents noisy short-term news from over-swinging weights
            effective_bl_confidence = min(effective_bl_confidence, safe_conf_cap)

        clean_bl_views = None
        if can_customize_bl and req.bl_views is not None:
            clean_bl_views = {}
            for k, v in req.bl_views.items():
                try:
                    fv = float(v)
                    if -0.25 <= fv <= 0.25:
                        clean_bl_views[str(k).strip().upper()] = fv
                    else:
                        clean_bl_views[str(k).strip().upper()] = max(-0.25, min(0.25, fv))
                except (TypeError, ValueError):
                    continue

        cv_token = _GUEST_SKIP_NEWS_CV.set(not can_view_news)
        try:
            results = run_portfolio_optimization(
                tickers=req.tickers,
                start_date=req.start_date,
                end_date=req.end_date,
                budget=req.budget,
                max_weight=req.max_weight,
                min_weight=req.min_weight,
                risk_free_rate=req.risk_free_rate,
                num_simulations=req.num_simulations,
                backtest_split=req.backtest_split,
                currency=req.currency,
                fx_rate=req.fx_rate,
                use_news_adjustment=effective_use_news,
                bl_confidence=effective_bl_confidence,
                bl_views=clean_bl_views
            )
        finally:
            _GUEST_SKIP_NEWS_CV.reset(cv_token)

        # Strip news articles & headlines from Guest responses so unauthenticated users/bots never receive news payloads
        if not can_view_news and isinstance(results, dict):
            mi = results.get("market_intelligence")
            if isinstance(mi, dict):
                mi["articles"] = []
                mi["total_articles_analyzed"] = 0
                mi["news_locked_guest"] = True
            for stat in results.get("asset_stats", []) or []:
                if isinstance(stat, dict) and isinstance(stat.get("news"), dict):
                    stat["news"]["articles"] = []

        if isinstance(results, dict) and isinstance(results.get("metadata"), dict):
            results["metadata"]["dropped_tickers"] = list(results["metadata"].get("missing_tickers") or [])
            results["metadata"]["plan_tier"] = entitlements["plan_tier"]
            results["metadata"]["applied_use_news_adjustment"] = bool(effective_use_news)
            results["metadata"]["applied_bl_confidence"] = round(effective_bl_confidence, 4)
            results["metadata"]["tier_info"] = {
                "plan_tier": entitlements["plan_tier"],
                "entitlements": entitlements,
                "applied_use_news_adjustment": bool(effective_use_news),
                "applied_bl_confidence": round(effective_bl_confidence, 4),
            }
        return results
    except HTTPException:
        raise
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"เกิดข้อผิดพลาดในการคำนวณ: {str(e)}")


@app.get("/api/market-news")
def get_market_news_endpoint(
    tickers: str = Query(..., description="Comma-separated tickers"),
    force: bool = Query(default=False, description="Bypass 10-minute cache to fetch live headlines"),
    authorization: Optional[str] = Header(default=None),
    x_qf_admin_preview_tier: Optional[str] = Header(default=None, alias="X-QF-Admin-Preview-Tier")
):
    """Fetch live market news and sentiment analysis for selected tickers (Requires authenticated Member/Pro/Advisor)."""
    _, entitlements = _resolve_request_user_and_entitlements(authorization, x_qf_admin_preview_tier)
    if not entitlements.get("can_view_news", False):
        raise HTTPException(
            status_code=403,
            detail="กรุณาเข้าสู่ระบบหรือสมัครสมาชิกฟรีเพื่อดูข้อมูลวิเคราะห์ข่าวและสัญญาณตลาดรายสินทรัพย์"
        )
    ticker_list = []
    for t in tickers.split(","):
        s = t.strip().upper()
        if s and s not in ticker_list:
            ticker_list.append(s)
    if not ticker_list:
        return {"news": {}, "articles": []}
    news_map = _entitlement_guarded_fetch_news(ticker_list, force_refresh=bool(force))
    all_articles = []
    max_len = max((len(news_map.get(t, {}).get("articles", [])) for t in ticker_list), default=0)
    for idx in range(max_len):
        for t in ticker_list:
            arts = news_map.get(t, {}).get("articles", [])
            if idx < len(arts):
                all_articles.append(arts[idx])
    return {"news": news_map, "articles": all_articles}


@app.get("/api/system/verify")
def verify_system_integrity():
    """
    Run automated system diagnostics across all 6 core modules:
    1. Live Yahoo Finance Market Data & Treasury Rate
    2. Dual Currency Conversion Engine (THB <-> USD)
    3. Markowitz & HRP Weight Optimization (Sum = 100%)
    4. Max Drawdown Monetary Conversion Accuracy
    5. Market News & Technical Signal Engine (RSI/SMA/Sentiment)
    6. Auth & Portfolio Storage Persistence
    """
    checks = []
    try:
        rf = get_risk_free_rate()
        fx = get_usd_thb_rate()
        checks.append({
            "id": "fx_rf_feed",
            "name": "เชื่อมต่ออัตราแลกเปลี่ยน (USD/THB) และดอกเบี้ยอ้างอิง (^IRX)",
            "passed": (15.0 <= fx <= 80.0) and (0.0 <= rf <= 0.25),
            "detail": f"USD/THB = {fx:.2f} บาท/ดอลลาร์ | US 13W T-Bill = {rf * 100:.2f}%"
        })

        opt_res = run_portfolio_optimization(
            tickers=["NVDA", "AAPL", "MSFT"],
            start_date="2022-01-01",
            end_date="2024-01-01",
            budget=100000.0,
            currency="THB",
            fx_rate=fx,
            use_news_adjustment=True,
            bl_confidence=0.50
        )
        ms = opt_res["strategies"]["max_sharpe"]
        w_sum = sum(ms["weights"].values())
        bl_info = opt_res.get("black_litterman", {})
        bl_ok = bool(bl_info.get("posterior_returns")) and abs(sum(bl_info.get("posterior_weights", {}).values()) - 1.0) < 0.01
        checks.append({
            "id": "weight_constraints",
            "name": "สมการคำนวณสัดส่วนพอร์ต (Markowitz, HRP & Black-Litterman Weight Sum = 100%)",
            "passed": (abs(w_sum - 1.0) < 0.01) and bl_ok,
            "detail": f"ผลรวมน้ำหนักพอร์ต = {w_sum * 100:.2f}% | BL δ={bl_info.get('risk_aversion_delta', 2.5)}, Confidence={int(round(float(bl_info.get('confidence', 0.5)) * 100))}%"
        })

        dd_det = ms.get("drawdown_details", {})
        mdd_amt = ms["max_drawdown_amount"]
        min_rem = ms["min_capital_remaining"]
        peak_val = dd_det.get("peak_value", 100000.0)
        dd_ok = abs((peak_val - min_rem) - mdd_amt) <= 1.0 and mdd_amt >= 0.0
        checks.append({
            "id": "drawdown_monetary",
            "name": "การแปลง Max Drawdown (%) เป็นจำนวนเงินบาทและดอลลาร์ (Peak-to-Trough)",
            "passed": dd_ok,
            "detail": f"ยอดสูงสุด {peak_val:,.2f} บาท -> ย่อตัวสูงสุด -{mdd_amt:,.2f} บาท (จุดต่ำสุดรอบย่อตัว {min_rem:,.2f} บาท)"
        })

        stat0 = opt_res["asset_stats"][0]
        dual_curr_ok = ("price_thb" in stat0 and "price_usd" in stat0 and stat0["price_thb"] > 0 and stat0["price_usd"] > 0)
        checks.append({
            "id": "dual_currency_prices",
            "name": "ระบบแสดงราคาหุ้นสองสกุลเงิน (THB บาท <-> USD ดอลลาร์)",
            "passed": dual_curr_ok,
            "detail": f"{stat0['ticker']}: ราคา ${stat0['price_usd']:,.2f} USD = ฿{stat0['price_thb']:,.2f} THB"
        })

        mi = opt_res.get("market_intelligence", {})
        has_tech_and_news = ("technical" in stat0 and "decision" in stat0 and "news_adjusted_weights" in ms)
        checks.append({
            "id": "market_news_signal",
            "name": "ระบบดึงข่าวตลาดและวิเคราะห์สัญญาณซื้อขาย (News Sentiment & RSI/SMA)",
            "passed": has_tech_and_news,
            "detail": f"วิเคราะห์ข่าวตลาด {mi.get('total_articles_analyzed', 0)} ข่าว พร้อมคำนวณ RSI-14 และ SMA-50/200 รายตัว"
        })

        db = _load_db()
        checks.append({
            "id": "storage_db",
            "name": "ระบบฐานข้อมูลผู้ใช้งานและบันทึกพอร์ตการลงทุน",
            "passed": isinstance(db, dict) and "users" in db and "portfolios" in db,
            "detail": f"พร้อมใช้งาน (ผู้ใช้ {len(db.get('users', {}))} บัญชี | พอร์ตที่บันทึก {len(db.get('portfolios', []))} รายการ)"
        })

        all_passed = all(c["passed"] for c in checks)
        return {
            "status": "verified" if all_passed else "warning",
            "all_passed": all_passed,
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "checks": checks
        }
    except Exception as e:
        return {
            "status": "error",
            "all_passed": False,
            "error": str(e),
            "checks": checks
        }


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

_db_lock = threading.Lock()


def _get_db_file_path() -> str:
    local_path = os.path.join(BASE_DIR, "quantfolio_users_db.json")
    try:
        with open(local_path, "a", encoding="utf-8"):
            pass
        return local_path
    except Exception:
        return os.path.join(tempfile.gettempdir(), "quantfolio_users_db.json")


def _load_db() -> Dict[str, Any]:
    path = _get_db_file_path()
    seed_path = os.path.join(BASE_DIR, "quantfolio_users_db.json")
    target_path = path if os.path.exists(path) else (seed_path if os.path.exists(seed_path) else None)
    if not target_path:
        return {"users": {}, "portfolios": []}
    try:
        with open(target_path, "r", encoding="utf-8") as f:
            content = f.read().strip()
            if not content:
                return {"users": {}, "portfolios": [], "activation_codes": [], "upgrade_requests": []}
            data = json.loads(content)
            if "users" not in data or not isinstance(data["users"], dict):
                data["users"] = {}
            if "portfolios" not in data or not isinstance(data["portfolios"], list):
                data["portfolios"] = []
            if "activation_codes" not in data or not isinstance(data["activation_codes"], list):
                data["activation_codes"] = []
            if "upgrade_requests" not in data or not isinstance(data["upgrade_requests"], list):
                data["upgrade_requests"] = []
            return data
    except Exception:
        return {"users": {}, "portfolios": [], "activation_codes": [], "upgrade_requests": []}


def _save_db(data: Dict[str, Any]) -> None:
    """Atomic JSON write: serialize to temp file in same directory, fsync, then os.replace()."""
    path = os.path.abspath(_get_db_file_path())
    parent_dir = os.path.dirname(path) or "."
    tmp_path = None
    try:
        os.makedirs(parent_dir, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(prefix=".quantfolio_db_", suffix=".tmp", dir=parent_dir)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
        tmp_path = None
    except Exception as e:
        print(f"Notice: Could not write local DB ({e})")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def _get_repo():
    """Return active storage repository (Supabase on Production/Vercel with fail-fast; Local JSON on local/pytest)."""
    return build_repository(
        json_path_resolver=lambda: _get_db_file_path(),
        json_lock=_db_lock,
        json_seed_path=os.path.join(BASE_DIR, "quantfolio_users_db.json"),
    )


def _init_auth_secret() -> bytes:
    if is_production_runtime():
        # Defer strict validation until runtime call if env not set at import time
        env_sec = os.environ.get("QUANTFOLIO_AUTH_SECRET", "").strip()
        if env_sec:
            return env_sec.encode("utf-8")
        return b""
    return resolve_auth_secret_bytes(allow_temp_fallback=True)


_AUTH_SECRET_KEY = _init_auth_secret()
_AUTH_TOKEN_TTL_SECONDS = 86400 * 7  # 7 days


def _get_auth_secret_key() -> bytes:
    """Return HMAC signing key; fails fast with StorageConfigError (HTTP 503) on Production if missing."""
    if is_production_runtime():
        return resolve_auth_secret_bytes(allow_temp_fallback=False)
    env_sec = os.environ.get("QUANTFOLIO_AUTH_SECRET", "").strip()
    if env_sec:
        return env_sec.encode("utf-8")
    global _AUTH_SECRET_KEY
    if not _AUTH_SECRET_KEY:
        _AUTH_SECRET_KEY = resolve_auth_secret_bytes(allow_temp_fallback=True)
    return _AUTH_SECRET_KEY


def _create_auth_token(user_id: str, email: str) -> str:
    secret_key = _get_auth_secret_key()
    payload = {
        "sub": str(user_id),
        "email": normalize_email(email),
        "exp": int(time.time()) + _AUTH_TOKEN_TTL_SECONDS,
    }
    payload_b64 = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).decode("ascii").rstrip("=")
    sig = hmac.new(secret_key, payload_b64.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def _get_authenticated_user(authorization: Optional[str] = Header(default=None)) -> Dict[str, str]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="กรุณาเข้าสู่ระบบก่อนดำเนินการ")
    raw_token = authorization[7:].strip()
    if "." not in raw_token:
        raise HTTPException(status_code=401, detail="เซสชันไม่ถูกต้องหรือหมดอายุ")
    secret_key = _get_auth_secret_key()
    payload_b64, sig = raw_token.rsplit(".", 1)
    expected_sig = hmac.new(secret_key, payload_b64.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected_sig):
        raise HTTPException(status_code=401, detail="เซสชันไม่ถูกต้องหรือหมดอายุ")
    try:
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=401, detail="เซสชันไม่ถูกต้องหรือหมดอายุ")

    if int(payload.get("exp", 0)) < int(time.time()):
        raise HTTPException(status_code=401, detail="เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่")

    user_id = str(payload.get("sub") or "").strip()
    email = normalize_email(payload.get("email"))
    if not user_id or not email:
        raise HTTPException(status_code=401, detail="เซสชันไม่ถูกต้อง")

    repo = _get_repo()
    stored_user = repo.get_user_by_email(email)
    if not stored_user or str(stored_user.get("id")) != user_id:
        raise HTTPException(status_code=401, detail="ไม่พบบัญชีผู้ใช้งานของเซสชันนี้")

    return {"id": user_id, "email": email}


_DEFAULT_ADMIN_EMAILS = {"amontud31067@gmail.com"}

TIER_ENTITLEMENTS: Dict[str, Dict[str, Any]] = {
    "guest": {
        "plan_tier": "guest",
        "label_th": "โหมดทดลองใช้ (Guest)",
        "badge_text": "GUEST",
        "max_assets": 5,
        "max_saved_portfolios": 1,
        "can_view_news": False,
        "can_download_sim_pdf": False,
        "can_customize_bl_views": False,
        "can_whitelabel_advisor_pdf": False,
        "safe_bl_confidence_cap": 0.35,
    },
    "free": {
        "plan_tier": "free",
        "label_th": "สมาชิกทั่วไป (Member ฟรี)",
        "badge_text": "MEMBER",
        "max_assets": 8,
        "max_saved_portfolios": 3,
        "can_view_news": True,
        "can_download_sim_pdf": True,
        "can_customize_bl_views": False,
        "can_whitelabel_advisor_pdf": False,
        "safe_bl_confidence_cap": 0.35,
    },
    "pro": {
        "plan_tier": "pro",
        "label_th": "QuantFolio Pro (นักลงทุนรายย่อย)",
        "badge_text": "PRO",
        "max_assets": 15,
        "max_saved_portfolios": 20,
        "can_view_news": True,
        "can_download_sim_pdf": True,
        "can_customize_bl_views": True,
        "can_whitelabel_advisor_pdf": False,
        "safe_bl_confidence_cap": 1.00,
    },
    "advisor": {
        "plan_tier": "advisor",
        "label_th": "Advisor Pro (IC / IP White-label)",
        "badge_text": "ADVISOR PRO",
        "max_assets": 25,
        "max_saved_portfolios": 9999,
        "can_view_news": True,
        "can_download_sim_pdf": True,
        "can_customize_bl_views": True,
        "can_whitelabel_advisor_pdf": True,
        "safe_bl_confidence_cap": 1.00,
    },
}


_TIER_RANK: Dict[str, int] = {"guest": -1, "free": 0, "pro": 1, "advisor": 2}
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_redeem_fail_attempts: Dict[str, List[float]] = {}
_REDEEM_RATE_LIMIT_MAX = 10
_REDEEM_RATE_LIMIT_WINDOW = 900.0  # 15 minutes


def _is_admin_email(email: str) -> bool:
    clean = (email or "").strip().lower()
    if not clean:
        return False
    env_admins = {
        e.strip().lower()
        for e in os.environ.get("QUANTFOLIO_ADMIN_EMAILS", "").split(",")
        if e.strip()
    }
    return clean in _DEFAULT_ADMIN_EMAILS or clean in env_admins


def _get_pro_activation_code() -> str:
    return os.environ.get("QUANTFOLIO_PRO_CODE", "QF-PRO-2026").strip()


def _get_advisor_activation_code() -> str:
    return os.environ.get("QUANTFOLIO_ADVISOR_CODE", "QF-ADVISOR-2026").strip()


def _generate_secure_activation_code(plan_tier: str) -> str:
    prefix = "QF-ADV" if plan_tier == "advisor" else "QF-PRO"
    part1 = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(4))
    part2 = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(4))
    return f"{prefix}-{part1}-{part2}"


def _is_redeem_rate_limited(email: str, now_ts: float) -> bool:
    key = (email or "").strip().lower()
    recent = [t for t in _redeem_fail_attempts.get(key, []) if now_ts - t < _REDEEM_RATE_LIMIT_WINDOW]
    _redeem_fail_attempts[key] = recent
    return len(recent) >= _REDEEM_RATE_LIMIT_MAX


def _record_redeem_failure(email: str, now_ts: float) -> None:
    key = (email or "").strip().lower()
    recent = [t for t in _redeem_fail_attempts.get(key, []) if now_ts - t < _REDEEM_RATE_LIMIT_WINDOW]
    recent.append(now_ts)
    _redeem_fail_attempts[key] = recent


def _clear_redeem_failures(email: str) -> None:
    _redeem_fail_attempts.pop((email or "").strip().lower(), None)


def _parse_iso_utc(raw: Optional[str]) -> Optional[datetime]:
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _resolve_effective_plan_tier(
    stored: Dict[str, Any],
    now_utc: Optional[datetime] = None,
) -> Tuple[str, Optional[str], Optional[int], bool]:
    """
    Resolve effective plan_tier after checking plan_expires_at.
    Returns (effective_tier, plan_expires_at_iso, days_remaining, is_expired).
    """
    now_dt = now_utc or datetime.now(timezone.utc)
    raw_tier = str(stored.get("plan_tier") or "free").strip().lower()
    if raw_tier not in ("free", "pro", "advisor"):
        raw_tier = "free"

    exp_raw = stored.get("plan_expires_at")
    exp_dt = _parse_iso_utc(exp_raw)
    if raw_tier in ("pro", "advisor") and exp_dt is not None:
        if exp_dt <= now_dt:
            return "free", exp_dt.isoformat(), 0, True
        days_rem = max(1, int(math.ceil((exp_dt - now_dt).total_seconds() / 86400.0)))
        return raw_tier, exp_dt.isoformat(), days_rem, False

    if raw_tier in ("pro", "advisor"):
        return raw_tier, None, None, False
    return "free", None, None, False


def _compute_extended_expiry(
    stored: Dict[str, Any],
    target_tier: str,
    duration_days: int,
    now_utc: Optional[datetime] = None,
) -> Optional[str]:
    """
    Compute new plan_expires_at:
    - 'free' or duration_days <= 0 -> None (no expiry / lifetime)
    - Renewing the same active paid tier -> stacks onto existing plan_expires_at (or preserves lifetime)
    - Upgrading from free/expired or from pro -> advisor -> starts fresh from now + duration_days
    """
    now_dt = now_utc or datetime.now(timezone.utc)
    if target_tier == "free" or int(duration_days or 0) <= 0:
        return None

    eff_tier, exp_iso, _, is_exp = _resolve_effective_plan_tier(stored, now_dt)
    if eff_tier == target_tier and not is_exp:
        if exp_iso is None:
            return None
        existing_dt = _parse_iso_utc(exp_iso)
        base_dt = existing_dt if (existing_dt and existing_dt > now_dt) else now_dt
        return (base_dt + timedelta(days=int(duration_days))).isoformat()

    return (now_dt + timedelta(days=int(duration_days))).isoformat()


def _normalize_admin_preview_tier(raw_header: Optional[str]) -> Optional[str]:
    val = str(raw_header or "").strip().lower()
    if val in ("guest", "free", "pro", "advisor"):
        return val
    return None


def _require_admin_user(current_user: Dict[str, str]) -> str:
    """Strictly verify real Admin identity from server config/env (ignores preview tier headers)."""
    auth_email = (current_user.get("email") or "").strip().lower()
    if not _is_admin_email(auth_email):
        raise HTTPException(
            status_code=403,
            detail="เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่เข้าถึงและดำเนินการส่วนนี้ได้"
        )
    return auth_email


def _get_user_entitlements(plan_tier: str, custom_flags: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    norm_tier = str(plan_tier or "free").strip().lower()
    if norm_tier not in TIER_ENTITLEMENTS:
        norm_tier = "free"
    ent = dict(TIER_ENTITLEMENTS[norm_tier])
    if isinstance(custom_flags, dict):
        for k, v in custom_flags.items():
            if k in ent and v is not None:
                ent[k] = v
    return ent


def _build_user_response_obj(
    stored: Dict[str, Any],
    email: str,
    fallback_name: Optional[str] = None,
    admin_preview_tier: Optional[str] = None,
) -> Dict[str, Any]:
    clean_email = (email or "").strip().lower()
    display_name = stored.get("full_name") or fallback_name or (clean_email.split("@")[0] if clean_email else "ผู้ใช้งาน")
    avatar_url = stored.get("avatar_url") or _build_local_svg_avatar(display_name)
    eff_tier, exp_iso, days_rem, is_expired = _resolve_effective_plan_tier(stored)
    is_admin = _is_admin_email(clean_email)

    norm_preview = _normalize_admin_preview_tier(admin_preview_tier) if is_admin else None
    active_tier = norm_preview if norm_preview else eff_tier
    entitlements = _get_user_entitlements(
        active_tier,
        None if norm_preview else stored.get("entitlements")
    )
    return {
        "id": str(stored["id"]),
        "email": clean_email,
        "plan_tier": active_tier,
        "real_plan_tier": eff_tier,
        "preview_tier": norm_preview,
        "plan_expires_at": exp_iso,
        "days_remaining": days_rem,
        "is_expired": is_expired,
        "is_admin": is_admin,
        "entitlements": entitlements,
        "user_metadata": {
            "full_name": display_name,
            "name": display_name,
            "avatar_url": avatar_url,
            "plan_tier": active_tier,
            "real_plan_tier": eff_tier,
            "preview_tier": norm_preview,
            "plan_expires_at": exp_iso,
            "days_remaining": days_rem,
            "is_expired": is_expired,
            "is_admin": is_admin,
            "entitlements": entitlements,
        },
    }


def _resolve_request_user_and_entitlements(
    authorization: Optional[str] = None,
    admin_preview_tier: Optional[str] = None,
) -> Tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None, _get_user_entitlements("guest")
    try:
        auth_info = _get_authenticated_user(authorization)
        repo = _get_repo()
        stored = repo.get_user_by_email(auth_info["email"])
        if not stored:
            return None, _get_user_entitlements("guest")
        user_obj = _build_user_response_obj(
            stored,
            auth_info["email"],
            admin_preview_tier=admin_preview_tier,
        )
        return user_obj, user_obj["entitlements"]
    except HTTPException as he:
        if he.status_code >= 500:
            raise
        return None, _get_user_entitlements("guest")


class AuthLoginRequest(BaseModel):
    email: str
    password: str
    full_name: Optional[str] = None
    mode: str = "auto"  # 'signin' | 'signup' | 'auto'


class AuthProfileUpdateRequest(BaseModel):
    full_name: str


class AuthChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class AuthSubscriptionUpdateRequest(BaseModel):
    plan_tier: str  # 'free' | 'pro' | 'advisor'
    activation_code: Optional[str] = None
    duration_days: int = 0  # 0 = lifetime


class AuthRedeemCodeRequest(BaseModel):
    code: str


class UpgradeRequestCreate(BaseModel):
    target_tier: str  # 'pro' | 'advisor'
    duration_days: int = 30
    transfer_amount: str = ""
    transfer_datetime: str = ""
    account_last4: str = ""
    slip_ref: str = ""
    contact_note: str = ""


class AdminUpgradeDecisionRequest(BaseModel):
    decision: str  # 'approve' | 'reject'
    admin_note: str = ""
    duration_days: Optional[int] = None


class AdminCreateCodeRequest(BaseModel):
    plan_tier: str  # 'pro' | 'advisor'
    duration_days: int = 30  # 0 = lifetime
    max_uses: int = 1
    code_valid_days: int = 30  # 0 = no claim deadline
    custom_code: Optional[str] = None
    note: str = ""


class AdminSetUserTierRequest(BaseModel):
    target_email: str
    plan_tier: str  # 'free' | 'pro' | 'advisor'
    duration_days: int = 0  # 0 = lifetime; > 0 stacks if renewing same active tier
    expires_at: Optional[str] = None  # Explicit ISO-8601 expiry (naive treated as Asia/Bangkok UTC+7)
    reset_expiry: bool = False
    custom_entitlements: Optional[Dict[str, Any]] = None


class PortfolioSaveRequest(BaseModel):
    id: Optional[str] = None
    portfolio_name: str
    goal_type: str = "retirement"
    goal_label: str = "พอร์ตเกษียณมั่นคง"
    target_amount: float = 1000000.0
    initial_budget: float = 100000.0
    monthly_dca: float = 5000.0
    investment_period_years: int = 5
    currency: str = "THB"
    tickers: List[str] = Field(default_factory=list)
    asset_weights: Dict[str, float] = Field(default_factory=dict)
    strategy_key: str = "max_sharpe"
    expected_return: float = 0.0
    expected_volatility: float = 0.0
    dividend_yield: float = 0.0
    projected_final_value: float = 0.0
    goal_achievement_pct: float = 0.0


_login_attempts: Dict[str, List[float]] = {}
_LOGIN_RATE_LIMIT_MAX = 5
_LOGIN_RATE_LIMIT_WINDOW = 60.0  # 60 seconds
_IP_RATE_LIMIT_MAX = 30  # Max total failed attempts per IP across accounts per minute


def _get_client_ip(request: Request) -> str:
    """Extract client IP, inspecting X-Forwarded-For if behind a reverse proxy."""
    forwarded = request.headers.get("x-forwarded-for") or request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "127.0.0.1"


def _is_rate_limited(client_ip: str, email: str, now: float) -> bool:
    """
    Check rate limiting scoped to client IP and (client IP, email) pair.
    Prevents an attacker from locking out a legitimate user's account.
    """
    if len(_login_attempts) > 2000:
        expired_keys = [
            k for k, ts_list in _login_attempts.items()
            if not any(now - t < _LOGIN_RATE_LIMIT_WINDOW for t in ts_list)
        ]
        for k in expired_keys:
            _login_attempts.pop(k, None)

    ip_key = f"ip:{client_ip}"
    combo_key = f"combo:{client_ip}:{email}"
    
    recent_ip = [t for t in _login_attempts.get(ip_key, []) if now - t < _LOGIN_RATE_LIMIT_WINDOW]
    _login_attempts[ip_key] = recent_ip
    if len(recent_ip) >= _IP_RATE_LIMIT_MAX:
        return True

    recent_combo = [t for t in _login_attempts.get(combo_key, []) if now - t < _LOGIN_RATE_LIMIT_WINDOW]
    _login_attempts[combo_key] = recent_combo
    if len(recent_combo) >= _LOGIN_RATE_LIMIT_MAX:
        return True

    return False


def _record_failed_attempt(client_ip: str, email: str, now: float):
    ip_key = f"ip:{client_ip}"
    combo_key = f"combo:{client_ip}:{email}"
    _login_attempts.setdefault(ip_key, []).append(now)
    _login_attempts.setdefault(combo_key, []).append(now)


def _record_successful_attempt(client_ip: str, email: str):
    combo_key = f"combo:{client_ip}:{email}"
    _login_attempts.pop(combo_key, None)


def _hash_password(password: str, salt: Optional[str] = None) -> str:
    salt_str = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt_str.encode("utf-8"), 200_000).hex()
    return f"pbkdf2_sha256${salt_str}${dk}"


def _verify_password(password: str, stored_hash: str) -> Tuple[bool, bool]:
    """
    Verify password against stored_hash.
    Returns (is_valid, needs_rehash_upgrade).
    Only salted PBKDF2-SHA256 hashes are accepted. Legacy unsalted hashes are rejected.
    """
    if not stored_hash:
        return False, False
    if stored_hash.startswith("pbkdf2_sha256$"):
        parts = stored_hash.split("$")
        if len(parts) != 3:
            return False, False
        _, salt_str, expected_dk = parts
        candidate = _hash_password(password, salt=salt_str)
        return hmac.compare_digest(candidate, stored_hash), False
    # Legacy unsalted SHA-256 fallback removed for security
    return False, False


def _build_local_svg_avatar(name: str) -> str:
    """Generate a self-contained SVG data URI avatar without leaking user PII to third-party servers."""
    clean = (name or "QF").strip()
    initials = html.escape((clean[:2] if len(clean) >= 2 else clean).upper())
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
        f'<rect width="64" height="64" rx="32" fill="#00A86B"/>'
        f'<text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" '
        f'fill="#ffffff" font-family="sans-serif" font-size="24" font-weight="bold">{initials}</text>'
        f'</svg>'
    )
    b64 = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{b64}"


@app.post("/api/auth/login")
def backend_auth_login(req: AuthLoginRequest, request: Request):
    """
    ระบบยืนยันตัวตนหลักฝั่งเซิร์ฟเวอร์ (Salted PBKDF2-SHA256 + Rate Limit + Mode Check + Supabase/JSON Repository)
    """
    email = normalize_email(req.email)
    password = (req.password or "").strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="กรุณากรอกอีเมลให้ถูกต้อง")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร")

    client_ip = _get_client_ip(request)
    now = time.time()
    if _is_rate_limited(client_ip, email, now):
        raise HTTPException(
            status_code=429,
            detail="พยายามเข้าสู่ระบบผิดพลาดเกินจำนวนครั้งที่กำหนด กรุณารอ 1 นาทีแล้วลองใหม่อีกครั้ง"
        )

    repo = _get_repo()
    default_name = (req.full_name or "").strip() or email.split("@")[0]
    stored = repo.get_user_by_email(email)

    if stored is not None:
        if (req.mode or "").strip().lower() == "signup":
            raise HTTPException(
                status_code=409,
                detail="อีเมลนี้ถูกสมัครใช้งานแล้ว กรุณาสลับไปที่แท็บ 'เข้าสู่ระบบ'"
            )
        is_valid, needs_upgrade = _verify_password(password, stored.get("password_hash", ""))
        if not is_valid:
            _record_failed_attempt(client_ip, email, now)
            raise HTTPException(status_code=401, detail="รหัสผ่านไม่ถูกต้อง กรุณาตรวจสอบรหัสผ่านของคุณอีกครั้ง")

        _record_successful_attempt(client_ip, email)
        updates: Dict[str, Any] = {}
        if needs_upgrade:
            updates["password_hash"] = _hash_password(password)
        if (req.mode or "").strip().lower() != "signin" and req.full_name and req.full_name.strip():
            updates["full_name"] = req.full_name.strip()
        if not stored.get("avatar_url") or "ui-avatars.com" in str(stored.get("avatar_url", "")):
            updates["avatar_url"] = _build_local_svg_avatar(updates.get("full_name") or stored.get("full_name") or default_name)
        if updates:
            updates["updated_at"] = datetime.now(timezone.utc).isoformat()
            stored = repo.update_user_by_email(email, updates)

        user_id = str(stored["id"])
        user_obj = _build_user_response_obj(stored, email, fallback_name=default_name)
        token = _create_auth_token(user_id, email)
        return {"status": "ok", "action": "signed_in", "token": token, "user": user_obj}
    else:
        if (req.mode or "").strip().lower() == "signin":
            _record_failed_attempt(client_ip, email, now)
            raise HTTPException(
                status_code=401,
                detail="ไม่พบบัญชีผู้ใช้นี้ในระบบ กรุณาตรวจสอบอีเมลหรือสลับไปที่แท็บ 'สมัครสมาชิกใหม่'"
            )
        user_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"quantfolio:{email}"))
        avatar_url = _build_local_svg_avatar(default_name)
        new_user_rec = {
            "id": user_id,
            "email": email,
            "full_name": default_name,
            "avatar_url": avatar_url,
            "plan_tier": "free",
            "plan_expires_at": None,
            "is_admin": _is_admin_email(email),
            "password_hash": _hash_password(password),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            stored = repo.create_user(new_user_rec)
        except StorageConflictError:
            raise HTTPException(
                status_code=409,
                detail="อีเมลนี้ถูกสมัครใช้งานแล้ว กรุณาสลับไปที่แท็บ 'เข้าสู่ระบบ'"
            )
        repo.write_audit_log(
            action="user_signed_up",
            actor_user_id=user_id,
            actor_email=email,
            target_user_id=user_id,
            target_email=email,
            details={"plan_tier": "free"},
            ip_address=client_ip,
        )
        user_obj = _build_user_response_obj(stored, email, fallback_name=default_name)
        token = _create_auth_token(user_id, email)
        return {"status": "ok", "action": "signed_up", "token": token, "user": user_obj}


@app.get("/api/auth/me")
def get_backend_current_user(
    current_user: Dict[str, str] = Depends(_get_authenticated_user),
    x_qf_admin_preview_tier: Optional[str] = Header(default=None, alias="X-QF-Admin-Preview-Tier"),
):
    """Verify active HMAC session token and return fresh profile metadata + effective plan_tier & entitlements."""
    auth_email = normalize_email(current_user["email"])
    repo = _get_repo()
    stored = repo.get_user_by_email(auth_email)
    if not stored:
        raise HTTPException(status_code=401, detail="ไม่พบบัญชีผู้ใช้งานนี้ในระบบ")
    user_obj = _build_user_response_obj(
        stored,
        auth_email,
        admin_preview_tier=x_qf_admin_preview_tier,
    )
    return {"status": "ok", "user": user_obj}


@app.patch("/api/auth/profile")
def update_backend_profile(
    req: AuthProfileUpdateRequest,
    current_user: Dict[str, str] = Depends(_get_authenticated_user)
):
    """Update authenticated user's display name and regenerate local SVG initials avatar."""
    new_name = (req.full_name or "").strip()
    if len(new_name) < 1 or len(new_name) > 80:
        raise HTTPException(status_code=400, detail="ชื่อที่ใช้แสดงผลต้องมีความยาวระหว่าง 1–80 ตัวอักษร")

    auth_email = normalize_email(current_user["email"])
    repo = _get_repo()
    try:
        stored = repo.update_user_by_email(auth_email, {
            "full_name": new_name,
            "avatar_url": _build_local_svg_avatar(new_name),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
    except StorageNotFoundError:
        raise HTTPException(status_code=404, detail="ไม่พบบัญชีผู้ใช้งาน")
    user_obj = _build_user_response_obj(stored, auth_email)
    return {"status": "ok", "user": user_obj}


@app.post("/api/auth/redeem-code")
def redeem_activation_code(
    req: AuthRedeemCodeRequest,
    current_user: Dict[str, str] = Depends(_get_authenticated_user),
):
    """
    Redeem an Activation Code with strict 4-layer validation, Tier Change Guard, and brute-force rate limit.
    Uses atomic PostgreSQL RPC on Supabase (or locked JSON repo in local/pytest).
    """
    auth_email = normalize_email(current_user["email"])
    auth_user_id = str(current_user["id"])
    raw_code = normalize_code(req.code)
    now_ts = time.time()

    if _is_redeem_rate_limited(auth_email, now_ts):
        raise HTTPException(
            status_code=429,
            detail="คุณกรอกรหัสเปิดใช้งานผิดเกินจำนวนครั้งที่กำหนด (10 ครั้ง / 15 นาที) กรุณารอสักครู่แล้วลองใหม่อีกครั้ง"
        )

    if not raw_code or len(raw_code) < 4:
        _record_redeem_failure(auth_email, now_ts)
        raise HTTPException(status_code=400, detail="กรุณากรอกรหัสเปิดใช้งาน (Activation Code) ให้ครบถ้วน")

    repo = _get_repo()
    tier_labels = {k: v["label_th"] for k, v in TIER_ENTITLEMENTS.items()}
    res = repo.redeem_activation_code_atomic(
        user_id=auth_user_id,
        email=auth_email,
        raw_code=raw_code,
        tier_rank_map=_TIER_RANK,
        tier_labels=tier_labels,
    )
    if not res.get("ok"):
        err_code = str(res.get("error_code") or "")
        if err_code != "TIER_DOWNGRADE_BLOCKED":
            _record_redeem_failure(auth_email, now_ts)
        raise HTTPException(
            status_code=int(res.get("http_status") or 400),
            detail=str(res.get("error") or "ไม่สามารถใช้รหัสเปิดใช้งานนี้ได้"),
        )

    _clear_redeem_failures(auth_email)
    stored = res.get("user") or repo.get_user_by_email(auth_email) or {}
    target_tier = str(res.get("plan_tier") or "pro")
    duration_days = int(res.get("duration_days") or 0)
    new_expiry = res.get("plan_expires_at")
    if repo.backend_name == "json":
        repo.write_audit_log(
            action="activation_code_redeemed",
            actor_user_id=auth_user_id,
            actor_email=auth_email,
            target_user_id=auth_user_id,
            target_email=auth_email,
            details={"code": raw_code, "plan_tier": target_tier, "duration_days": duration_days, "plan_expires_at": new_expiry},
        )
    user_obj = _build_user_response_obj(stored, auth_email)

    return {
        "status": "ok",
        "user": user_obj,
        "applied_tier": target_tier,
        "duration_days": duration_days,
        "plan_expires_at": new_expiry,
    }


@app.post("/api/auth/subscription")
def update_backend_subscription(
    req: AuthSubscriptionUpdateRequest,
    current_user: Dict[str, str] = Depends(_get_authenticated_user)
):
    """
    Update user's subscription tier ('free' | 'pro' | 'advisor').
    - Real Admin accounts (verified via _is_admin_email) can switch directly when needed.
    - Non-admin accounts must provide a valid activation code (validated against DB codes or env codes).
    """
    target_tier = (req.plan_tier or "").strip().lower()
    if target_tier not in ("free", "pro", "advisor"):
        raise HTTPException(status_code=400, detail="แพ็กเกจที่ระบุไม่ถูกต้อง (รองรับเฉพาะ free, pro, advisor)")

    auth_email = normalize_email(current_user["email"])
    code_input = (req.activation_code or "").strip()
    now_utc = datetime.now(timezone.utc)
    repo = _get_repo()

    stored = repo.get_user_by_email(auth_email)
    if not stored:
        raise HTTPException(status_code=404, detail="ไม่พบบัญชีผู้ใช้งาน")

    is_admin = _is_admin_email(auth_email)
    duration_days = int(req.duration_days or 0)
    if target_tier in ("pro", "advisor") and not is_admin:
        if not code_input:
            raise HTTPException(
                status_code=403,
                detail="กรุณากรอกรหัสเปิดใช้งาน (Activation Code) ที่ได้รับจากผู้ดูแลระบบเพื่อปลดล็อกแพ็กเกจนี้"
            )
        pro_code = _get_pro_activation_code()
        adv_code = _get_advisor_activation_code()
        if target_tier == "pro":
            valid_code = hmac.compare_digest(code_input, pro_code) or hmac.compare_digest(code_input, adv_code)
        else:
            valid_code = hmac.compare_digest(code_input, adv_code)

        if not valid_code:
            raise HTTPException(
                status_code=403,
                detail="รหัสเปิดใช้งานไม่ถูกต้อง กรุณาตรวจสอบรหัสอีกครั้งหรือติดต่อผู้ดูแลระบบ"
            )

    new_expiry = _compute_extended_expiry(stored, target_tier, duration_days, now_utc)
    updated_stored = repo.update_user_by_email(auth_email, {
        "plan_tier": target_tier,
        "plan_expires_at": new_expiry,
        "updated_at": now_utc.isoformat(),
    })
    repo.write_audit_log(
        action="subscription_updated",
        actor_user_id=current_user["id"],
        actor_email=auth_email,
        target_user_id=current_user["id"],
        target_email=auth_email,
        details={"plan_tier": target_tier, "duration_days": duration_days, "plan_expires_at": new_expiry},
    )
    user_obj = _build_user_response_obj(updated_stored, auth_email)
    return {"status": "ok", "user": user_obj}


@app.post("/api/upgrade-requests")
def create_upgrade_request(
    req: UpgradeRequestCreate,
    current_user: Dict[str, str] = Depends(_get_authenticated_user),
):
    """
    Submit an upgrade / payment notification request into the Admin approval queue.
    - Authenticated members ONLY (Guest rejected with 401).
    - Email and user_id are strictly bound from the verified session token (NEVER accepted from request body).
    - Anti-spam: Max 1 'pending' request per account (enforced both in Repo & DB partial unique index -> 409).
    """
    auth_email = normalize_email(current_user["email"])
    auth_user_id = current_user["id"]
    target_tier = (req.target_tier or "").strip().lower()
    if target_tier not in ("pro", "advisor"):
        raise HTTPException(status_code=400, detail="กรุณาเลือกแพ็กเกจที่ต้องการอัปเกรด (Pro หรือ Advisor Pro)")

    duration_days = int(req.duration_days or 30)
    if duration_days not in (30, 90, 365):
        duration_days = 30

    transfer_amount = (req.transfer_amount or "").strip()[:60]
    transfer_datetime = (req.transfer_datetime or "").strip()[:60]
    account_last4 = (req.account_last4 or "").strip()[:20]
    slip_ref = (req.slip_ref or "").strip()[:300]
    contact_note = (req.contact_note or "").strip()[:300]

    if not transfer_amount or not transfer_datetime:
        raise HTTPException(
            status_code=400,
            detail="กรุณาระบุยอดเงินและวัน–เวลาที่โอนเงินให้ครบถ้วนเพื่อให้ผู้ดูแลตรวจสอบได้อย่างรวดเร็ว"
        )

    now_iso = datetime.now(timezone.utc).isoformat()
    repo = _get_repo()
    stored = repo.get_user_by_email(auth_email)
    if not stored:
        raise HTTPException(status_code=404, detail="ไม่พบบัญชีผู้ใช้งาน")

    new_req = {
        "id": str(uuid.uuid4()),
        "user_id": auth_user_id,
        "email": auth_email,
        "full_name": stored.get("full_name") or auth_email.split("@")[0],
        "target_tier": target_tier,
        "duration_days": duration_days,
        "transfer_amount": transfer_amount,
        "transfer_datetime": transfer_datetime,
        "account_last4": account_last4,
        "slip_ref": slip_ref,
        "contact_note": contact_note,
        "status": "pending",
        "admin_note": "",
        "created_at": now_iso,
        "decided_at": None,
        "decided_by": None,
    }
    try:
        saved_req = repo.create_upgrade_request(new_req)
    except StorageConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    repo.write_audit_log(
        action="upgrade_request_created",
        actor_user_id=auth_user_id,
        actor_email=auth_email,
        target_user_id=auth_user_id,
        target_email=auth_email,
        details={"request_id": saved_req["id"], "target_tier": target_tier, "duration_days": duration_days},
    )
    return {"status": "ok", "request": saved_req}


@app.get("/api/upgrade-requests/mine")
def list_my_upgrade_requests(current_user: Dict[str, str] = Depends(_get_authenticated_user)):
    """Return the authenticated user's own upgrade request history (newest first)."""
    auth_email = normalize_email(current_user["email"])
    repo = _get_repo()
    mine = repo.list_upgrade_requests(email=auth_email)
    return {"status": "ok", "requests": mine}


@app.delete("/api/upgrade-requests/{request_id}")
def cancel_my_upgrade_request(
    request_id: str,
    current_user: Dict[str, str] = Depends(_get_authenticated_user),
):
    """Allow an authenticated user to cancel their own still-pending upgrade request."""
    auth_email = normalize_email(current_user["email"])
    repo = _get_repo()
    try:
        repo.cancel_upgrade_request(request_id, auth_email)
    except StorageNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except StorageConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {"status": "ok", "cancelled_id": request_id}


@app.get("/api/admin/overview")
def admin_console_overview(current_user: Dict[str, str] = Depends(_get_authenticated_user)):
    """Owner/Admin unified console payload: all users, upgrade requests queue, and activation codes."""
    _require_admin_user(current_user)
    now_utc = datetime.now(timezone.utc)
    repo = _get_repo()

    port_counts = repo.count_portfolios_by_user()
    all_users = repo.list_users()
    user_list = []
    for u in all_users:
        em = normalize_email(u.get("email"))
        eff_tier, exp_iso, days_rem, is_exp = _resolve_effective_plan_tier(u, now_utc)
        uid = str(u.get("id", ""))
        user_list.append({
            "id": uid,
            "email": em,
            "full_name": u.get("full_name") or (em.split("@")[0] if em else "ผู้ใช้งาน"),
            "plan_tier": eff_tier,
            "stored_plan_tier": str(u.get("plan_tier") or "free").strip().lower(),
            "plan_expires_at": exp_iso,
            "days_remaining": days_rem,
            "is_expired": is_exp,
            "is_admin": _is_admin_email(em),
            "portfolio_count": port_counts.get(uid, 0),
            "created_at": u.get("created_at"),
            "updated_at": u.get("updated_at"),
        })
    user_list.sort(key=lambda x: str(x.get("created_at") or ""), reverse=True)

    reqs = repo.list_upgrade_requests()
    pending_reqs = sorted(
        [r for r in reqs if str(r.get("status")) == "pending"],
        key=lambda x: str(x.get("created_at") or ""),
        reverse=True,
    )
    other_reqs = sorted(
        [r for r in reqs if str(r.get("status")) != "pending"],
        key=lambda x: str(x.get("decided_at") or x.get("created_at") or ""),
        reverse=True,
    )
    ordered_reqs = pending_reqs + other_reqs

    codes = []
    for c in repo.list_activation_codes():
        c_copy = dict(c)
        code_exp_dt = _parse_iso_utc(c.get("code_expires_at"))
        c_copy["is_code_expired"] = bool(code_exp_dt is not None and code_exp_dt <= now_utc)
        c_copy["used_count"] = len(c.get("used_by") or [])
        codes.append(c_copy)
    codes.sort(key=lambda x: str(x.get("created_at") or ""), reverse=True)

    return {
        "status": "ok",
        "users": user_list,
        "upgrade_requests": ordered_reqs,
        "pending_requests_count": len(pending_reqs),
        "activation_codes": codes,
    }


@app.get("/api/admin/users")
def admin_list_users(current_user: Dict[str, str] = Depends(_get_authenticated_user)):
    """Owner/Admin endpoint to view registered users and their active plan tiers."""
    _require_admin_user(current_user)
    now_utc = datetime.now(timezone.utc)
    repo = _get_repo()
    user_list = []
    for u in repo.list_users():
        em = normalize_email(u.get("email"))
        eff_tier, exp_iso, days_rem, is_exp = _resolve_effective_plan_tier(u, now_utc)
        user_list.append({
            "id": str(u.get("id", "")),
            "email": em,
            "full_name": u.get("full_name") or (em.split("@")[0] if em else "ผู้ใช้งาน"),
            "plan_tier": eff_tier,
            "plan_expires_at": exp_iso,
            "days_remaining": days_rem,
            "is_expired": is_exp,
            "is_admin": _is_admin_email(em),
            "created_at": u.get("created_at"),
            "updated_at": u.get("updated_at"),
        })
    user_list.sort(key=lambda x: str(x.get("created_at") or ""), reverse=True)
    return {"status": "ok", "users": user_list}


_BANGKOK_TZ = timezone(timedelta(hours=7))


def _parse_admin_expiry_to_utc(raw: str) -> datetime:
    """Parse explicit ISO-8601 datetime from Admin; naive timestamps are interpreted in Thailand time (UTC+7)."""
    s = str(raw or "").strip()
    if not s:
        raise HTTPException(status_code=400, detail="กรุณาระบุวัน–เวลาหมดอายุให้ถูกต้อง")
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_BANGKOK_TZ)
        return dt.astimezone(timezone.utc)
    except Exception:
        raise HTTPException(status_code=400, detail="รูปแบบวัน–เวลาหมดอายุไม่ถูกต้อง (เช่น 2026-12-31T23:59)")


@app.post("/api/admin/set-user-tier")
def admin_set_user_tier(
    req: AdminSetUserTierRequest,
    current_user: Dict[str, str] = Depends(_get_authenticated_user)
):
    """Owner/Admin endpoint to assign 'free', 'pro', or 'advisor' tier + stacked duration OR explicit expiry datetime."""
    admin_email = _require_admin_user(current_user)
    target_email = normalize_email(req.target_email)
    target_tier = (req.plan_tier or "").strip().lower()
    if not target_email or "@" not in target_email:
        raise HTTPException(status_code=400, detail="กรุณาระบุอีเมลของลูกค้าให้ถูกต้อง")
    if target_tier not in ("free", "pro", "advisor"):
        raise HTTPException(status_code=400, detail="แพ็กเกจต้องเป็น free, pro หรือ advisor เท่านั้น")

    duration_days = max(0, int(req.duration_days or 0))
    explicit_exp_raw = (req.expires_at or "").strip()
    explicit_exp_dt = _parse_admin_expiry_to_utc(explicit_exp_raw) if (explicit_exp_raw and target_tier != "free") else None
    now_utc = datetime.now(timezone.utc)
    repo = _get_repo()

    target_stored = repo.get_user_by_email(target_email)
    if not target_stored:
        raise HTTPException(status_code=404, detail=f"ไม่พบบัญชีผู้ใช้ {target_email} ในระบบ")

    if target_tier == "free":
        new_expiry = None
    elif explicit_exp_dt is not None:
        new_expiry = explicit_exp_dt.isoformat()
    elif req.reset_expiry:
        new_expiry = (now_utc + timedelta(days=duration_days)).isoformat() if duration_days > 0 else None
    else:
        new_expiry = _compute_extended_expiry(target_stored, target_tier, duration_days, now_utc)

    updates: Dict[str, Any] = {
        "plan_tier": target_tier,
        "plan_expires_at": new_expiry,
        "updated_at": now_utc.isoformat(),
    }
    if isinstance(req.custom_entitlements, dict):
        updates["entitlements"] = req.custom_entitlements

    updated_stored = repo.update_user_by_email(target_email, updates)
    repo.write_audit_log(
        action="admin_set_user_tier",
        actor_user_id=current_user["id"],
        actor_email=admin_email,
        target_user_id=str(updated_stored.get("id") or ""),
        target_email=target_email,
        details={"plan_tier": target_tier, "plan_expires_at": new_expiry, "duration_days": duration_days},
    )
    updated_obj = _build_user_response_obj(updated_stored, target_email)
    return {"status": "ok", "user": updated_obj, "target_user": updated_obj}


@app.post("/api/admin/upgrade-requests/{request_id}/decide")
def admin_decide_upgrade_request(
    request_id: str,
    req: AdminUpgradeDecisionRequest,
    current_user: Dict[str, str] = Depends(_get_authenticated_user),
):
    """
    Idempotent Admin Approval/Rejection of a customer upgrade request.
    Uses atomic PostgreSQL RPC (FOR UPDATE) on Supabase or locked JSON repo locally -> 409 Conflict if already decided.
    """
    admin_email = _require_admin_user(current_user)
    decision = (req.decision or "").strip().lower()
    if decision not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="คำสั่งตัดสินต้องเป็น approve หรือ reject เท่านั้น")

    admin_note = (req.admin_note or "").strip()[:300]
    repo = _get_repo()
    res = repo.decide_upgrade_request_atomic(
        request_id=request_id,
        decision=decision,
        admin_email=admin_email,
        admin_note=admin_note,
        override_duration_days=max(0, int(req.duration_days)) if req.duration_days is not None else None,
    )
    if not res.get("ok"):
        raise HTTPException(
            status_code=int(res.get("http_status") or 400),
            detail=str(res.get("error") or "ไม่สามารถดำเนินการคำขอนี้ได้"),
        )

    req_rec = res.get("request")
    target_user_row = res.get("user")
    updated_user_obj = (
        _build_user_response_obj(target_user_row, normalize_email(target_user_row.get("email")))
        if isinstance(target_user_row, dict)
        else None
    )
    if repo.backend_name == "json":
        repo.write_audit_log(
            action=f"upgrade_request_{decision}d",
            actor_user_id=current_user["id"],
            actor_email=admin_email,
            target_user_id=str((req_rec or {}).get("user_id") or ""),
            target_email=normalize_email((req_rec or {}).get("email")),
            details={"request_id": request_id, "admin_note": admin_note},
        )
    return {
        "status": "ok",
        "request": req_rec,
        "target_user": updated_user_obj,
    }


@app.post("/api/admin/codes")
def admin_create_activation_code(
    req: AdminCreateCodeRequest,
    current_user: Dict[str, str] = Depends(_get_authenticated_user),
):
    """Owner/Admin endpoint to generate a cryptographically secure Activation Code stored in DB."""
    admin_email = _require_admin_user(current_user)
    plan_tier = (req.plan_tier or "").strip().lower()
    if plan_tier not in ("pro", "advisor"):
        raise HTTPException(status_code=400, detail="แพ็กเกจของรหัสต้องเป็น pro หรือ advisor เท่านั้น")

    duration_days = max(0, int(req.duration_days or 0))
    max_uses = max(1, min(10000, int(req.max_uses or 1)))
    code_valid_days = max(0, int(req.code_valid_days or 0))
    note = (req.note or "").strip()[:200]
    now_utc = datetime.now(timezone.utc)
    code_expires_at = (
        (now_utc + timedelta(days=code_valid_days)).isoformat()
        if code_valid_days > 0
        else None
    )

    repo = _get_repo()
    if req.custom_code and req.custom_code.strip():
        clean_custom = normalize_code(req.custom_code)
        if len(clean_custom) < 8 or len(clean_custom) > 40 or not all(ch.isalnum() or ch in "-_" for ch in clean_custom):
            raise HTTPException(
                status_code=400,
                detail="รหัสกำหนดเองต้องมีความยาว 8–40 ตัวอักษร และใช้ได้เฉพาะ A-Z, 0-9, '-' หรือ '_'"
            )
        final_code = clean_custom
    else:
        existing_codes = {normalize_code(c.get("code")) for c in repo.list_activation_codes()}
        final_code = _generate_secure_activation_code(plan_tier)
        while final_code in existing_codes:
            final_code = _generate_secure_activation_code(plan_tier)

    code_record = {
        "id": str(uuid.uuid4()),
        "code": final_code,
        "plan_tier": plan_tier,
        "duration_days": duration_days,
        "max_uses": max_uses,
        "code_expires_at": code_expires_at,
        "used_by": [],
        "revoked": False,
        "revoked_at": None,
        "revoked_by": None,
        "note": note,
        "created_by": admin_email,
        "created_at": now_utc.isoformat(),
    }
    try:
        saved_code = repo.create_activation_code(code_record)
    except StorageConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    repo.write_audit_log(
        action="admin_code_created",
        actor_user_id=current_user["id"],
        actor_email=admin_email,
        details={"code": saved_code["code"], "plan_tier": plan_tier, "duration_days": duration_days, "max_uses": max_uses},
    )
    return {"status": "ok", "code": saved_code}


@app.post("/api/admin/codes/{code_id}/revoke")
def admin_revoke_activation_code(
    code_id: str,
    current_user: Dict[str, str] = Depends(_get_authenticated_user),
):
    """Owner/Admin endpoint to immediately revoke an Activation Code."""
    admin_email = _require_admin_user(current_user)
    repo = _get_repo()
    try:
        code_rec = repo.revoke_activation_code(code_id, admin_email)
    except StorageNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    repo.write_audit_log(
        action="admin_code_revoked",
        actor_user_id=current_user["id"],
        actor_email=admin_email,
        details={"code_id": code_id, "code": code_rec.get("code")},
    )
    return {"status": "ok", "code": code_rec}


@app.post("/api/auth/change-password")
def change_backend_password(
    req: AuthChangePasswordRequest,
    current_user: Dict[str, str] = Depends(_get_authenticated_user)
):
    """Verify current password, enforce >= 8 chars, store salted PBKDF2-SHA256 hash, and rotate token."""
    current_pw = (req.current_password or "").strip()
    new_pw = (req.new_password or "").strip()
    if len(new_pw) < 8:
        raise HTTPException(status_code=400, detail="รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร")
    if current_pw == new_pw:
        raise HTTPException(status_code=400, detail="รหัสผ่านใหม่ต้องแตกต่างจากรหัสผ่านเดิม")

    auth_email = normalize_email(current_user["email"])
    repo = _get_repo()
    stored = repo.get_user_by_email(auth_email)
    if not stored:
        raise HTTPException(status_code=404, detail="ไม่พบบัญชีผู้ใช้งาน")
    is_valid, _ = _verify_password(current_pw, stored.get("password_hash", ""))
    if not is_valid:
        raise HTTPException(status_code=401, detail="รหัสผ่านปัจจุบันไม่ถูกต้อง")
    repo.update_user_by_email(auth_email, {
        "password_hash": _hash_password(new_pw),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    repo.write_audit_log(
        action="password_changed",
        actor_user_id=str(stored["id"]),
        actor_email=auth_email,
        target_user_id=str(stored["id"]),
        target_email=auth_email,
    )
    new_token = _create_auth_token(str(stored["id"]), auth_email)
    return {"status": "ok", "token": new_token}


@app.delete("/api/auth/account")
def delete_backend_account(current_user: Dict[str, str] = Depends(_get_authenticated_user)):
    """Delete the authenticated user's account and all associated portfolios (PDPA Right to Erasure)."""
    auth_user_id = current_user["id"]
    auth_email = normalize_email(current_user["email"])
    repo = _get_repo()
    removed_portfolios = repo.delete_user_and_portfolios(auth_user_id, auth_email)
    repo.write_audit_log(
        action="account_deleted",
        actor_user_id=auth_user_id,
        actor_email=auth_email,
        target_user_id=auth_user_id,
        target_email=auth_email,
        details={"deleted_portfolios": removed_portfolios},
    )
    return {"status": "ok", "deleted_user": auth_email, "deleted_portfolios": removed_portfolios}


@app.get("/api/portfolios")
def get_backend_portfolios(current_user: Dict[str, str] = Depends(_get_authenticated_user)):
    repo = _get_repo()
    items = repo.list_portfolios(current_user["id"])
    return {"portfolios": items}


@app.get("/api/portfolios/{portfolio_id}")
def get_backend_portfolio_by_id(portfolio_id: str, current_user: Dict[str, str] = Depends(_get_authenticated_user)):
    repo = _get_repo()
    item = repo.get_portfolio(current_user["id"], portfolio_id)
    if item is None:
        raise HTTPException(status_code=404, detail="ไม่พบพอร์ตการลงทุนที่ระบุ")
    return {"portfolio": item}


def _build_portfolio_record(req: PortfolioSaveRequest, item_id: str, current_user: Dict[str, str]) -> Dict[str, Any]:
    return {
        "id": item_id,
        "user_id": current_user["id"],
        "email": normalize_email(current_user["email"]),
        "portfolio_name": req.portfolio_name.strip(),
        "goal_type": req.goal_type,
        "goal_label": req.goal_label,
        "target_amount": req.target_amount,
        "initial_budget": req.initial_budget,
        "monthly_dca": req.monthly_dca,
        "investment_period_years": req.investment_period_years,
        "currency": req.currency,
        "tickers": req.tickers or list(req.asset_weights.keys()),
        "asset_weights": req.asset_weights,
        "strategy_key": req.strategy_key,
        "expected_return": req.expected_return,
        "expected_volatility": req.expected_volatility,
        "dividend_yield": req.dividend_yield,
        "projected_final_value": req.projected_final_value,
        "goal_achievement_pct": req.goal_achievement_pct,
        "created_at": datetime.now(timezone.utc).isoformat()
    }


@app.post("/api/portfolios")
def save_backend_portfolio(
    req: PortfolioSaveRequest,
    current_user: Dict[str, str] = Depends(_get_authenticated_user),
    x_qf_admin_preview_tier: Optional[str] = Header(default=None, alias="X-QF-Admin-Preview-Tier"),
):
    auth_user_id = current_user["id"]
    auth_email = normalize_email(current_user["email"])
    repo = _get_repo()
    stored_user = repo.get_user_by_email(auth_email) or {}
    eff_tier, _, _, _ = _resolve_effective_plan_tier(stored_user)
    norm_preview = _normalize_admin_preview_tier(x_qf_admin_preview_tier) if _is_admin_email(auth_email) else None
    active_tier = norm_preview if norm_preview else eff_tier
    user_ent = _get_user_entitlements(
        active_tier,
        None if norm_preview else stored_user.get("entitlements")
    )
    max_portfolios = int(user_ent.get("max_saved_portfolios", 3))
    quota_msg = (
        f"แพ็กเกจปัจจุบันของคุณ ({user_ent['label_th']}) บันทึกแผนพอร์ตได้สูงสุด {max_portfolios} แผน "
        f"กรุณาอัปเกรดเป็น QuantFolio Pro หรือ Advisor Pro เพื่อบันทึกแผนเพิ่มเติม"
    )
    record = _build_portfolio_record(req, str(req.id) if req.id is not None else str(uuid.uuid4()), current_user)
    try:
        saved_item = repo.save_portfolio(
            user_id=auth_user_id,
            record=record,
            explicit_id=str(req.id) if req.id is not None else None,
            max_portfolios=max_portfolios,
            quota_error_detail=quota_msg,
        )
    except StorageNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    return {"status": "ok", "portfolio": saved_item}


@app.put("/api/portfolios/{portfolio_id}")
def update_backend_portfolio(
    portfolio_id: str,
    req: PortfolioSaveRequest,
    current_user: Dict[str, str] = Depends(_get_authenticated_user),
):
    repo = _get_repo()
    updated_record = _build_portfolio_record(req, str(portfolio_id), current_user)
    try:
        updated_item = repo.save_portfolio(
            user_id=current_user["id"],
            record=updated_record,
            explicit_id=str(portfolio_id),
        )
    except StorageNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"status": "ok", "portfolio": updated_item}


@app.delete("/api/portfolios/{portfolio_id}")
def delete_backend_portfolio(portfolio_id: str, current_user: Dict[str, str] = Depends(_get_authenticated_user)):
    repo = _get_repo()
    deleted = repo.delete_portfolio(current_user["id"], portfolio_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="ไม่พบพอร์ตการลงทุนที่ระบุ")
    return {"status": "ok", "deleted": 1}



PUBLIC_ROOT_ALLOWLIST = frozenset({
    "index.html",
    "app.js",
    "styles.css",
    "supabase_auth.js",
    "quantfolio-logo.svg",
})


def _find_asset(filename: str) -> Optional[str]:
    """Find a public asset. Checks static/ first, and falls back to project root
    ONLY for exact matches in PUBLIC_ROOT_ALLOWLIST.

    Source code, config, and quantfolio_users_db.json in root are never exposed
    and traversal paths cannot pass exact-string allowlist checks or escape bounds.
    """
    try:
        base = os.path.realpath(STATIC_DIR)
        candidate = os.path.realpath(os.path.join(base, filename))
        if candidate.startswith(base + os.sep) and os.path.isfile(candidate):
            return candidate
    except (ValueError, OSError):
        return None
    if filename in PUBLIC_ROOT_ALLOWLIST:
        try:
            root_base = os.path.realpath(BASE_DIR)
            root_candidate = os.path.realpath(os.path.join(root_base, filename))
            if root_candidate.startswith(root_base + os.sep) and os.path.isfile(root_candidate):
                return root_candidate
        except (ValueError, OSError):
            return None
    return None


NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0"
}


_BUILTIN_QUANTFOLIO_LOGO_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" fill="none">
  <!-- Solid Institutional Emerald Brand Squircle (#059669 Light Primary) -->
  <rect id="qf-logo-frame" x="2" y="2" width="68" height="68" rx="18" fill="#059669"/>
  <rect x="2.75" y="2.75" width="66.5" height="66.5" rx="17.25" stroke="#FFFFFF" stroke-opacity="0.16" stroke-width="1.5"/>
  <!-- Subtle White Baseline -->
  <line x1="16" y1="54.5" x2="56" y2="54.5" stroke="#FFFFFF" stroke-opacity="0.32" stroke-width="1.5" stroke-linecap="round"/>
  <!-- Ascending Quantitative Bars (Pure White Tiered Opacity) -->
  <rect x="18.5" y="40" width="8.5" height="13.5" rx="3" fill="#FFFFFF" fill-opacity="0.68"/>
  <rect x="31.75" y="31.5" width="8.5" height="22" rx="3" fill="#FFFFFF" fill-opacity="0.86"/>
  <rect x="45" y="23.5" width="8.5" height="30" rx="3" fill="#FFFFFF"/>
  <!-- Crisp Rising Quantitative Curve & Target Node -->
  <path d="M18.5 34.5 C25.5 32.5 31 26.2 37.2 24.8 C43.2 23.4 47.4 19 52.2 16" stroke="#FFFFFF" stroke-width="2.75" stroke-linecap="round"/>
  <circle cx="52.2" cy="16" r="3.4" fill="#FFFFFF"/>
</svg>"""


@app.get("/static/{filename:path}")
def serve_static_file(filename: str):
    path = _find_asset(filename)
    if path:
        media_type = "image/svg+xml" if str(filename).lower().endswith(".svg") else None
        return FileResponse(path, media_type=media_type, headers=NO_CACHE_HEADERS)
    if os.path.basename(str(filename)) == "quantfolio-logo.svg":
        return Response(content=_BUILTIN_QUANTFOLIO_LOGO_SVG, media_type="image/svg+xml", headers=NO_CACHE_HEADERS)
    raise HTTPException(status_code=404, detail=f"File {filename} not found")


@app.get("/quantfolio-logo.svg")
def serve_root_logo_svg():
    path = _find_asset("quantfolio-logo.svg")
    if path:
        return FileResponse(path, media_type="image/svg+xml", headers=NO_CACHE_HEADERS)
    return Response(content=_BUILTIN_QUANTFOLIO_LOGO_SVG, media_type="image/svg+xml", headers=NO_CACHE_HEADERS)


@app.get("/styles.css")
def serve_root_css():
    path = _find_asset("styles.css")
    if path:
        return FileResponse(path, media_type="text/css", headers=NO_CACHE_HEADERS)
    raise HTTPException(status_code=404)


@app.get("/app.js")
def serve_root_js():
    path = _find_asset("app.js")
    if path:
        return FileResponse(path, media_type="application/javascript", headers=NO_CACHE_HEADERS)
    raise HTTPException(status_code=404)


@app.get("/supabase_auth.js")
def serve_root_supabase_js():
    path = _find_asset("supabase_auth.js")
    if path:
        return FileResponse(path, media_type="application/javascript", headers=NO_CACHE_HEADERS)
    raise HTTPException(status_code=404)


@app.get("/")
def serve_index():
    path = _find_asset("index.html")
    if path:
        return FileResponse(path, media_type="text/html", headers=NO_CACHE_HEADERS)
    return HTMLResponse(
        "<h2>QuantFolio Server is running, but index.html was not found in static/ or app root. Please upload index.html, app.js, styles.css, and supabase_auth.js (and/or static/).</h2>"
    )


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
