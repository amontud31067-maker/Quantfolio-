"""
QuantFolio Pro - Production FastAPI Server
Supports Multi-User Concurrency, Caching, Cloud Hosting (Hugging Face Spaces / Render) & Public Tunneling
"""

import os
import time
import requests
from typing import List, Optional, Dict, Any, Tuple
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field
import yfinance as yf

from optimizer import (
    run_portfolio_optimization,
    get_risk_free_rate,
    get_usd_thb_rate,
    get_ticker_currency,
    get_asset_name,
    _yf_lock
)

app = FastAPI(
    title="QuantFolio Wealth Analytics API",
    description="Real-time Financial Portfolio Optimization Engine",
    version="2.3.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Multi-user in-memory caches
_quote_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_search_cache: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}
QUOTE_CACHE_TTL = 45    # 45 seconds
SEARCH_CACHE_TTL = 600  # 10 minutes


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


@app.get("/api/health")
def health_check():
    return {"status": "ok", "app": "QuantFolio Wealth Analytics", "version": "2.3.0"}


@app.get("/api/rf")
def fetch_risk_free_rate():
    """Fetch current 13-week US Treasury Bill rate (^IRX) and USD/THB exchange rate"""
    rate = get_risk_free_rate()
    fx = get_usd_thb_rate()
    return {
        "risk_free_rate": rate,
        "percentage": f"{rate * 100:.2f}%",
        "usd_thb_rate": fx
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


@app.get("/api/quote")
def get_realtime_quotes(tickers: str = Query(..., description="Comma-separated tickers")):
    """Get real-time quotes, latest price, and day change for selected tickers"""
    ticker_list = []
    for t in tickers.split(","):
        s = t.strip().upper()
        if s and s not in ticker_list:
            ticker_list.append(s)

    if not ticker_list:
        return {"quotes": {}}

    now = time.time()
    quotes = {}
    to_fetch = []

    for symbol in ticker_list:
        if symbol in _quote_cache:
            ts, cached_q = _quote_cache[symbol]
            if now - ts < QUOTE_CACHE_TTL:
                quotes[symbol] = cached_q
                continue
        to_fetch.append(symbol)

    if to_fetch:
        fx = get_usd_thb_rate()
        try:
            with _yf_lock:
                t_objs = yf.Tickers(" ".join(to_fetch))
                for symbol in to_fetch:
                    try:
                        t = t_objs.tickers.get(symbol)
                        if not t:
                            continue
                        info = t.fast_info
                        last_price = getattr(info, 'last_price', None)
                        prev_close = getattr(info, 'previous_close', None)
                        currency = getattr(info, 'currency', get_ticker_currency(symbol))

                        if last_price is not None:
                            chg = 0.0
                            chg_pct = 0.0
                            if prev_close and prev_close > 0:
                                chg = last_price - prev_close
                                chg_pct = (chg / prev_close) * 100.0

                            native_curr = get_ticker_currency(symbol)
                            price_thb = round(float(last_price) * fx, 2) if native_curr == "USD" else round(float(last_price), 2)

                            q_data = {
                                "symbol": symbol,
                                "name": get_asset_name(symbol),
                                "price": round(float(last_price), 2),
                                "price_thb": price_thb,
                                "prev_close": round(float(prev_close), 2) if prev_close else None,
                                "change": round(float(chg), 2),
                                "change_pct": round(float(chg_pct), 2),
                                "currency": native_curr
                            }
                            quotes[symbol] = q_data
                            _quote_cache[symbol] = (now, q_data)
                    except Exception as item_err:
                        quotes[symbol] = {"symbol": symbol, "name": get_asset_name(symbol), "error": str(item_err)}
        except Exception as e:
            return {"quotes": quotes, "error": str(e)}

    return {"quotes": quotes, "usd_thb_rate": get_usd_thb_rate()}


@app.post("/api/optimize")
def optimize_portfolio(req: OptimizeRequest):
    """Run full Markowitz, HRP, Monte Carlo, and Portfolio Growth calculations."""
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
            fx_rate=req.fx_rate
        )
        return results
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"เกิดข้อผิดพลาดในการคำนวณ: {str(e)}")


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")


def _find_asset(filename: str) -> Optional[str]:
    """Find static asset whether uploaded inside static/ folder or flat in root folder."""
    p1 = os.path.join(STATIC_DIR, filename)
    if os.path.exists(p1):
        return p1
    p2 = os.path.join(BASE_DIR, filename)
    if os.path.exists(p2):
        return p2
    return None


NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0"
}


@app.get("/static/{filename:path}")
def serve_static_file(filename: str):
    path = _find_asset(filename)
    if path:
        return FileResponse(path, headers=NO_CACHE_HEADERS)
    raise HTTPException(status_code=404, detail=f"File {filename} not found")


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
        "<h2>QuantFolio Server is running, but index.html was not found. Please upload index.html, app.js, and styles.css.</h2>"
    )


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
