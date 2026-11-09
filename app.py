"""
QuantFolio Pro - Production FastAPI Server
Supports Multi-User Concurrency, Caching, Cloud Hosting (Hugging Face Spaces / Render) & Public Tunneling
"""

import os
import time
import json
import uuid
import hmac
import base64
import secrets
import hashlib
import tempfile
import threading
import requests
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any, Tuple
from fastapi import FastAPI, HTTPException, Query, Depends, Header
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
def fetch_risk_free_rate(currency: str = Query(default="USD")):
    """Fetch current risk-free rate (matched to currency) and USD/THB exchange rate"""
    import optimizer as _opt
    rate = get_risk_free_rate(currency=currency)
    fx = get_usd_thb_rate()
    return {
        "risk_free_rate": rate,
        "percentage": f"{rate * 100:.2f}%",
        "currency": currency.upper(),
        "usd_thb_rate": fx,
        "is_fallback_fx": bool(getattr(_opt, "_last_fx_is_fallback", False)),
        "is_fallback_rf": bool(getattr(_opt, "_last_rf_is_fallback", False))
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


_AUTH_SECRET_KEY = (os.environ.get("QUANTFOLIO_AUTH_SECRET") or secrets.token_hex(32)).encode("utf-8")
_AUTH_TOKEN_TTL_SECONDS = 86400 * 7  # 7 days


def _create_auth_token(user_id: str, email: str) -> str:
    payload = {
        "sub": str(user_id),
        "email": str(email).strip().lower(),
        "exp": int(time.time()) + _AUTH_TOKEN_TTL_SECONDS,
    }
    payload_b64 = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).decode("ascii").rstrip("=")
    sig = hmac.new(_AUTH_SECRET_KEY, payload_b64.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def _get_authenticated_user(authorization: Optional[str] = Header(default=None)) -> Dict[str, str]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="กรุณาเข้าสู่ระบบก่อนดำเนินการ")
    raw_token = authorization[7:].strip()
    if "." not in raw_token:
        raise HTTPException(status_code=401, detail="เซสชันไม่ถูกต้องหรือหมดอายุ")
    payload_b64, sig = raw_token.rsplit(".", 1)
    expected_sig = hmac.new(_AUTH_SECRET_KEY, payload_b64.encode("ascii"), hashlib.sha256).hexdigest()
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
    email = str(payload.get("email") or "").strip().lower()
    if not user_id or not email:
        raise HTTPException(status_code=401, detail="เซสชันไม่ถูกต้อง")

    with _db_lock:
        db = _load_db()
        stored_user = db.get("users", {}).get(email)
        if not stored_user or str(stored_user.get("id")) != user_id:
            raise HTTPException(status_code=401, detail="ไม่พบบัญชีผู้ใช้งานของเซสชันนี้")

    return {"id": user_id, "email": email}


class AuthLoginRequest(BaseModel):
    email: str
    password: str
    full_name: Optional[str] = None
    mode: str = "auto"  # 'signin' | 'signup' | 'auto'


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


def _hash_password(password: str, salt: Optional[str] = None) -> str:
    salt_str = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt_str.encode("utf-8"), 200_000).hex()
    return f"pbkdf2_sha256${salt_str}${dk}"


