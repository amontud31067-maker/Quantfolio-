-- ============================================================================
-- QuantFolio Wealth Analytics - Production Supabase PostgreSQL Schema (v2.0)
-- วิธีใช้งาน: คัดลอกโค้ด SQL ทั้งหมดนี้ไปวางในเมนู "SQL Editor" บนหน้าเว็บ Supabase
-- แล้วกดปุ่ม "Run" เพื่อสร้างตาราง, Index, RLS และ Atomic RPC สำหรับ Vercel Serverless
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- Shared Trigger Helpers: updated_at & Email / Code Normalization
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.qf_normalize_email_field()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.email IS NOT NULL THEN
        NEW.email = lower(btrim(NEW.email));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.qf_normalize_code_field()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.code IS NOT NULL THEN
        NEW.code = upper(btrim(NEW.code));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 1. TABLE: public.qf_users (บัญชีผู้ใช้, สิทธิ์แพ็กเกจ, วัน-เวลาหมดอายุ, แอดมิน)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.qf_users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL CHECK (char_length(btrim(email)) > 2 AND email = lower(btrim(email))),
    full_name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    plan_tier TEXT NOT NULL DEFAULT 'free' CHECK (plan_tier IN ('free', 'pro', 'advisor')),
    plan_expires_at TIMESTAMPTZ NULL,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    custom_entitlements JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive UNIQUE email index (กันสมัครซ้ำแม้พิมพ์ตัวพิมพ์ใหญ่/เล็กต่างกัน)
CREATE UNIQUE INDEX IF NOT EXISTS idx_qf_users_email_lower
    ON public.qf_users (lower(email));
CREATE INDEX IF NOT EXISTS idx_qf_users_plan_tier
    ON public.qf_users (plan_tier);
CREATE INDEX IF NOT EXISTS idx_qf_users_plan_expires_at
    ON public.qf_users (plan_expires_at) WHERE plan_expires_at IS NOT NULL;

DROP TRIGGER IF EXISTS trg_qf_users_normalize_email ON public.qf_users;
CREATE TRIGGER trg_qf_users_normalize_email
    BEFORE INSERT OR UPDATE ON public.qf_users
    FOR EACH ROW EXECUTE FUNCTION public.qf_normalize_email_field();

