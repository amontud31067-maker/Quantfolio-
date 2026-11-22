"""
QuantFolio Storage & Repository Layer
=====================================
Provides a clean, pluggable repository abstraction over:
1. SupabasePostgrestRepository (Production / Vercel Serverless)
   - Talks to Supabase PostgreSQL via PostgREST HTTPS API & Atomic SQL RPCs
   - Uses `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (zero extra C drivers)
   - Enforces strict email normalization (.strip().lower()) across all queries
   - Never falls back silently to local JSON files in Production
2. LocalJsonRepository (Local Dev & Automated Pytest)
   - Atomic temp-file + fsync + os.replace() JSON persistence
   - Completely isolated from Production Supabase during pytest runs
"""

from __future__ import annotations

import json
import os
import secrets
import tempfile
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote

import requests


class StorageConfigError(RuntimeError):
    """Raised when Production / Vercel runtime is missing mandatory Supabase or Auth Secret env vars."""


class StorageConflictError(RuntimeError):
    """Raised when a DB uniqueness / idempotency constraint is violated (maps to HTTP 409)."""


class StorageNotFoundError(RuntimeError):
    """Raised when a target record does not exist (maps to HTTP 404)."""


class StorageUnavailableError(RuntimeError):
    """Raised when Supabase PostgreSQL cannot be reached or returns an unexpected server error."""


def normalize_email(raw: Optional[str]) -> str:
    """Canonical email normalization enforced across Backend, DB, and Migration."""
    return str(raw or "").strip().lower()


def normalize_code(raw: Optional[str]) -> str:
    """Canonical activation code normalization."""
    return str(raw or "").strip().upper()


def is_pytest_runtime() -> bool:
    """Detect active pytest execution unless explicitly testing production guardrails."""
    if os.environ.get("QUANTFOLIO_FORCE_PRODUCTION_CHECK", "").strip() == "1":
        return False
    return bool(os.environ.get("PYTEST_CURRENT_TEST"))


def is_production_runtime() -> bool:
    """
    Detect Vercel Serverless or explicit Production deployment.
    In production, silent fallback to local/tmp JSON files is strictly forbidden.
    """
    if is_pytest_runtime():
        return False
    backend_override = os.environ.get("QUANTFOLIO_STORAGE_BACKEND", "").strip().lower()
    if backend_override == "supabase":
        return True
    if backend_override == "json":
        return False
    if os.environ.get("VERCEL", "").strip() in ("1", "true", "TRUE"):
        return True
    if os.environ.get("VERCEL_ENV", "").strip().lower() in ("production", "preview"):
        return True
    if os.environ.get("QUANTFOLIO_ENV", "").strip().lower() == "production":
        return True
    return False


def get_supabase_credentials() -> Tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    return url, key


def resolve_auth_secret_bytes(allow_temp_fallback: bool = True) -> bytes:
    """
    Resolve HMAC session signing secret.
    - Production / Vercel: strictly requires QUANTFOLIO_AUTH_SECRET (>= 32 chars). Never falls back to /tmp.
    - Local / Pytest: uses QUANTFOLIO_AUTH_SECRET or persistent temp secret file.
    """
    env_sec = os.environ.get("QUANTFOLIO_AUTH_SECRET", "").strip()
    if env_sec:
        if is_production_runtime() and len(env_sec) < 32:
            raise StorageConfigError(
                "QUANTFOLIO_AUTH_SECRET บน Production ต้องมีความยาวอย่างน้อย 32 ตัวอักษร"
            )
        return env_sec.encode("utf-8")

    if is_production_runtime() or not allow_temp_fallback:
        raise StorageConfigError(
            "ระบบยืนยันตัวตนบน Production ยังไม่ได้ตั้งค่า QUANTFOLIO_AUTH_SECRET บน Environment Variables"
        )

    secret_path = os.path.join(tempfile.gettempdir(), ".quantfolio_secret_key")
    try:
        if os.path.exists(secret_path):
            with open(secret_path, "r", encoding="utf-8") as f:
                val = f.read().strip()
                if len(val) >= 32:
                    return val.encode("utf-8")
        val = secrets.token_hex(32)
        with open(secret_path, "w", encoding="utf-8") as f:
            f.write(val)
        return val.encode("utf-8")
    except Exception:
        return secrets.token_hex(32).encode("utf-8")