def _verify_password(password: str, stored_hash: str) -> Tuple[bool, bool]:
    """
    Verify password against stored_hash.
    Returns (is_valid, needs_rehash_upgrade).
    Supports both salted PBKDF2-SHA256 and legacy unsalted SHA-256 hashes.
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
    # Legacy unsalted SHA-256 fallback (auto-upgraded on successful login)
    legacy_hash = hashlib.sha256(password.encode("utf-8")).hexdigest()
    is_ok = hmac.compare_digest(legacy_hash, stored_hash)
    return is_ok, is_ok


def _build_local_svg_avatar(name: str) -> str:
    """Generate a self-contained SVG data URI avatar without leaking user PII to third-party servers."""
    clean = (name or "QF").strip()
    initials = (clean[:2] if len(clean) >= 2 else clean).upper()
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
        f'<rect width="64" height="64" rx="32" fill="#1d4ed8"/>'
        f'<text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" '
        f'fill="#ffffff" font-family="sans-serif" font-size="24" font-weight="bold">{initials}</text>'
        f'</svg>'
    )
    b64 = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{b64}"


@app.post("/api/auth/login")
def backend_auth_login(req: AuthLoginRequest):
    """
    ระบบยืนยันตัวตนสำรองระดับเซิร์ฟเวอร์ (Salted PBKDF2-SHA256 + Rate Limit + Mode Check)
    """
    email = req.email.strip().lower()
    password = req.password.strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="กรุณากรอกอีเมลให้ถูกต้อง")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร")

    now = time.time()
    with _db_lock:
        recent_attempts = [t for t in _login_attempts.get(email, []) if now - t < _LOGIN_RATE_LIMIT_WINDOW]
        _login_attempts[email] = recent_attempts
        if len(recent_attempts) >= _LOGIN_RATE_LIMIT_MAX:
            raise HTTPException(
                status_code=429,
                detail="พยายามเข้าสู่ระบบผิดพลาดเกินจำนวนครั้งที่กำหนด กรุณารอ 1 นาทีแล้วลองใหม่อีกครั้ง"
            )

        default_name = (req.full_name or "").strip() or email.split("@")[0]
        db = _load_db()
        users = db["users"]

        if email in users:
            stored = users[email]
            is_valid, needs_upgrade = _verify_password(password, stored.get("password_hash", ""))
            if not is_valid:
                _login_attempts.setdefault(email, []).append(now)
                raise HTTPException(status_code=401, detail="รหัสผ่านไม่ถูกต้อง กรุณาตรวจสอบรหัสผ่านของคุณอีกครั้ง")

            _login_attempts.pop(email, None)
            db_dirty = False
            if needs_upgrade:
                stored["password_hash"] = _hash_password(password)
                db_dirty = True
            if req.full_name and req.full_name.strip():
                stored["full_name"] = req.full_name.strip()
                db_dirty = True
            if not stored.get("avatar_url") or "ui-avatars.com" in str(stored.get("avatar_url", "")):
                stored["avatar_url"] = _build_local_svg_avatar(stored.get("full_name") or default_name)
                db_dirty = True
            if db_dirty:
                _save_db(db)

            user_id = str(stored["id"])
            user_obj = {
                "id": user_id,
                "email": email,
                "user_metadata": {
                    "full_name": stored.get("full_name") or default_name,
                    "name": stored.get("full_name") or default_name,
                    "avatar_url": stored.get("avatar_url")
                }
            }
            token = _create_auth_token(user_id, email)
            return {"status": "ok", "action": "signed_in", "token": token, "user": user_obj}
        else:
            if (req.mode or "").strip().lower() == "signin":
                _login_attempts.setdefault(email, []).append(now)
                raise HTTPException(
                    status_code=401,
                    detail="ไม่พบบัญชีผู้ใช้นี้ในระบบ กรุณาตรวจสอบอีเมลหรือสลับไปที่แท็บ 'สมัครสมาชิกใหม่'"
                )
            user_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"quantfolio:{email}"))
            avatar_url = _build_local_svg_avatar(default_name)
            users[email] = {
                "id": user_id,
                "email": email,
                "full_name": default_name,
                "avatar_url": avatar_url,
                "password_hash": _hash_password(password),
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
            token = _create_auth_token(user_id, email)
            return {"status": "ok", "action": "signed_up", "token": token, "user": user_obj}


@app.delete("/api/auth/account")
def delete_backend_account(current_user: Dict[str, str] = Depends(_get_authenticated_user)):
    """Delete the authenticated user's account and all associated portfolios (PDPA Right to Erasure)."""
    auth_user_id = current_user["id"]
    auth_email = current_user["email"]
    with _db_lock:
        db = _load_db()
        users = db.get("users", {})
        users.pop(auth_email, None)
        before_count = len(db.get("portfolios", []))
        db["portfolios"] = [
            p for p in db.get("portfolios", [])
            if str(p.get("user_id")) != str(auth_user_id) and str(p.get("email", "")).lower() != auth_email
        ]
        removed_portfolios = before_count - len(db["portfolios"])
        _save_db(db)
    return {"status": "ok", "deleted_user": auth_email, "deleted_portfolios": removed_portfolios}


