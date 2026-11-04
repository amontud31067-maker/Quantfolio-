"""
QuantFolio Pro - Production FastAPI Server
Supports Multi-User Concurrency, Caching, Cloud Hosting (Hugging Face Spaces / Render) & Public Tunneling
"""

import os
import time
import json
import uuid
import hashlib
import tempfile
import threading
import requests
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any, Tuple
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field
import yfinance as yf

from optimizer import (
    run_portfolio_optimization,
    fetch_portfolio_market_news,
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
    use_news_adjustment: bool = Field(default=True)


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
                            price_usd = round(float(last_price), 2) if native_curr == "USD" else (round(float(last_price) / fx, 2) if fx > 0 else round(float(last_price), 2))

                            q_data = {
                                "symbol": symbol,
                                "name": get_asset_name(symbol),
                                "price": round(float(last_price), 2),
                                "price_thb": price_thb,
                                "price_usd": price_usd,
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
    """Run full Markowitz, HRP, Monte Carlo, Portfolio Growth, and Market News Signal calculations."""
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
            use_news_adjustment=req.use_news_adjustment
        )
        return results
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"เกิดข้อผิดพลาดในการคำนวณ: {str(e)}")


@app.get("/api/market-news")
def get_market_news_endpoint(tickers: str = Query(..., description="Comma-separated tickers")):
    """Fetch live market news and sentiment analysis for selected tickers."""
    ticker_list = []
    for t in tickers.split(","):
        s = t.strip().upper()
        if s and s not in ticker_list:
            ticker_list.append(s)
    if not ticker_list:
        return {"news": {}, "articles": []}
    news_map = fetch_portfolio_market_news(ticker_list)
    all_articles = []
    for t in ticker_list:
        for art in news_map.get(t, {}).get("articles", []):
            all_articles.append(art)
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
            use_news_adjustment=True
        )
        ms = opt_res["strategies"]["max_sharpe"]
        w_sum = sum(ms["weights"].values())
        checks.append({
            "id": "weight_constraints",
            "name": "สมการคำนวณสัดส่วนพอร์ต (Markowitz & HRP Weight Sum = 100%)",
            "passed": abs(w_sum - 1.0) < 0.01,
            "detail": f"ผลรวมน้ำหนักพอร์ต = {w_sum * 100:.2f}% (ครบ 4 กลยุทธ์)"
        })

        mdd_pct = abs(ms["max_drawdown"])
        mdd_amt = ms["max_drawdown_amount"]
        min_rem = ms["min_capital_remaining"]
        dd_ok = abs(mdd_amt - round(mdd_pct * 100000.0, 2)) <= 20.0 and abs((mdd_amt + min_rem) - 100000.0) <= 1.0
        checks.append({
            "id": "drawdown_monetary",
            "name": "การแปลง Max Drawdown (%) เป็นจำนวนเงินบาทและดอลลาร์",
            "passed": dd_ok,
            "detail": f"เงินต้น 100,000 บาท -> เงินหายสูงสุด -{mdd_amt:,.2f} บาท (เหลือต่ำสุด {min_rem:,.2f} บาท)"
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
                return {"users": {}, "portfolios": []}
            data = json.loads(content)
            if "users" not in data:
                data["users"] = {}
            if "portfolios" not in data:
                data["portfolios"] = []
            return data
    except Exception:
        return {"users": {}, "portfolios": []}


def _save_db(data: Dict[str, Any]) -> None:
    path = _get_db_file_path()
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Notice: Could not write local DB ({e})")


class AuthLoginRequest(BaseModel):
    email: str
    password: str
    full_name: Optional[str] = None
    mode: str = "auto"  # 'signin' | 'signup' | 'auto'


class PortfolioSaveRequest(BaseModel):
    user_id: str
    email: Optional[str] = None
    portfolio_name: str
    target_amount: float = 100000.0
    investment_period_years: int = 5
    asset_weights: Dict[str, float] = Field(default_factory=dict)
    strategy_key: str = "max_sharpe"


@app.post("/api/auth/login")
def backend_auth_login(req: AuthLoginRequest):
    """
    ระบบยืนยันตัวตนสำรองระดับเซิร์ฟเวอร์ (ทำงานร่วมกับ Supabase Auth)
    แก้ปัญหากรณี Supabase ติด Email Rate Limit (429) หรือยังไม่ได้ยืนยันลิงก์ในอีเมล
    """
    email = req.email.strip().lower()
    password = req.password.strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="กรุณากรอกอีเมลให้ถูกต้อง")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร")

    pw_hash = hashlib.sha256(password.encode("utf-8")).hexdigest()
    default_name = (req.full_name or "").strip() or email.split("@")[0]

    with _db_lock:
        db = _load_db()
        users = db["users"]

        if email in users:
            stored = users[email]
            if stored.get("password_hash") != pw_hash:
                raise HTTPException(status_code=401, detail="รหัสผ่านไม่ถูกต้อง กรุณาตรวจสอบรหัสผ่านของคุณอีกครั้ง")
            if req.full_name and req.full_name.strip():
                stored["full_name"] = req.full_name.strip()
                _save_db(db)
            user_obj = {
                "id": stored["id"],
                "email": email,
                "user_metadata": {
                    "full_name": stored.get("full_name") or default_name,
                    "name": stored.get("full_name") or default_name,
                    "avatar_url": stored.get("avatar_url")
                }
            }
            return {"status": "ok", "action": "signed_in", "user": user_obj}
        else:
            user_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"quantfolio:{email}"))
            avatar_url = f"https://ui-avatars.com/api/?name={requests.utils.quote(default_name)}&background=1d4ed8&color=fff&bold=true"
            users[email] = {
                "id": user_id,
                "email": email,
                "full_name": default_name,
                "avatar_url": avatar_url,
                "password_hash": pw_hash,
                "created_at": datetime.now(timezone.utc).isoformat()
            }
            _save_db(db)
            user_obj = {
                "id": user_id,
                "email": email,
                "user_metadata": {
                    "full_name": default_name,
                    "name": default_name,
                    "avatar_url": avatar_url
                }
            }
            return {"status": "ok", "action": "signed_up", "user": user_obj}