DROP TRIGGER IF EXISTS trg_qf_users_updated_at ON public.qf_users;
CREATE TRIGGER trg_qf_users_updated_at
    BEFORE UPDATE ON public.qf_users
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================================
-- 2. TABLE: public.qf_portfolios (พอร์ตการลงทุนและแผนเป้าหมาย DCA บน Cloud)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.qf_portfolios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.qf_users(id) ON DELETE CASCADE,
    email TEXT NOT NULL CHECK (email = lower(btrim(email))),
    portfolio_name TEXT NOT NULL CHECK (char_length(btrim(portfolio_name)) > 0),
    goal_type TEXT NOT NULL DEFAULT 'custom',
    goal_label TEXT NOT NULL DEFAULT 'เป้าหมายส่วนตัว',
    target_amount NUMERIC(18, 2) NOT NULL DEFAULT 100000.00 CHECK (target_amount >= 0),
    initial_budget NUMERIC(18, 2) NOT NULL DEFAULT 100000.00 CHECK (initial_budget >= 0),
    monthly_dca NUMERIC(18, 2) NOT NULL DEFAULT 0.00 CHECK (monthly_dca >= 0),
    investment_period_years INTEGER NOT NULL DEFAULT 5 CHECK (investment_period_years BETWEEN 1 AND 100),
    currency TEXT NOT NULL DEFAULT 'THB' CHECK (currency IN ('THB', 'USD')),
    tickers JSONB NOT NULL DEFAULT '[]'::jsonb,
    asset_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
    strategy_key TEXT NOT NULL DEFAULT 'max_sharpe',
    expected_return NUMERIC(10, 6) NOT NULL DEFAULT 0,
    expected_volatility NUMERIC(10, 6) NOT NULL DEFAULT 0,
    dividend_yield NUMERIC(10, 6) NOT NULL DEFAULT 0,
    projected_final_value NUMERIC(18, 2) NOT NULL DEFAULT 0,
    goal_achievement_pct NUMERIC(10, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qf_portfolios_user_id_created
    ON public.qf_portfolios (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qf_portfolios_email_lower
    ON public.qf_portfolios (lower(email));

DROP TRIGGER IF EXISTS trg_qf_portfolios_normalize_email ON public.qf_portfolios;
CREATE TRIGGER trg_qf_portfolios_normalize_email
    BEFORE INSERT OR UPDATE ON public.qf_portfolios
    FOR EACH ROW EXECUTE FUNCTION public.qf_normalize_email_field();

DROP TRIGGER IF EXISTS trg_qf_portfolios_updated_at ON public.qf_portfolios;
CREATE TRIGGER trg_qf_portfolios_updated_at
    BEFORE UPDATE ON public.qf_portfolios
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================================
-- 3. TABLE: public.qf_activation_codes (รหัสเปิดใช้งาน Pro / Advisor Pro)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.qf_activation_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL CHECK (char_length(btrim(code)) >= 4 AND code = upper(btrim(code))),
    plan_tier TEXT NOT NULL CHECK (plan_tier IN ('pro', 'advisor')),
    duration_days INTEGER NOT NULL DEFAULT 30 CHECK (duration_days >= 0),
    max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
    code_expires_at TIMESTAMPTZ NULL,
    used_by JSONB NOT NULL DEFAULT '[]'::jsonb,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at TIMESTAMPTZ NULL,
    revoked_by TEXT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_qf_activation_codes_code_upper
    ON public.qf_activation_codes (upper(code));
CREATE INDEX IF NOT EXISTS idx_qf_activation_codes_created
    ON public.qf_activation_codes (created_at DESC);

DROP TRIGGER IF EXISTS trg_qf_activation_codes_normalize_code ON public.qf_activation_codes;
CREATE TRIGGER trg_qf_activation_codes_normalize_code
    BEFORE INSERT OR UPDATE ON public.qf_activation_codes
    FOR EACH ROW EXECUTE FUNCTION public.qf_normalize_code_field();

-- ============================================================================
-- 4. TABLE: public.qf_upgrade_requests (คิวแจ้งโอน / ขออัปเกรดสมาชิก)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.qf_upgrade_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.qf_users(id) ON DELETE CASCADE,
    email TEXT NOT NULL CHECK (email = lower(btrim(email))),
    full_name TEXT NOT NULL DEFAULT '',
    target_tier TEXT NOT NULL CHECK (target_tier IN ('pro', 'advisor')),
    duration_days INTEGER NOT NULL DEFAULT 30 CHECK (duration_days >= 0),
    transfer_amount TEXT NOT NULL DEFAULT '',
    transfer_datetime TEXT NOT NULL DEFAULT '',
    account_last4 TEXT NOT NULL DEFAULT '',
    slip_ref TEXT NOT NULL DEFAULT '',
    contact_note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    admin_note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ NULL,
    decided_by TEXT NULL,
    applied_duration_days INTEGER NULL,
    applied_expires_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_qf_upgrade_requests_user_created
    ON public.qf_upgrade_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qf_upgrade_requests_status_created
    ON public.qf_upgrade_requests (status, created_at DESC);

-- DB-Level Anti-Spam Guard: บังคับไม่เกิน 1 คำขอสถานะ pending ต่อ 1 บัญชี แม้ส่งชนกันพร้อมกัน
CREATE UNIQUE INDEX IF NOT EXISTS idx_qf_upgrade_requests_one_pending_per_user
    ON public.qf_upgrade_requests (user_id)
    WHERE status = 'pending';

DROP TRIGGER IF EXISTS trg_qf_upgrade_requests_normalize_email ON public.qf_upgrade_requests;
CREATE TRIGGER trg_qf_upgrade_requests_normalize_email
    BEFORE INSERT OR UPDATE ON public.qf_upgrade_requests
    FOR EACH ROW EXECUTE FUNCTION public.qf_normalize_email_field();

-- ============================================================================
-- 5. TABLE: public.qf_audit_logs (บันทึกเหตุการณ์ความปลอดภัยและการเปลี่ยนสิทธิ์)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.qf_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID NULL,
    actor_email TEXT NULL,
    target_user_id UUID NULL,
    target_email TEXT NULL,
    action TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qf_audit_logs_created
    ON public.qf_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qf_audit_logs_target_email
    ON public.qf_audit_logs (lower(target_email)) WHERE target_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_qf_audit_logs_action
    ON public.qf_audit_logs (action, created_at DESC);

-- ============================================================================
-- 6. STRICT ROW LEVEL SECURITY (ล็อกสิทธิ์ตาราง qf_* เฉพาะ Backend service_role)
-- ============================================================================
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'qf_users',
        'qf_portfolios',
        'qf_activation_codes',
        'qf_upgrade_requests',
        'qf_audit_logs'
    ] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format('REVOKE ALL ON public.%I FROM anon', tbl);
        EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', tbl);
        EXECUTE format('REVOKE ALL ON public.%I FROM public', tbl);
        EXECUTE format('GRANT ALL ON public.%I TO service_role', tbl);
    END LOOP;
END $$;

-- ============================================================================
-- 7. ATOMIC SERVERLESS RPCs (ป้องกัน Race Condition / Double-Click บน Vercel)
-- ============================================================================

-- 7.1 อนุมัติ/ปฏิเสธคำขอแจ้งโอนแบบ Atomic (ล็อกแถว FOR UPDATE, กันเบิ้ลคลิกทบวันซ้ำ -> 409)
CREATE OR REPLACE FUNCTION public.qf_decide_upgrade_request_atomic(
    p_request_id UUID,
    p_decision TEXT,
    p_admin_email TEXT,
    p_admin_note TEXT DEFAULT '',
    p_override_duration_days INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_req public.qf_upgrade_requests%ROWTYPE;
    v_user public.qf_users%ROWTYPE;
    v_now TIMESTAMPTZ := now();
    v_days INTEGER;
    v_cur_tier TEXT;
    v_cur_exp TIMESTAMPTZ;
    v_new_exp TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_req
    FROM public.qf_upgrade_requests
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'http_status', 404, 'error', 'ไม่พบคำขออัปเกรดที่ระบุ');
    END IF;

    IF v_req.status <> 'pending' THEN
        RETURN jsonb_build_object(
            'ok', FALSE,
            'http_status', 409,
            'error', 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถอนุมัติหรือปฏิเสธซ้ำได้'
        );
    END IF;

    IF p_decision = 'reject' THEN
        UPDATE public.qf_upgrade_requests
        SET status = 'rejected',
            admin_note = COALESCE(p_admin_note, ''),
            decided_at = v_now,
            decided_by = lower(btrim(p_admin_email))
        WHERE id = p_request_id
        RETURNING * INTO v_req;

        INSERT INTO public.qf_audit_logs (actor_email, target_user_id, target_email, action, details)
        VALUES (
            lower(btrim(p_admin_email)), v_req.user_id, v_req.email,
            'upgrade_request_rejected',
            jsonb_build_object('request_id', p_request_id, 'admin_note', COALESCE(p_admin_note, ''))
        );

        RETURN jsonb_build_object('ok', TRUE, 'http_status', 200, 'request', to_jsonb(v_req));
    END IF;

    -- Approve branch: lock target user row & stack expiry if active same tier
    SELECT * INTO v_user
    FROM public.qf_users
    WHERE id = v_req.user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'http_status', 404, 'error', format('ไม่พบบัญชีผู้ใช้ %s ในระบบ', v_req.email));
    END IF;

    v_days := GREATEST(0, COALESCE(p_override_duration_days, v_req.duration_days, 30));
    v_cur_tier := v_user.plan_tier;
    v_cur_exp := v_user.plan_expires_at;

    IF v_days <= 0 THEN
        v_new_exp := NULL; -- Lifetime
    ELSE
        IF v_cur_tier = v_req.target_tier AND v_cur_exp IS NULL THEN
            v_new_exp := NULL; -- Preserve existing lifetime
        ELSIF v_cur_tier = v_req.target_tier AND v_cur_exp > v_now THEN
            v_new_exp := v_cur_exp + make_interval(days => v_days);
        ELSE
            v_new_exp := v_now + make_interval(days => v_days);
        END IF;
    END IF;

    UPDATE public.qf_users
    SET plan_tier = v_req.target_tier,
        plan_expires_at = v_new_exp,
        updated_at = v_now
    WHERE id = v_user.id
    RETURNING * INTO v_user;

    UPDATE public.qf_upgrade_requests
    SET status = 'approved',
        admin_note = COALESCE(p_admin_note, ''),
        decided_at = v_now,
        decided_by = lower(btrim(p_admin_email)),
        applied_duration_days = v_days,
        applied_expires_at = v_new_exp
    WHERE id = p_request_id
    RETURNING * INTO v_req;

    INSERT INTO public.qf_audit_logs (actor_email, target_user_id, target_email, action, details)
    VALUES (
        lower(btrim(p_admin_email)), v_user.id, v_user.email,
        'upgrade_request_approved',
        jsonb_build_object(
            'request_id', p_request_id,
            'target_tier', v_req.target_tier,
            'applied_duration_days', v_days,
            'applied_expires_at', v_new_exp
        )
    );

    RETURN jsonb_build_object(
        'ok', TRUE,
        'http_status', 200,
        'request', to_jsonb(v_req),
        'user', to_jsonb(v_user) - 'password_hash'
    );