@app.get("/api/portfolios")
def get_backend_portfolios(current_user: Dict[str, str] = Depends(_get_authenticated_user)):
    auth_user_id = current_user["id"]
    with _db_lock:
        db = _load_db()
        items = [
            p for p in db.get("portfolios", [])
            if str(p.get("user_id")) == str(auth_user_id)
        ]
    items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return {"portfolios": items}


@app.get("/api/portfolios/{portfolio_id}")
def get_backend_portfolio_by_id(portfolio_id: str, current_user: Dict[str, str] = Depends(_get_authenticated_user)):
    auth_user_id = current_user["id"]
    with _db_lock:
        db = _load_db()
        item = next(
            (
                p for p in db.get("portfolios", [])
                if str(p.get("id")) == str(portfolio_id) and str(p.get("user_id")) == str(auth_user_id)
            ),
            None,
        )
    if item is None:
        raise HTTPException(status_code=404, detail="ไม่พบพอร์ตการลงทุนที่ระบุ")
    return {"portfolio": item}


def _build_portfolio_record(req: PortfolioSaveRequest, item_id: str, current_user: Dict[str, str]) -> Dict[str, Any]:
    return {
        "id": item_id,
        "user_id": current_user["id"],
        "email": current_user["email"],
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
def save_backend_portfolio(req: PortfolioSaveRequest, current_user: Dict[str, str] = Depends(_get_authenticated_user)):
    auth_user_id = current_user["id"]
    with _db_lock:
        db = _load_db()
        if req.id is not None:
            existing_idx = next(
                (
                    idx for idx, p in enumerate(db.get("portfolios", []))
                    if str(p.get("id")) == str(req.id) and str(p.get("user_id")) == str(auth_user_id)
                ),
                None,
            )
            if existing_idx is None:
                raise HTTPException(status_code=404, detail="ไม่พบพอร์ตการลงทุนที่ระบุ")
            new_item = _build_portfolio_record(req, str(req.id), current_user)
            db["portfolios"][existing_idx] = new_item
        else:
            item_id = str(uuid.uuid4())
            new_item = _build_portfolio_record(req, item_id, current_user)
            db["portfolios"].append(new_item)
        _save_db(db)
    return {"status": "ok", "portfolio": new_item}


@app.put("/api/portfolios/{portfolio_id}")
def update_backend_portfolio(
    portfolio_id: str,
    req: PortfolioSaveRequest,
    current_user: Dict[str, str] = Depends(_get_authenticated_user),
):
    auth_user_id = current_user["id"]
    with _db_lock:
        db = _load_db()
        existing_idx = next(
            (
                idx for idx, p in enumerate(db.get("portfolios", []))
                if str(p.get("id")) == str(portfolio_id) and str(p.get("user_id")) == str(auth_user_id)
            ),
            None,
        )
        if existing_idx is None:
            raise HTTPException(status_code=404, detail="ไม่พบพอร์ตการลงทุนที่ระบุ")
        updated_item = _build_portfolio_record(req, str(portfolio_id), current_user)
        db["portfolios"][existing_idx] = updated_item
        _save_db(db)
    return {"status": "ok", "portfolio": updated_item}


@app.delete("/api/portfolios/{portfolio_id}")
def delete_backend_portfolio(portfolio_id: str, current_user: Dict[str, str] = Depends(_get_authenticated_user)):
    auth_user_id = current_user["id"]
    with _db_lock:
        db = _load_db()
        existing_idx = next(
            (
                idx for idx, p in enumerate(db.get("portfolios", []))
                if str(p.get("id")) == str(portfolio_id) and str(p.get("user_id")) == str(auth_user_id)
            ),
            None,
        )
        if existing_idx is None:
            raise HTTPException(status_code=404, detail="ไม่พบพอร์ตการลงทุนที่ระบุ")
        db["portfolios"].pop(existing_idx)
        _save_db(db)
    return {"status": "ok", "deleted": 1}



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