def _normalize_user_row_from_db(row: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize DB row fields into canonical internal user dict shape."""
    out = dict(row)
    out["id"] = str(out.get("id") or "")
    out["email"] = normalize_email(out.get("email"))
    if "custom_entitlements" in out and "entitlements" not in out:
        if isinstance(out.get("custom_entitlements"), dict):
            out["entitlements"] = out["custom_entitlements"]
    return out


def _normalize_portfolio_row_from_db(row: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(row)
    out["id"] = str(out.get("id") or "")
    out["user_id"] = str(out.get("user_id") or "")
    out["email"] = normalize_email(out.get("email"))
    for num_field in (
        "target_amount",
        "initial_budget",
        "monthly_dca",
        "expected_return",
        "expected_volatility",
        "dividend_yield",
        "projected_final_value",
        "goal_achievement_pct",
    ):
        if num_field in out and out[num_field] is not None:
            try:
                out[num_field] = float(out[num_field])
            except (TypeError, ValueError):
                pass
    if "investment_period_years" in out and out["investment_period_years"] is not None:
        try:
            out["investment_period_years"] = int(out["investment_period_years"])
        except (TypeError, ValueError):
            pass
    if not isinstance(out.get("tickers"), list):
        out["tickers"] = []
    if not isinstance(out.get("asset_weights"), dict):
        out["asset_weights"] = {}
    return out


def _normalize_code_row_from_db(row: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(row)
    out["id"] = str(out.get("id") or "")
    out["code"] = normalize_code(out.get("code"))
    out["plan_tier"] = str(out.get("plan_tier") or "pro").strip().lower()
    out["duration_days"] = int(out.get("duration_days") or 0)
    out["max_uses"] = int(out.get("max_uses") or 1)
    out["revoked"] = bool(out.get("revoked", False))
    if not isinstance(out.get("used_by"), list):
        out["used_by"] = []
    return out


def _normalize_request_row_from_db(row: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(row)
    out["id"] = str(out.get("id") or "")
    out["user_id"] = str(out.get("user_id") or "")
    out["email"] = normalize_email(out.get("email"))
    out["target_tier"] = str(out.get("target_tier") or "pro").strip().lower()
    out["duration_days"] = int(out.get("duration_days") or 30)
    out["status"] = str(out.get("status") or "pending").strip().lower()
    return out


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


def _compute_extended_expiry_local(
    stored: Dict[str, Any],
    target_tier: str,
    duration_days: int,
    now_dt: datetime,
) -> Optional[str]:
    clean_target = str(target_tier or "free").strip().lower()
    if clean_target == "free" or int(duration_days or 0) <= 0:
        return None
    cur_tier = str(stored.get("plan_tier") or "free").strip().lower()
    cur_exp = _parse_iso_utc(stored.get("plan_expires_at"))
    cur_active = cur_tier in ("pro", "advisor") and (cur_exp is None or cur_exp > now_dt)
    if cur_active and cur_tier == clean_target:
        if cur_exp is None:
            return None  # Preserve lifetime
        return (cur_exp + timedelta(days=int(duration_days))).isoformat()
    return (now_dt + timedelta(days=int(duration_days))).isoformat()


class LocalJsonRepository:
    """
    Atomic local JSON storage repository for local development & isolated pytest runs.
    """

    backend_name = "json"

    def __init__(self, path_resolver: Callable[[], str], lock: threading.Lock, seed_path: Optional[str] = None):
        self._path_resolver = path_resolver
        self._lock = lock
        self._seed_path = seed_path

    def _load(self) -> Dict[str, Any]:
        path = self._path_resolver()
        target_path = path if os.path.exists(path) else (self._seed_path if (self._seed_path and os.path.exists(self._seed_path)) else None)
        empty = {"users": {}, "portfolios": [], "activation_codes": [], "upgrade_requests": [], "audit_logs": []}
        if not target_path:
            return empty
        try:
            with open(target_path, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if not content:
                    return empty
                data = json.loads(content)
                if not isinstance(data.get("users"), dict):
                    data["users"] = {}
                else:
                    # Normalize keys to lowercase on load
                    normalized_users: Dict[str, Any] = {}
                    for k, v in data["users"].items():
                        nk = normalize_email(k or (v.get("email") if isinstance(v, dict) else ""))
                        if nk and isinstance(v, dict):
                            v_copy = dict(v)
                            v_copy["email"] = nk
                            normalized_users[nk] = v_copy
                    data["users"] = normalized_users
                for list_key in ("portfolios", "activation_codes", "upgrade_requests", "audit_logs"):
                    if not isinstance(data.get(list_key), list):
                        data[list_key] = []
                return data
        except Exception:
            return empty

    def _save(self, data: Dict[str, Any]) -> None:
        path = os.path.abspath(self._path_resolver())
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

    # --- Users ---
    def get_user_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        em = normalize_email(email)
        with self._lock:
            db = self._load()
            row = db["users"].get(em)
            return _normalize_user_row_from_db(row) if row else None

    def get_user_by_id(self, user_id: str) -> Optional[Dict[str, Any]]:
        uid = str(user_id or "").strip()
        with self._lock:
            db = self._load()
            for row in db["users"].values():
                if str(row.get("id")) == uid:
                    return _normalize_user_row_from_db(row)
            return None

    def create_user(self, user_record: Dict[str, Any]) -> Dict[str, Any]:
        rec = dict(user_record)
        em = normalize_email(rec.get("email"))
        rec["email"] = em
        with self._lock:
            db = self._load()
            if em in db["users"]:
                raise StorageConflictError("อีเมลนี้ถูกสมัครใช้งานแล้ว")
            db["users"][em] = rec
            self._save(db)
            return _normalize_user_row_from_db(rec)

    def update_user_by_email(self, email: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        em = normalize_email(email)
        with self._lock:
            db = self._load()
            stored = db["users"].get(em)
            if not stored:
                raise StorageNotFoundError(f"ไม่พบบัญชีผู้ใช้ {em} ในระบบ")
            stored.update(updates)
            stored["email"] = em
            self._save(db)
            return _normalize_user_row_from_db(stored)

    def delete_user_and_portfolios(self, user_id: str, email: str) -> int:
        em = normalize_email(email)
        uid = str(user_id or "").strip()
        with self._lock:
            db = self._load()
            db["users"].pop(em, None)
            before = len(db["portfolios"])
            db["portfolios"] = [
                p for p in db["portfolios"]
                if str(p.get("user_id")) != uid and normalize_email(p.get("email")) != em
            ]
            removed = before - len(db["portfolios"])
            db["upgrade_requests"] = [
                r for r in db["upgrade_requests"]
                if str(r.get("user_id")) != uid and normalize_email(r.get("email")) != em
            ]
            self._save(db)
            return removed

    def list_users(self) -> List[Dict[str, Any]]:
        with self._lock:
            db = self._load()
            return [_normalize_user_row_from_db(u) for u in db["users"].values()]

    # --- Portfolios ---
    def list_portfolios(self, user_id: str) -> List[Dict[str, Any]]:
        uid = str(user_id or "").strip()
        with self._lock:
            db = self._load()
            items = [
                _normalize_portfolio_row_from_db(p)
                for p in db["portfolios"]
                if str(p.get("user_id")) == uid
            ]
        items.sort(key=lambda x: str(x.get("created_at") or ""), reverse=True)
        return items

    def count_portfolios_by_user(self) -> Dict[str, int]:
        with self._lock:
            db = self._load()
            counts: Dict[str, int] = {}
            for p in db["portfolios"]:
                uid = str(p.get("user_id") or "")
                if uid:
                    counts[uid] = counts.get(uid, 0) + 1
            return counts

    def get_portfolio(self, user_id: str, portfolio_id: str) -> Optional[Dict[str, Any]]:
        uid = str(user_id or "").strip()
        pid = str(portfolio_id or "").strip()
        with self._lock:
            db = self._load()
            for p in db["portfolios"]:
                if str(p.get("id")) == pid and str(p.get("user_id")) == uid:
                    return _normalize_portfolio_row_from_db(p)
            return None

    def save_portfolio(
        self,
        user_id: str,
        record: Dict[str, Any],
        explicit_id: Optional[str] = None,
        max_portfolios: Optional[int] = None,
        quota_error_detail: Optional[str] = None,
    ) -> Dict[str, Any]:
        uid = str(user_id or "").strip()
        rec = dict(record)
        rec["user_id"] = uid
        rec["email"] = normalize_email(rec.get("email"))
        with self._lock:
            db = self._load()
            if explicit_id is not None:
                idx = next(
                    (i for i, p in enumerate(db["portfolios"]) if str(p.get("id")) == str(explicit_id) and str(p.get("user_id")) == uid),
                    None,
                )
                if idx is None:
                    raise StorageNotFoundError("ไม่พบพอร์ตการลงทุนที่ระบุ")
                rec["id"] = str(explicit_id)
                db["portfolios"][idx] = rec
            else:
                clean_name = str(rec.get("portfolio_name") or "").strip().lower()
                same_idx = next(
                    (
                        i for i, p in enumerate(db["portfolios"])
                        if str(p.get("user_id")) == uid
                        and clean_name
                        and str(p.get("portfolio_name") or "").strip().lower() == clean_name
                    ),
                    None,
                )
                if same_idx is not None:
                    rec["id"] = str(db["portfolios"][same_idx].get("id") or uuid.uuid4())
                    db["portfolios"][same_idx] = rec
                else:
                    if max_portfolios is not None:
                        user_count = sum(1 for p in db["portfolios"] if str(p.get("user_id")) == uid)
                        if user_count >= int(max_portfolios):
                            raise PermissionError(quota_error_detail or "ถึงเพดานจำนวนแผนพอร์ตแล้ว")
                    rec["id"] = str(rec.get("id") or uuid.uuid4())
                    db["portfolios"].append(rec)
            self._save(db)
            return _normalize_portfolio_row_from_db(rec)

    def delete_portfolio(self, user_id: str, portfolio_id: str) -> bool:
        uid = str(user_id or "").strip()
        pid = str(portfolio_id or "").strip()
        with self._lock:
            db = self._load()
            idx = next(
                (i for i, p in enumerate(db["portfolios"]) if str(p.get("id")) == pid and str(p.get("user_id")) == uid),
                None,
            )
            if idx is None:
                return False
            db["portfolios"].pop(idx)
            self._save(db)
            return True

    # --- Activation Codes ---
    def list_activation_codes(self) -> List[Dict[str, Any]]:
        with self._lock:
            db = self._load()
            codes = [_normalize_code_row_from_db(c) for c in db["activation_codes"]]
        codes.sort(key=lambda x: str(x.get("created_at") or ""), reverse=True)
        return codes

    def create_activation_code(self, code_record: Dict[str, Any]) -> Dict[str, Any]:
        rec = dict(code_record)
        rec["code"] = normalize_code(rec.get("code"))
        with self._lock:
            db = self._load()
            existing = {normalize_code(c.get("code")) for c in db["activation_codes"]}
            if rec["code"] in existing:
                raise StorageConflictError("รหัสเปิดใช้งานนี้มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น")
            db["activation_codes"].append(rec)
            self._save(db)
            return _normalize_code_row_from_db(rec)

    def revoke_activation_code(self, code_id: str, admin_email: str) -> Dict[str, Any]:
        cid = str(code_id or "").strip()
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._lock:
            db = self._load()
            rec = next((c for c in db["activation_codes"] if str(c.get("id")) == cid), None)
            if rec is None:
                raise StorageNotFoundError("ไม่พบรหัสเปิดใช้งานที่ระบุ")
            rec["revoked"] = True
            rec["revoked_at"] = now_iso
            rec["revoked_by"] = normalize_email(admin_email)
            self._save(db)
            return _normalize_code_row_from_db(rec)

    def redeem_activation_code_atomic(
        self,
        user_id: str,
        email: str,
        raw_code: str,
        tier_rank_map: Dict[str, int],
        tier_labels: Dict[str, str],
    ) -> Dict[str, Any]:
        em = normalize_email(email)
        clean_code = normalize_code(raw_code)
        now_utc = datetime.now(timezone.utc)
        with self._lock:
            db = self._load()
            stored = db["users"].get(em)
            if not stored:
                return {"ok": False, "http_status": 404, "error_code": "USER_NOT_FOUND", "error": "ไม่พบบัญชีผู้ใช้งาน"}

            code_rec = next(
                (c for c in db["activation_codes"] if normalize_code(c.get("code")) == clean_code),
                None,
            )
            if code_rec is None:
                return {
                    "ok": False,
                    "http_status": 403,
                    "error_code": "CODE_NOT_FOUND",
                    "error": "รหัสเปิดใช้งานไม่ถูกต้อง กรุณาตรวจสอบรหัสอีกครั้งหรือติดต่อผู้ดูแลระบบ",
                }
            if bool(code_rec.get("revoked", False)):
                return {"ok": False, "http_status": 403, "error_code": "CODE_REVOKED", "error": "รหัสเปิดใช้งานนี้ถูกเพิกถอนแล้ว ไม่สามารถใช้งานได้"}

            code_exp = _parse_iso_utc(code_rec.get("code_expires_at"))
            if code_exp is not None and code_exp <= now_utc:
                return {"ok": False, "http_status": 403, "error_code": "CODE_EXPIRED", "error": "รหัสเปิดใช้งานนี้หมดเขตรับสิทธิ์แล้ว"}

            used_by = list(code_rec.get("used_by") or [])
            max_uses = int(code_rec.get("max_uses", 1))
            if len(used_by) >= max_uses:
                return {"ok": False, "http_status": 403, "error_code": "CODE_EXHAUSTED", "error": "รหัสเปิดใช้งานนี้ถูกใช้งานครบตามจำนวนสิทธิ์แล้ว"}

            used_emails = {
                normalize_email(entry.get("email") if isinstance(entry, dict) else entry)
                for entry in used_by
            }
            if em in used_emails:
                return {
                    "ok": False,
                    "http_status": 403,
                    "error_code": "ALREADY_USED",
                    "error": "บัญชีของคุณเคยใช้รหัสเปิดใช้งานชุดนี้ไปแล้ว ไม่สามารถใช้ซ้ำได้",
                }

            cur_tier = str(stored.get("plan_tier") or "free").strip().lower()
            cur_exp = _parse_iso_utc(stored.get("plan_expires_at"))
            eff_tier = cur_tier if (cur_tier in ("pro", "advisor") and (cur_exp is None or cur_exp > now_utc)) else "free"
            target_tier = str(code_rec.get("plan_tier") or "pro").strip().lower()
            if target_tier not in ("pro", "advisor"):
                target_tier = "pro"

            if tier_rank_map.get(eff_tier, 0) > tier_rank_map.get(target_tier, 0):
                return {
                    "ok": False,
                    "http_status": 400,
                    "error_code": "TIER_DOWNGRADE_BLOCKED",
                    "error": (
                        f"บัญชีของคุณกำลังใช้งานแพ็กเกจที่สูงกว่า ({tier_labels.get(eff_tier, eff_tier)}) อยู่แล้ว "
                        f"ไม่สามารถนำรหัสของแพ็กเกจ {tier_labels.get(target_tier, target_tier)} มาลดระดับสิทธิ์ได้ (ไม่ได้หักสิทธิ์รหัสนี้)"
                    ),
                }

            duration_days = int(code_rec.get("duration_days") or 0)
            new_expiry = _compute_extended_expiry_local(stored, target_tier, duration_days, now_utc)
            stored["plan_tier"] = target_tier
            stored["plan_expires_at"] = new_expiry
            stored["updated_at"] = now_utc.isoformat()
            used_by.append({"email": em, "user_id": str(user_id), "used_at": now_utc.isoformat()})
            code_rec["used_by"] = used_by
            self._save(db)
            return {
                "ok": True,
                "http_status": 200,
                "plan_tier": target_tier,
                "duration_days": duration_days,
                "plan_expires_at": new_expiry,
                "user": _normalize_user_row_from_db(stored),
            }

    # --- Upgrade Requests ---
    def list_upgrade_requests(self, email: Optional[str] = None) -> List[Dict[str, Any]]:
        target_em = normalize_email(email) if email else None
        with self._lock:
            db = self._load()
            reqs = [
                _normalize_request_row_from_db(r)
                for r in db["upgrade_requests"]
                if target_em is None or normalize_email(r.get("email")) == target_em
            ]
        reqs.sort(key=lambda x: str(x.get("created_at") or ""), reverse=True)
        return reqs

    def create_upgrade_request(self, req_record: Dict[str, Any]) -> Dict[str, Any]:
        rec = dict(req_record)
        em = normalize_email(rec.get("email"))
        rec["email"] = em
        with self._lock:
            db = self._load()
            has_pending = any(
                normalize_email(r.get("email")) == em and str(r.get("status")) == "pending"
                for r in db["upgrade_requests"]
            )
            if has_pending:
                raise StorageConflictError(
                    "คุณมีคำขออัปเกรดที่รอการตรวจสอบอยู่แล้ว 1 รายการ กรุณารอผู้ดูแลอนุมัติหรือยกเลิกคำขอเดิมก่อนส่งใหม่"
                )
            db["upgrade_requests"].append(rec)
            self._save(db)
            return _normalize_request_row_from_db(rec)

    def cancel_upgrade_request(self, request_id: str, email: str) -> None:
        em = normalize_email(email)
        rid = str(request_id or "").strip()
        with self._lock:
            db = self._load()
            idx = next(
                (i for i, r in enumerate(db["upgrade_requests"]) if str(r.get("id")) == rid and normalize_email(r.get("email")) == em),
                None,
            )
            if idx is None:
                raise StorageNotFoundError("ไม่พบคำขออัปเกรดที่ระบุ")
            if str(db["upgrade_requests"][idx].get("status")) != "pending":
                raise StorageConflictError("ไม่สามารถยกเลิกคำขอที่ดำเนินการเสร็จสิ้นแล้วได้")
            db["upgrade_requests"].pop(idx)
            self._save(db)

    def decide_upgrade_request_atomic(
        self,
        request_id: str,
        decision: str,
        admin_email: str,
        admin_note: str = "",
        override_duration_days: Optional[int] = None,
    ) -> Dict[str, Any]:
        rid = str(request_id or "").strip()
        adm = normalize_email(admin_email)
        now_utc = datetime.now(timezone.utc)
        with self._lock:
            db = self._load()
            req_rec = next((r for r in db["upgrade_requests"] if str(r.get("id")) == rid), None)
            if req_rec is None:
                return {"ok": False, "http_status": 404, "error": "ไม่พบคำขออัปเกรดที่ระบุ"}
            if str(req_rec.get("status")) != "pending":
                return {"ok": False, "http_status": 409, "error": "คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถอนุมัติหรือปฏิเสธซ้ำได้"}

            target_email = normalize_email(req_rec.get("email"))
            target_tier = str(req_rec.get("target_tier") or "pro").strip().lower()
            duration_days = (
                max(0, int(override_duration_days))
                if override_duration_days is not None
                else max(0, int(req_rec.get("duration_days") or 30))
            )

            updated_user = None
            if decision == "approve":
                target_stored = db["users"].get(target_email)
                if not target_stored:
                    return {"ok": False, "http_status": 404, "error": f"ไม่พบบัญชีผู้ใช้ {target_email} ในระบบ"}
                new_expiry = _compute_extended_expiry_local(target_stored, target_tier, duration_days, now_utc)
                target_stored["plan_tier"] = target_tier
                target_stored["plan_expires_at"] = new_expiry
                target_stored["updated_at"] = now_utc.isoformat()
                req_rec["status"] = "approved"
                req_rec["applied_duration_days"] = duration_days
                req_rec["applied_expires_at"] = new_expiry
                updated_user = _normalize_user_row_from_db(target_stored)
            else:
                req_rec["status"] = "rejected"

            req_rec["admin_note"] = admin_note
            req_rec["decided_at"] = now_utc.isoformat()
            req_rec["decided_by"] = adm
            self._save(db)
            return {
                "ok": True,
                "http_status": 200,
                "request": _normalize_request_row_from_db(req_rec),
                "user": updated_user,
            }

    # --- Audit Logs ---
    def write_audit_log(
        self,
        action: str,
        actor_user_id: Optional[str] = None,
        actor_email: Optional[str] = None,
        target_user_id: Optional[str] = None,
        target_email: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
        ip_address: Optional[str] = None,
    ) -> None:
        entry = {
            "id": str(uuid.uuid4()),
            "actor_user_id": actor_user_id,
            "actor_email": normalize_email(actor_email) if actor_email else None,
            "target_user_id": target_user_id,
            "target_email": normalize_email(target_email) if target_email else None,
            "action": str(action or "event"),
            "details": details if isinstance(details, dict) else {},
            "ip_address": ip_address,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        with self._lock:
            db = self._load()
            db["audit_logs"].append(entry)
            if len(db["audit_logs"]) > 500:
                db["audit_logs"] = db["audit_logs"][-500:]
            self._save(db)


class SupabasePostgrestRepository:
    """
    Production Supabase PostgreSQL Repository over PostgREST HTTPS API & Atomic SQL RPCs.
    Uses `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` via `requests.Session` (zero extra C packages).
    """

    backend_name = "supabase"

    def __init__(self, supabase_url: str, service_role_key: str, timeout: float = 12.0):
        clean_url = supabase_url.strip().rstrip("/")
        if clean_url.lower().endswith("/rest/v1"):
            clean_url = clean_url[:-8].rstrip("/")
        self.base_url = clean_url
        self.rest_url = f"{self.base_url}/rest/v1"
        self.service_role_key = service_role_key
        self.timeout = timeout
        self._session = requests.Session()
        base_headers = {
            "apikey": service_role_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        # New Supabase opaque Secret keys (`sb_secret_...`) are non-JWT and MUST ONLY be sent
        # in the `apikey` header (sending them in `Authorization: Bearer` triggers 401 on PostgREST).
        # Legacy JWT `service_role` keys (`eyJ...`, 3 dot-separated segments) require both headers.
        if not service_role_key.startswith("sb_secret_") and service_role_key.count(".") == 2:
            base_headers["Authorization"] = f"Bearer {service_role_key}"
        self._session.headers.update(base_headers)

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json_body: Any = None,
        prefer: Optional[str] = None,
    ) -> requests.Response:
        url = f"{self.rest_url}/{path.lstrip('/')}"
        headers = {}
        if prefer:
            headers["Prefer"] = prefer
        try:
            resp = self._session.request(
                method,
                url,
                params=params,
                json=json_body,
                headers=headers,
                timeout=self.timeout,
            )
            return resp
        except requests.RequestException as exc:
            raise StorageUnavailableError(f"ไม่สามารถเชื่อมต่อฐานข้อมูล Supabase ได้: {exc}") from exc

    def _extract_pg_error(self, resp: requests.Response) -> Tuple[str, str]:
        try:
            body = resp.json()
            if isinstance(body, dict):
                return str(body.get("code") or ""), str(body.get("message") or body.get("details") or resp.text)
        except Exception:
            pass
        return "", resp.text[:300]

    def ping(self) -> bool:
        resp = self._request("GET", "qf_users", params={"select": "id", "limit": "1"})
        return resp.status_code == 200

    # --- Users ---
    def get_user_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        em = normalize_email(email)
        if not em:
            return None
        resp = self._request("GET", "qf_users", params={"email": f"eq.{em}", "select": "*", "limit": "1"})
        if resp.status_code != 200:
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase get_user_by_email failed ({resp.status_code}): {msg}")
        rows = resp.json() or []
        return _normalize_user_row_from_db(rows[0]) if rows else None

    def get_user_by_id(self, user_id: str) -> Optional[Dict[str, Any]]:
        uid = str(user_id or "").strip()
        if not uid:
            return None
        resp = self._request("GET", "qf_users", params={"id": f"eq.{uid}", "select": "*", "limit": "1"})
        if resp.status_code != 200:
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase get_user_by_id failed ({resp.status_code}): {msg}")
        rows = resp.json() or []
        return _normalize_user_row_from_db(rows[0]) if rows else None

    def create_user(self, user_record: Dict[str, Any]) -> Dict[str, Any]:
        payload = {
            "id": str(user_record["id"]),
            "email": normalize_email(user_record["email"]),
            "full_name": str(user_record.get("full_name") or ""),
            "avatar_url": str(user_record.get("avatar_url") or ""),
            "password_hash": str(user_record["password_hash"]),
            "plan_tier": str(user_record.get("plan_tier") or "free").strip().lower(),
            "plan_expires_at": user_record.get("plan_expires_at"),
            "is_admin": bool(user_record.get("is_admin", False)),
            "custom_entitlements": user_record.get("entitlements") if isinstance(user_record.get("entitlements"), dict) else None,
        }
        if user_record.get("created_at"):
            payload["created_at"] = user_record["created_at"]
        resp = self._request("POST", "qf_users", json_body=payload, prefer="return=representation")
        if resp.status_code == 409:
            raise StorageConflictError("อีเมลนี้ถูกสมัครใช้งานแล้ว")
        if resp.status_code not in (200, 201):
            code, msg = self._extract_pg_error(resp)
            if code == "23505":
                raise StorageConflictError("อีเมลนี้ถูกสมัครใช้งานแล้ว")
            raise StorageUnavailableError(f"Supabase create_user failed ({resp.status_code}): {msg}")
        rows = resp.json() or []
        return _normalize_user_row_from_db(rows[0] if rows else payload)

    def update_user_by_email(self, email: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        em = normalize_email(email)
        allowed = {
            "full_name",
            "avatar_url",
            "password_hash",
            "plan_tier",
            "plan_expires_at",
            "is_admin",
            "updated_at",
        }
        payload: Dict[str, Any] = {}
        for k, v in updates.items():
            if k in allowed:
                payload[k] = v
            elif k == "entitlements" and isinstance(v, dict):
                payload["custom_entitlements"] = v
        resp = self._request(
            "PATCH",
            "qf_users",
            params={"email": f"eq.{em}"},
            json_body=payload,
            prefer="return=representation",
        )
        if resp.status_code not in (200, 204):
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase update_user failed ({resp.status_code}): {msg}")
        rows = resp.json() or []
        if not rows:
            raise StorageNotFoundError(f"ไม่พบบัญชีผู้ใช้ {em} ในระบบ")
        return _normalize_user_row_from_db(rows[0])

    def delete_user_and_portfolios(self, user_id: str, email: str) -> int:
        uid = str(user_id or "").strip()
        # Count portfolios first for accurate PDPA response
        existing_ports = self.list_portfolios(uid)
        resp = self._request("DELETE", "qf_users", params={"id": f"eq.{uid}"})
        if resp.status_code not in (200, 204):
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase delete_user failed ({resp.status_code}): {msg}")
        return len(existing_ports)

    def list_users(self) -> List[Dict[str, Any]]:
        resp = self._request("GET", "qf_users", params={"select": "*", "order": "created_at.desc"})
        if resp.status_code != 200:
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase list_users failed ({resp.status_code}): {msg}")
        return [_normalize_user_row_from_db(r) for r in (resp.json() or [])]

    # --- Portfolios ---
    def list_portfolios(self, user_id: str) -> List[Dict[str, Any]]:
        uid = str(user_id or "").strip()
        resp = self._request(
            "GET",
            "qf_portfolios",
            params={"user_id": f"eq.{uid}", "select": "*", "order": "created_at.desc"},
        )
        if resp.status_code != 200:
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase list_portfolios failed ({resp.status_code}): {msg}")
        return [_normalize_portfolio_row_from_db(r) for r in (resp.json() or [])]

    def count_portfolios_by_user(self) -> Dict[str, int]:
        resp = self._request("GET", "qf_portfolios", params={"select": "user_id"})
        if resp.status_code != 200:
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase count_portfolios failed ({resp.status_code}): {msg}")
        counts: Dict[str, int] = {}
        for row in resp.json() or []:
            uid = str(row.get("user_id") or "")
            if uid:
                counts[uid] = counts.get(uid, 0) + 1
        return counts

    def get_portfolio(self, user_id: str, portfolio_id: str) -> Optional[Dict[str, Any]]:
        uid = str(user_id or "").strip()
        pid = str(portfolio_id or "").strip()
        resp = self._request(
            "GET",
            "qf_portfolios",
            params={"id": f"eq.{pid}", "user_id": f"eq.{uid}", "select": "*", "limit": "1"},
        )
        if resp.status_code != 200:
            return None
        rows = resp.json() or []
        return _normalize_portfolio_row_from_db(rows[0]) if rows else None

    def save_portfolio(
        self,
        user_id: str,
        record: Dict[str, Any],
        explicit_id: Optional[str] = None,
        max_portfolios: Optional[int] = None,
        quota_error_detail: Optional[str] = None,
    ) -> Dict[str, Any]:
        uid = str(user_id or "").strip()
        payload = {
            "user_id": uid,
            "email": normalize_email(record.get("email")),
            "portfolio_name": str(record.get("portfolio_name") or "").strip(),
            "goal_type": str(record.get("goal_type") or "custom"),
            "goal_label": str(record.get("goal_label") or "เป้าหมายส่วนตัว"),
            "target_amount": float(record.get("target_amount") or 0),
            "initial_budget": float(record.get("initial_budget") or 0),
            "monthly_dca": float(record.get("monthly_dca") or 0),
            "investment_period_years": int(record.get("investment_period_years") or 5),
            "currency": str(record.get("currency") or "THB").upper(),
            "tickers": list(record.get("tickers") or []),
            "asset_weights": dict(record.get("asset_weights") or {}),
            "strategy_key": str(record.get("strategy_key") or "max_sharpe"),
            "expected_return": float(record.get("expected_return") or 0),
            "expected_volatility": float(record.get("expected_volatility") or 0),
            "dividend_yield": float(record.get("dividend_yield") or 0),
            "projected_final_value": float(record.get("projected_final_value") or 0),
            "goal_achievement_pct": float(record.get("goal_achievement_pct") or 0),
        }

        if explicit_id is not None:
            resp = self._request(
                "PATCH",
                "qf_portfolios",
                params={"id": f"eq.{explicit_id}", "user_id": f"eq.{uid}"},
                json_body=payload,
                prefer="return=representation",
            )
            if resp.status_code not in (200, 204):
                _, msg = self._extract_pg_error(resp)
                raise StorageUnavailableError(f"Supabase update_portfolio failed ({resp.status_code}): {msg}")
            rows = resp.json() or []
            if not rows:
                raise StorageNotFoundError("ไม่พบพอร์ตการลงทุนที่ระบุ")
            return _normalize_portfolio_row_from_db(rows[0])

        # Check same-name upsert or quota limit
        existing = self.list_portfolios(uid)
        clean_name = payload["portfolio_name"].lower()
        same_item = next(
            (p for p in existing if clean_name and str(p.get("portfolio_name") or "").strip().lower() == clean_name),
            None,
        )
        if same_item is not None:
            return self.save_portfolio(uid, record, explicit_id=same_item["id"])

        if max_portfolios is not None and len(existing) >= int(max_portfolios):
            raise PermissionError(quota_error_detail or "ถึงเพดานจำนวนแผนพอร์ตแล้ว")

        payload["id"] = str(record.get("id") or uuid.uuid4())
        resp = self._request("POST", "qf_portfolios", json_body=payload, prefer="return=representation")
        if resp.status_code not in (200, 201):
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase create_portfolio failed ({resp.status_code}): {msg}")
        rows = resp.json() or []
        return _normalize_portfolio_row_from_db(rows[0] if rows else payload)

    def delete_portfolio(self, user_id: str, portfolio_id: str) -> bool:
        uid = str(user_id or "").strip()
        pid = str(portfolio_id or "").strip()
        resp = self._request(
            "DELETE",
            "qf_portfolios",
            params={"id": f"eq.{pid}", "user_id": f"eq.{uid}"},
            prefer="return=representation",
        )
        if resp.status_code not in (200, 204):
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase delete_portfolio failed ({resp.status_code}): {msg}")
        rows = resp.json() if resp.text else []
        return bool(rows)

    # --- Activation Codes ---
    def list_activation_codes(self) -> List[Dict[str, Any]]:
        resp = self._request("GET", "qf_activation_codes", params={"select": "*", "order": "created_at.desc"})
        if resp.status_code != 200:
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase list_codes failed ({resp.status_code}): {msg}")
        return [_normalize_code_row_from_db(c) for c in (resp.json() or [])]

    def create_activation_code(self, code_record: Dict[str, Any]) -> Dict[str, Any]:
        payload = {
            "id": str(code_record.get("id") or uuid.uuid4()),
            "code": normalize_code(code_record["code"]),
            "plan_tier": str(code_record["plan_tier"]).strip().lower(),
            "duration_days": int(code_record.get("duration_days") or 0),
            "max_uses": int(code_record.get("max_uses") or 1),
            "code_expires_at": code_record.get("code_expires_at"),
            "used_by": list(code_record.get("used_by") or []),
            "revoked": bool(code_record.get("revoked", False)),
            "note": str(code_record.get("note") or ""),
            "created_by": normalize_email(code_record.get("created_by")),
        }
        resp = self._request("POST", "qf_activation_codes", json_body=payload, prefer="return=representation")
        if resp.status_code == 409:
            raise StorageConflictError("รหัสเปิดใช้งานนี้มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น")
        if resp.status_code not in (200, 201):
            code, msg = self._extract_pg_error(resp)
            if code == "23505":
                raise StorageConflictError("รหัสเปิดใช้งานนี้มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น")
            raise StorageUnavailableError(f"Supabase create_code failed ({resp.status_code}): {msg}")
        rows = resp.json() or []
        return _normalize_code_row_from_db(rows[0] if rows else payload)

    def revoke_activation_code(self, code_id: str, admin_email: str) -> Dict[str, Any]:
        cid = str(code_id or "").strip()
        payload = {
            "revoked": True,
            "revoked_at": datetime.now(timezone.utc).isoformat(),
            "revoked_by": normalize_email(admin_email),
        }
        resp = self._request(
            "PATCH",
            "qf_activation_codes",
            params={"id": f"eq.{cid}"},
            json_body=payload,
            prefer="return=representation",
        )
        if resp.status_code not in (200, 204):
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase revoke_code failed ({resp.status_code}): {msg}")
        rows = resp.json() or []
        if not rows:
            raise StorageNotFoundError("ไม่พบรหัสเปิดใช้งานที่ระบุ")
        return _normalize_code_row_from_db(rows[0])

    def redeem_activation_code_atomic(
        self,
        user_id: str,
        email: str,
        raw_code: str,
        tier_rank_map: Dict[str, int],
        tier_labels: Dict[str, str],
    ) -> Dict[str, Any]:
        resp = self._request(
            "POST",
            "rpc/qf_redeem_activation_code_atomic",
            json_body={"p_user_id": str(user_id), "p_code": normalize_code(raw_code)},
        )
        if resp.status_code != 200:
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase redeem RPC failed ({resp.status_code}): {msg}")
        result = resp.json()
        if not isinstance(result, dict):
            raise StorageUnavailableError("Supabase redeem RPC returned invalid payload")
        if result.get("ok") and isinstance(result.get("user"), dict):
            result["user"] = _normalize_user_row_from_db(result["user"])
        return result

    # --- Upgrade Requests ---
    def list_upgrade_requests(self, email: Optional[str] = None) -> List[Dict[str, Any]]:
        params: Dict[str, Any] = {"select": "*", "order": "created_at.desc"}
        if email:
            params["email"] = f"eq.{normalize_email(email)}"
        resp = self._request("GET", "qf_upgrade_requests", params=params)
        if resp.status_code != 200:
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase list_upgrade_requests failed ({resp.status_code}): {msg}")
        return [_normalize_request_row_from_db(r) for r in (resp.json() or [])]

    def create_upgrade_request(self, req_record: Dict[str, Any]) -> Dict[str, Any]:
        payload = {
            "id": str(req_record.get("id") or uuid.uuid4()),
            "user_id": str(req_record["user_id"]),
            "email": normalize_email(req_record["email"]),
            "full_name": str(req_record.get("full_name") or ""),
            "target_tier": str(req_record["target_tier"]).strip().lower(),
            "duration_days": int(req_record.get("duration_days") or 30),
            "transfer_amount": str(req_record.get("transfer_amount") or ""),
            "transfer_datetime": str(req_record.get("transfer_datetime") or ""),
            "account_last4": str(req_record.get("account_last4") or ""),
            "slip_ref": str(req_record.get("slip_ref") or ""),
            "contact_note": str(req_record.get("contact_note") or ""),
            "status": "pending",
            "admin_note": "",
        }
        resp = self._request("POST", "qf_upgrade_requests", json_body=payload, prefer="return=representation")
        if resp.status_code == 409:
            raise StorageConflictError(
                "คุณมีคำขออัปเกรดที่รอการตรวจสอบอยู่แล้ว 1 รายการ กรุณารอผู้ดูแลอนุมัติหรือยกเลิกคำขอเดิมก่อนส่งใหม่"
            )
        if resp.status_code not in (200, 201):
            code, msg = self._extract_pg_error(resp)
            if code == "23505":
                raise StorageConflictError(
                    "คุณมีคำขออัปเกรดที่รอการตรวจสอบอยู่แล้ว 1 รายการ กรุณารอผู้ดูแลอนุมัติหรือยกเลิกคำขอเดิมก่อนส่งใหม่"
                )
            raise StorageUnavailableError(f"Supabase create_upgrade_request failed ({resp.status_code}): {msg}")
        rows = resp.json() or []
        return _normalize_request_row_from_db(rows[0] if rows else payload)

    def cancel_upgrade_request(self, request_id: str, email: str) -> None:
        rid = str(request_id or "").strip()
        em = normalize_email(email)
        # First fetch to distinguish 404 vs 409 (already decided)
        check = self._request(
            "GET",
            "qf_upgrade_requests",
            params={"id": f"eq.{rid}", "email": f"eq.{em}", "select": "id,status", "limit": "1"},
        )
        rows = check.json() if check.status_code == 200 else []
        if not rows:
            raise StorageNotFoundError("ไม่พบคำขออัปเกรดที่ระบุ")
        if str(rows[0].get("status")) != "pending":
            raise StorageConflictError("ไม่สามารถยกเลิกคำขอที่ดำเนินการเสร็จสิ้นแล้วได้")
        resp = self._request(
            "DELETE",
            "qf_upgrade_requests",
            params={"id": f"eq.{rid}", "email": f"eq.{em}", "status": "eq.pending"},
            prefer="return=representation",
        )
        if resp.status_code not in (200, 204):
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase cancel_upgrade_request failed ({resp.status_code}): {msg}")

    def decide_upgrade_request_atomic(
        self,
        request_id: str,
        decision: str,
        admin_email: str,
        admin_note: str = "",
        override_duration_days: Optional[int] = None,
    ) -> Dict[str, Any]:
        resp = self._request(
            "POST",
            "rpc/qf_decide_upgrade_request_atomic",
            json_body={
                "p_request_id": str(request_id),
                "p_decision": str(decision).strip().lower(),
                "p_admin_email": normalize_email(admin_email),
                "p_admin_note": str(admin_note or ""),
                "p_override_duration_days": int(override_duration_days) if override_duration_days is not None else None,
            },
        )
        if resp.status_code != 200:
            _, msg = self._extract_pg_error(resp)
            raise StorageUnavailableError(f"Supabase decide RPC failed ({resp.status_code}): {msg}")
        result = resp.json()
        if not isinstance(result, dict):
            raise StorageUnavailableError("Supabase decide RPC returned invalid payload")
        if result.get("ok"):
            if isinstance(result.get("request"), dict):
                result["request"] = _normalize_request_row_from_db(result["request"])
            if isinstance(result.get("user"), dict):
                result["user"] = _normalize_user_row_from_db(result["user"])
        return result

    # --- Audit Logs ---
    def write_audit_log(
        self,
        action: str,
        actor_user_id: Optional[str] = None,
        actor_email: Optional[str] = None,
        target_user_id: Optional[str] = None,
        target_email: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
        ip_address: Optional[str] = None,
    ) -> None:
        payload = {
            "actor_user_id": str(actor_user_id) if actor_user_id else None,
            "actor_email": normalize_email(actor_email) if actor_email else None,
            "target_user_id": str(target_user_id) if target_user_id else None,
            "target_email": normalize_email(target_email) if target_email else None,
            "action": str(action or "event"),
            "details": details if isinstance(details, dict) else {},
            "ip_address": ip_address,
        }
        try:
            self._request("POST", "qf_audit_logs", json_body=payload, prefer="return=minimal")
        except Exception:
            # Never block primary auth/membership transaction if audit log write transiently fails
            pass


_cached_supabase_repo: Optional[Tuple[str, str, SupabasePostgrestRepository]] = None


def build_repository(
    *,
    json_path_resolver: Callable[[], str],
    json_lock: threading.Lock,
    json_seed_path: Optional[str] = None,
):
    """
    Resolve active storage repository with strict Production Fail-Fast:
    - Production / Vercel: MUST use SupabasePostgrestRepository (raises StorageConfigError -> 503 if unconfigured; NEVER falls back to JSON).
    - Local / Pytest: uses Supabase if configured outside pytest, otherwise isolated LocalJsonRepository.
    """
    global _cached_supabase_repo
    sb_url, sb_key = get_supabase_credentials()
    prod = is_production_runtime()

    if prod:
        if not sb_url or not sb_key:
            raise StorageConfigError(
                "ระบบฐานข้อมูลบน Production ยังไม่พร้อมใช้งาน (กรุณาตั้งค่า SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY บน Vercel Dashboard)"
            )
        # Validate auth secret is also configured on Production
        resolve_auth_secret_bytes(allow_temp_fallback=False)
        if _cached_supabase_repo and _cached_supabase_repo[0] == sb_url and _cached_supabase_repo[1] == sb_key:
            return _cached_supabase_repo[2]
        repo = SupabasePostgrestRepository(sb_url, sb_key)
        _cached_supabase_repo = (sb_url, sb_key, repo)
        return repo

    # Non-production: if explicit Supabase env vars are set AND not inside pytest, allow local dev against Supabase
    backend_override = os.environ.get("QUANTFOLIO_STORAGE_BACKEND", "").strip().lower()
    if not is_pytest_runtime() and backend_override != "json" and sb_url and sb_key:
        if _cached_supabase_repo and _cached_supabase_repo[0] == sb_url and _cached_supabase_repo[1] == sb_key:
            return _cached_supabase_repo[2]
        repo = SupabasePostgrestRepository(sb_url, sb_key)
        _cached_supabase_repo = (sb_url, sb_key, repo)
        return repo

    return LocalJsonRepository(
        path_resolver=json_path_resolver,
        lock=json_lock,
        seed_path=json_seed_path,
    )