END;
$$;

-- 7.2 กรอก Activation Code แบบ Atomic (ล็อกแถวโค้ด + ผู้ใช้, กันลดระดับสิทธิ์ & กันใช้โค้ดชนกัน)
CREATE OR REPLACE FUNCTION public.qf_redeem_activation_code_atomic(
    p_user_id UUID,
    p_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code_row public.qf_activation_codes%ROWTYPE;
    v_user public.qf_users%ROWTYPE;
    v_now TIMESTAMPTZ := now();
    v_clean_code TEXT := upper(btrim(COALESCE(p_code, '')));
    v_used_count INTEGER;
    v_already_used BOOLEAN;
    v_cur_rank INTEGER;
    v_target_rank INTEGER;
    v_effective_cur_tier TEXT;
    v_new_exp TIMESTAMPTZ;
    v_used_entry JSONB;
BEGIN
    SELECT * INTO v_code_row
    FROM public.qf_activation_codes
    WHERE upper(code) = v_clean_code
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'http_status', 403, 'error_code', 'CODE_NOT_FOUND', 'error', 'รหัสเปิดใช้งานไม่ถูกต้อง กรุณาตรวจสอบรหัสอีกครั้งหรือติดต่อผู้ดูแลระบบ');
    END IF;

    IF v_code_row.revoked THEN
        RETURN jsonb_build_object('ok', FALSE, 'http_status', 403, 'error_code', 'CODE_REVOKED', 'error', 'รหัสเปิดใช้งานนี้ถูกเพิกถอนแล้ว ไม่สามารถใช้งานได้');
    END IF;

    IF v_code_row.code_expires_at IS NOT NULL AND v_code_row.code_expires_at <= v_now THEN
        RETURN jsonb_build_object('ok', FALSE, 'http_status', 403, 'error_code', 'CODE_EXPIRED', 'error', 'รหัสเปิดใช้งานนี้หมดเขตรับสิทธิ์แล้ว');
    END IF;

    SELECT * INTO v_user
    FROM public.qf_users
    WHERE id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'http_status', 404, 'error_code', 'USER_NOT_FOUND', 'error', 'ไม่พบบัญชีผู้ใช้งาน');
    END IF;

    v_used_count := jsonb_array_length(COALESCE(v_code_row.used_by, '[]'::jsonb));
    IF v_used_count >= v_code_row.max_uses THEN
        RETURN jsonb_build_object('ok', FALSE, 'http_status', 403, 'error_code', 'CODE_EXHAUSTED', 'error', 'รหัสเปิดใช้งานนี้ถูกใช้งานครบตามจำนวนสิทธิ์แล้ว');
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(v_code_row.used_by, '[]'::jsonb)) elem
        WHERE lower(elem->>'email') = lower(v_user.email)
    ) INTO v_already_used;

    IF v_already_used THEN
        RETURN jsonb_build_object('ok', FALSE, 'http_status', 403, 'error_code', 'ALREADY_USED', 'error', 'บัญชีของคุณเคยใช้รหัสเปิดใช้งานชุดนี้ไปแล้ว ไม่สามารถใช้ซ้ำได้');
    END IF;

    -- Tier Change Guard: ห้ามลดระดับสิทธิ์ที่ยังไม่หมดอายุ (เช่น Advisor -> Pro)
    IF v_user.plan_tier IN ('pro', 'advisor') AND (v_user.plan_expires_at IS NULL OR v_user.plan_expires_at > v_now) THEN
        v_effective_cur_tier := v_user.plan_tier;
    ELSE
        v_effective_cur_tier := 'free';
    END IF;

    v_cur_rank := CASE v_effective_cur_tier WHEN 'advisor' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END;
    v_target_rank := CASE v_code_row.plan_tier WHEN 'advisor' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END;

    IF v_target_rank < v_cur_rank THEN
        RETURN jsonb_build_object(
            'ok', FALSE,
            'http_status', 400,
            'error_code', 'TIER_DOWNGRADE_BLOCKED',
            'error', 'บัญชีของคุณกำลังใช้งานแพ็กเกจที่สูงกว่าอยู่แล้ว ไม่สามารถนำรหัสแพ็กเกจระดับต่ำกว่ามาลดระดับสิทธิ์ได้ (ไม่ได้หักสิทธิ์รหัสนี้)'
        );
    END IF;

    -- Stack expiry if active same tier, or start fresh on upgrade / expired
    IF v_code_row.duration_days <= 0 THEN
        v_new_exp := NULL;
    ELSIF v_effective_cur_tier = v_code_row.plan_tier AND v_user.plan_expires_at IS NULL THEN
        v_new_exp := NULL;
    ELSIF v_effective_cur_tier = v_code_row.plan_tier AND v_user.plan_expires_at > v_now THEN
        v_new_exp := v_user.plan_expires_at + make_interval(days => v_code_row.duration_days);
    ELSE
        v_new_exp := v_now + make_interval(days => v_code_row.duration_days);
    END IF;

    v_used_entry := jsonb_build_object(
        'email', v_user.email,
        'user_id', v_user.id::text,
        'used_at', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"')
    );

    UPDATE public.qf_activation_codes
    SET used_by = COALESCE(used_by, '[]'::jsonb) || jsonb_build_array(v_used_entry)
    WHERE id = v_code_row.id;

    UPDATE public.qf_users
    SET plan_tier = v_code_row.plan_tier,
        plan_expires_at = v_new_exp,
        updated_at = v_now
    WHERE id = v_user.id
    RETURNING * INTO v_user;

    INSERT INTO public.qf_audit_logs (actor_user_id, actor_email, target_user_id, target_email, action, details)
    VALUES (
        v_user.id, v_user.email, v_user.id, v_user.email,
        'activation_code_redeemed',
        jsonb_build_object(
            'code', v_code_row.code,
            'plan_tier', v_code_row.plan_tier,
            'duration_days', v_code_row.duration_days,
            'plan_expires_at', v_new_exp
        )
    );

    RETURN jsonb_build_object(
        'ok', TRUE,
        'http_status', 200,
        'plan_tier', v_code_row.plan_tier,
        'duration_days', v_code_row.duration_days,
        'plan_expires_at', v_new_exp,
        'user', to_jsonb(v_user) - 'password_hash'
    );