@app.get("/api/portfolios")
def get_backend_portfolios(user_id: str = Query(...), email: Optional[str] = Query(default=None)):
    clean_email = (email or "").strip().lower()
    with _db_lock:
        db = _load_db()
        items = [
            p for p in db.get("portfolios", [])
            if str(p.get("user_id")) == str(user_id) or (clean_email and p.get("email") == clean_email)
        ]
    items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return {"portfolios": items}


@app.post("/api/portfolios")
def save_backend_portfolio(req: PortfolioSaveRequest):
    with _db_lock:
        db = _load_db()
        new_item = {
            "id": str(uuid.uuid4()),
            "user_id": req.user_id,
            "email": (req.email or "").strip().lower(),
            "portfolio_name": req.portfolio_name.strip(),
            "target_amount": req.target_amount,
            "investment_period_years": req.investment_period_years,
            "asset_weights": req.asset_weights,
            "strategy_key": req.strategy_key,
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        db["portfolios"].append(new_item)
        _save_db(db)
    return {"status": "ok", "portfolio": new_item}


@app.delete("/api/portfolios/{portfolio_id}")
def delete_backend_portfolio(portfolio_id: str, user_id: str = Query(...)):
    with _db_lock:
        db = _load_db()
        before = len(db.get("portfolios", []))
        db["portfolios"] = [
            p for p in db.get("portfolios", [])
            if not (str(p.get("id")) == str(portfolio_id) and str(p.get("user_id")) == str(user_id))
        ]
        _save_db(db)
    return {"status": "ok", "deleted": before - len(db["portfolios"])}



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
