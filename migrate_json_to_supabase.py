"""
QuantFolio One-Time Idempotent Migration Script: quantfolio_users_db.json -> Supabase PostgreSQL
===============================================================================================
Usage:
  1. Run supabase_schema.sql in Supabase Dashboard -> SQL Editor first.
  2. Set environment variables:
       $env:SUPABASE_URL = "https://<project-ref>.supabase.co"
       $env:SUPABASE_SERVICE_ROLE_KEY = "<your-service-role-key>"
  3. Dry run first to preview counts:
       python migrate_json_to_supabase.py --dry-run
  4. Execute real idempotent migration:
       python migrate_json_to_supabase.py

Guarantees:
  - Normalizes all emails via .strip().lower() and activation codes via .strip().upper()
  - Preserves existing UUIDs, PBKDF2 password hashes, plan_tier, plan_expires_at, portfolios, codes & requests
  - 100% Idempotent: safely skips already-migrated rows if run multiple times
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from storage_repo import (
    SupabasePostgrestRepository,
    normalize_code,
    normalize_email,
)


def _ensure_uuid(raw_id: Optional[str], fallback_seed: str) -> str:
    if raw_id:
        try:
            return str(uuid.UUID(str(raw_id)))
        except ValueError:
            pass
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"quantfolio:migrate:{fallback_seed}"))


def load_source_json(source_path: Path) -> Dict[str, Any]:
    if not source_path.exists():
        raise FileNotFoundError(f"ไม่พบไฟล์ต้นทาง: {source_path}")
    raw = json.loads(source_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("รูปแบบไฟล์ JSON ไม่ถูกต้อง (ต้องเป็น object ที่มีคีย์ users/portfolios/...)")
    return {
        "users": raw.get("users") if isinstance(raw.get("users"), dict) else {},
        "portfolios": raw.get("portfolios") if isinstance(raw.get("portfolios"), list) else [],
        "activation_codes": raw.get("activation_codes") if isinstance(raw.get("activation_codes"), list) else [],
        "upgrade_requests": raw.get("upgrade_requests") if isinstance(raw.get("upgrade_requests"), list) else [],
    }


def migrate_data_to_supabase(
    source_data: Dict[str, Any],
    repo: SupabasePostgrestRepository,
    *,
    dry_run: bool = False,
) -> Dict[str, Dict[str, int]]:
    stats: Dict[str, Dict[str, int]] = {
        "users": {"migrated": 0, "skipped": 0, "errors": 0},
        "portfolios": {"migrated": 0, "skipped": 0, "errors": 0},
        "activation_codes": {"migrated": 0, "skipped": 0, "errors": 0},
        "upgrade_requests": {"migrated": 0, "skipped": 0, "errors": 0},
    }

    email_to_user_id: Dict[str, str] = {}

    # Existing state lookup for strict idempotency
    existing_users_by_email: Dict[str, Dict[str, Any]] = {}
    existing_codes_upper: set[str] = set()
    existing_req_ids: set[str] = set()
    existing_pending_user_ids: set[str] = set()

    if not dry_run:
        for u in repo.list_users():
            em = normalize_email(u.get("email"))
            if em:
                existing_users_by_email[em] = u
                email_to_user_id[em] = str(u["id"])
        for c in repo.list_activation_codes():
            existing_codes_upper.add(normalize_code(c.get("code")))
        for r in repo.list_upgrade_requests():
            existing_req_ids.add(str(r.get("id") or ""))
            if str(r.get("status")) == "pending":
                existing_pending_user_ids.add(str(r.get("user_id") or ""))

    # 1. Migrate Users (case-insensitive deduplicated by lower(email))
    seen_source_emails: set[str] = set()
    for key_email, user_obj in (source_data.get("users") or {}).items():
        if not isinstance(user_obj, dict):
            continue
        em = normalize_email(user_obj.get("email") or key_email)
        if not em or "@" not in em or em in seen_source_emails:
            stats["users"]["skipped"] += 1
            continue
        seen_source_emails.add(em)

        uid = _ensure_uuid(user_obj.get("id"), f"user:{em}")
        if em in existing_users_by_email:
            email_to_user_id[em] = str(existing_users_by_email[em]["id"])
            stats["users"]["skipped"] += 1
            continue

        email_to_user_id[em] = uid
        if dry_run:
            stats["users"]["migrated"] += 1
            continue

        payload = {
            "id": uid,
            "email": em,
            "full_name": str(user_obj.get("full_name") or em.split("@")[0]),
            "avatar_url": str(user_obj.get("avatar_url") or ""),
            "password_hash": str(user_obj.get("password_hash") or ""),
            "plan_tier": str(user_obj.get("plan_tier") or "free").strip().lower(),
            "plan_expires_at": user_obj.get("plan_expires_at"),
            "is_admin": bool(user_obj.get("is_admin", False)),
            "entitlements": user_obj.get("entitlements") if isinstance(user_obj.get("entitlements"), dict) else None,
            "created_at": user_obj.get("created_at") or datetime.now(timezone.utc).isoformat(),
        }
        try:
            created = repo.create_user(payload)
            email_to_user_id[em] = str(created["id"])
            stats["users"]["migrated"] += 1
        except Exception as exc:
            print(f"  [WARN] User {em}: {exc}")
            stats["users"]["errors"] += 1

    # 2. Migrate Portfolios (linked to migrated user_id)
    existing_port_ids_by_user: Dict[str, set[str]] = {}
    for p in source_data.get("portfolios") or []:
        if not isinstance(p, dict):
            continue
        em = normalize_email(p.get("email"))
        uid = email_to_user_id.get(em) or _ensure_uuid(p.get("user_id"), f"user:{em}")
        if em and em not in email_to_user_id:
            # Orphan portfolio whose user no longer exists
            stats["portfolios"]["skipped"] += 1
            continue
        pid = _ensure_uuid(p.get("id"), f"portfolio:{uid}:{p.get('portfolio_name')}")

        if dry_run:
            stats["portfolios"]["migrated"] += 1
            continue

        if uid not in existing_port_ids_by_user:
            existing_port_ids_by_user[uid] = {str(item["id"]) for item in repo.list_portfolios(uid)}
        if pid in existing_port_ids_by_user[uid]:
            stats["portfolios"]["skipped"] += 1
            continue

        record = {
            "id": pid,
            "user_id": uid,
            "email": em,
            "portfolio_name": str(p.get("portfolio_name") or "พอร์ตที่บันทึกไว้").strip(),
            "goal_type": str(p.get("goal_type") or "custom"),
            "goal_label": str(p.get("goal_label") or "เป้าหมายส่วนตัว"),
            "target_amount": float(p.get("target_amount") or 0),
            "initial_budget": float(p.get("initial_budget") or 0),
            "monthly_dca": float(p.get("monthly_dca") or 0),
            "investment_period_years": int(p.get("investment_period_years") or 5),
            "currency": str(p.get("currency") or "THB").upper(),
            "tickers": p.get("tickers") if isinstance(p.get("tickers"), list) else [],
            "asset_weights": p.get("asset_weights") if isinstance(p.get("asset_weights"), dict) else {},
            "strategy_key": str(p.get("strategy_key") or "max_sharpe"),
            "expected_return": float(p.get("expected_return") or 0),
            "expected_volatility": float(p.get("expected_volatility") or 0),
            "dividend_yield": float(p.get("dividend_yield") or 0),
            "projected_final_value": float(p.get("projected_final_value") or 0),
            "goal_achievement_pct": float(p.get("goal_achievement_pct") or 0),
        }
        try:
            repo.save_portfolio(uid, record)
            existing_port_ids_by_user[uid].add(pid)
            stats["portfolios"]["migrated"] += 1
        except Exception as exc:
            print(f"  [WARN] Portfolio {pid}: {exc}")
            stats["portfolios"]["errors"] += 1

    # 3. Migrate Activation Codes
    for c in source_data.get("activation_codes") or []:
        if not isinstance(c, dict):
            continue
        code_val = normalize_code(c.get("code"))
        if not code_val:
            stats["activation_codes"]["skipped"] += 1
            continue
        if code_val in existing_codes_upper:
            stats["activation_codes"]["skipped"] += 1
            continue

        if dry_run:
            existing_codes_upper.add(code_val)
            stats["activation_codes"]["migrated"] += 1
            continue

        norm_used_by: List[Dict[str, Any]] = []
        for entry in c.get("used_by") or []:
            if isinstance(entry, dict):
                norm_used_by.append({
                    **entry,
                    "email": normalize_email(entry.get("email")),
                })
            else:
                norm_used_by.append({"email": normalize_email(str(entry))})

        payload = {
            "id": _ensure_uuid(c.get("id"), f"code:{code_val}"),
            "code": code_val,
            "plan_tier": str(c.get("plan_tier") or "pro").strip().lower(),
            "duration_days": int(c.get("duration_days") or 30),
            "max_uses": int(c.get("max_uses") or 1),
            "code_expires_at": c.get("code_expires_at"),
            "used_by": norm_used_by,
            "revoked": bool(c.get("revoked", False)),
            "note": str(c.get("note") or ""),
            "created_by": normalize_email(c.get("created_by")),
        }
        try:
            repo.create_activation_code(payload)
            existing_codes_upper.add(code_val)
            stats["activation_codes"]["migrated"] += 1
        except Exception as exc:
            print(f"  [WARN] Code {code_val}: {exc}")
            stats["activation_codes"]["errors"] += 1

    # 4. Migrate Upgrade Requests
    for r in source_data.get("upgrade_requests") or []:
        if not isinstance(r, dict):
            continue
        em = normalize_email(r.get("email"))
        if em not in email_to_user_id:
            stats["upgrade_requests"]["skipped"] += 1
            continue
        uid = email_to_user_id[em]
        rid = _ensure_uuid(r.get("id"), f"req:{uid}:{r.get('created_at')}")
        status_val = str(r.get("status") or "pending").strip().lower()

        if rid in existing_req_ids or (status_val == "pending" and uid in existing_pending_user_ids):
            stats["upgrade_requests"]["skipped"] += 1
            continue

        if dry_run:
            existing_req_ids.add(rid)
            if status_val == "pending":
                existing_pending_user_ids.add(uid)
            stats["upgrade_requests"]["migrated"] += 1
            continue

        req_payload = {
            "id": rid,
            "user_id": uid,
            "email": em,
            "full_name": str(r.get("full_name") or em.split("@")[0]),
            "target_tier": str(r.get("target_tier") or "pro").strip().lower(),
            "duration_days": int(r.get("duration_days") or 30),
            "transfer_amount": str(r.get("transfer_amount") or ""),
            "transfer_datetime": str(r.get("transfer_datetime") or ""),
            "account_last4": str(r.get("account_last4") or ""),
            "slip_ref": str(r.get("slip_ref") or ""),
            "contact_note": str(r.get("contact_note") or ""),
            "status": status_val if status_val in ("pending", "approved", "rejected", "cancelled") else "pending",
            "admin_note": str(r.get("admin_note") or ""),
            "created_at": r.get("created_at") or datetime.now(timezone.utc).isoformat(),
            "decided_at": r.get("decided_at"),
            "decided_by": normalize_email(r.get("decided_by")) if r.get("decided_by") else None,
            "applied_duration_days": r.get("applied_duration_days"),
            "applied_expires_at": r.get("applied_expires_at"),
        }
        try:
            resp = repo._request("POST", "qf_upgrade_requests", json_body=req_payload, prefer="resolution=ignore-duplicates,return=minimal")
            if resp.status_code in (200, 201, 204):
                existing_req_ids.add(rid)
                if status_val == "pending":
                    existing_pending_user_ids.add(uid)
                stats["upgrade_requests"]["migrated"] += 1
            else:
                stats["upgrade_requests"]["errors"] += 1
        except Exception as exc:
            print(f"  [WARN] Upgrade request {rid}: {exc}")
            stats["upgrade_requests"]["errors"] += 1

    if not dry_run:
        repo.write_audit_log(
            action="json_to_supabase_migration",
            actor_email="migration_script",
            details=stats,
        )

    return stats


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Migrate quantfolio_users_db.json to Supabase PostgreSQL (idempotent)")
    parser.add_argument(
        "--source",
        default=str(Path(__file__).resolve().parent / "quantfolio_users_db.json"),
        help="Path to quantfolio_users_db.json",
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview migration without writing to Supabase")
    args = parser.parse_args(argv)

    source_path = Path(args.source)
    source_data = load_source_json(source_path)

    sb_url = os.environ.get("SUPABASE_URL", "").strip()
    sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not args.dry_run and (not sb_url or not sb_key):
        print("ERROR: กรุณาตั้งค่า SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY ก่อนรันสคริปต์ (หรือใช้ --dry-run เพื่อตรวจสอบ)")
        return 1

    repo = SupabasePostgrestRepository(sb_url or "https://dry-run.local", sb_key or "dry-run-key")
    mode_label = "DRY-RUN (ไม่เขียนข้อมูลจริง)" if args.dry_run else f"LIVE MIGRATION -> {sb_url}"
    print(f"=== QuantFolio Migration: {mode_label} ===")
    stats = migrate_data_to_supabase(source_data, repo, dry_run=args.dry_run)
    for table_name, counts in stats.items():
        print(f"  {table_name:18s}: migrated={counts['migrated']}  skipped={counts['skipped']}  errors={counts['errors']}")
    total_errors = sum(c["errors"] for c in stats.values())
    return 1 if total_errors > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