END;
$$;

-- Restrict RPC execution strictly to Backend service_role
REVOKE EXECUTE ON FUNCTION public.qf_decide_upgrade_request_atomic(UUID, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qf_decide_upgrade_request_atomic(UUID, TEXT, TEXT, TEXT, INTEGER) TO service_role;

REVOKE EXECUTE ON FUNCTION public.qf_redeem_activation_code_atomic(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qf_redeem_activation_code_atomic(UUID, TEXT) TO service_role;

-- ============================================================================
-- 8. LEGACY COMPATIBILITY TABLE: public.user_portfolios (Strict RLS Preserved)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.user_portfolios (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    portfolio_name TEXT NOT NULL CHECK (char_length(trim(portfolio_name)) > 0),
    target_amount NUMERIC(15, 2) NOT NULL DEFAULT 100000.00 CHECK (target_amount >= 0),
    investment_period_years INTEGER NOT NULL DEFAULT 5 CHECK (investment_period_years >= 1 AND investment_period_years <= 100),
    asset_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
    strategy_key TEXT DEFAULT 'max_sharpe',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_portfolios_user_id ON public.user_portfolios(user_id);
CREATE INDEX IF NOT EXISTS idx_user_portfolios_created_at ON public.user_portfolios(created_at DESC);

ALTER TABLE public.user_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_portfolios FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.user_portfolios FROM anon;
REVOKE ALL ON public.user_portfolios FROM public;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_portfolios TO authenticated;

DROP POLICY IF EXISTS "Users can view their own portfolios" ON public.user_portfolios;
CREATE POLICY "Users can view their own portfolios"
    ON public.user_portfolios
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own portfolios" ON public.user_portfolios;
CREATE POLICY "Users can insert their own portfolios"
    ON public.user_portfolios
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own portfolios" ON public.user_portfolios;
CREATE POLICY "Users can update their own portfolios"
    ON public.user_portfolios
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own portfolios" ON public.user_portfolios;
CREATE POLICY "Users can delete their own portfolios"
    ON public.user_portfolios
    FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_user_portfolios_updated_at ON public.user_portfolios;
CREATE TRIGGER set_user_portfolios_updated_at
    BEFORE UPDATE ON public.user_portfolios
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();
