import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_p0_1_mobile_header_compact_tier_and_declutter():
    html = _read("index.html")
    css = _read("styles.css")
    auth_js = _read("supabase_auth.js")

    # Compact short tier text span exists for <640px while preserving full #header-tier-badge-text on sm+
    assert 'id="header-tier-badge-text" class="hidden sm:inline"' in html
    assert 'id="header-tier-badge-text-short" class="inline sm:hidden"' in html
    assert "hdrBadgeTxtShort" in auth_js

    # Mobile <480px hides workspace wordmark & duplicate privacy/theme buttons (both live in gear dropdown)
    assert "body.qf-view-workspace #header-brand-wordmark" in css
    assert "#header-quick-privacy-btn," in css
    assert "#header-workspace-theme-btn" in css


def test_p0_2_dropped_invalid_tickers_sync_and_warning():
    html = _read("index.html")
    app_js = _read("app.js")

    assert 'id="dropped-tickers-banner"' in html
    assert 'id="dropped-tickers-banner-text"' in html
    assert "data.metadata?.missing_tickers" in app_js
    assert "data.metadata?.dropped_tickers" in app_js
    assert "function showDroppedTickersBanner(" in app_js
    assert "function dismissDroppedTickersBanner(" in app_js
    assert "state.tickers = [...validTickers];" in app_js


def test_p0_3_suitability_panel_gated_inside_advisor_whitelabel():
    html = _read("index.html")
    app_js = _read("app.js")

    # #pdf-cfg-suitability-panel MUST sit INSIDE #pdf-cfg-whitelabel-fields (hidden for non-Advisor)
    wl_idx = html.index('id="pdf-cfg-whitelabel-fields"')
    suit_idx = html.index('id="pdf-cfg-suitability-panel"')
    license_idx = html.index('id="pdf-cfg-license-type"')
    assert wl_idx < suit_idx < license_idx, "#pdf-cfg-suitability-panel must be nested inside #pdf-cfg-whitelabel-fields"

    # Non-advisor (simulation) mode forces neutral general/auto in both confirm & evaluate functions
    eval_fn = app_js.split("function evaluatePdfFairDealingCompliance(")[1].split("\nfunction ")[0]
    assert "const segMeta = isAdvisorMode" in eval_fn
    assert "const suitMeta = isAdvisorMode" in eval_fn


def test_p1_1_cloud_vault_always_visible_outside_tab_body_goals():
    html = _read("index.html")
    tab_goals_section = html.split('id="tab-view-goals"')[1].split("</section>")[0]
    # #saved-portfolios-vault-card must come AFTER #tab-body-goals closes
    vault_pos = tab_goals_section.index('<div id="saved-portfolios-vault-card"')
    before_vault = tab_goals_section[:vault_pos]
    # Verify balanced divs before vault: tab-body-goals & section-goal-builder are both closed
    assert "<!-- Card 5.3 (Always Visible Outside #tab-body-goals):" in tab_goals_section
    assert before_vault.count("<div") == before_vault.count("</div>"), (
        "All wrapper divs (#tab-body-goals, #section-goal-builder) must close before #saved-portfolios-vault-card"
    )


def test_p1_2_vulnerable_14pct_warning_clarity():
    app_js = _read("app.js")
    assert "สูงกว่าเกณฑ์แนะนำสำหรับผู้ลงทุนเปราะบาง (≤ 14%/ปี)" in app_js


def test_p1_3_copy_consistency_and_no_internal_tab3_jargon():
    html = _read("index.html")
    auth_js = _read("supabase_auth.js")

    guide_panel = html.split('id="help-tab-panel-guide"')[1].split('id="help-tab-panel-privacy"')[0]
    assert "Tab 3" not in guide_panel
    assert "ทดสอบย้อนหลัง" in guide_panel
    assert "1. เลือกสินทรัพย์" in guide_panel and "5. เป้าหมาย DCA" in guide_panel

    # Guest toast must no longer claim "ครบทุกฟังก์ชัน"
    assert "สามารถใช้งานวิเคราะห์พอร์ตได้ครบทุกฟังก์ชัน" not in auth_js
    assert "สูงสุด 5 สินทรัพย์" in auth_js


def test_p1_4_logout_clears_password_inputs():
    auth_js = _read("supabase_auth.js")
    logout_fn = auth_js.split("async function logoutUser(")[1].split("\nasync function ")[0]
    assert "'real-auth-password'" in logout_fn
    assert "el.value = ''" in logout_fn


def test_p1_5_fx_roundtrip_anchor_and_p1_6_pdf_meta_nowrap():
    app_js = _read("app.js")
    assert "fxRoundTripAnchor" in app_js
    assert "restoringBase" in app_js

    meta_block = app_js.split(".doc-meta-right {")[1].split("}")[0]
    assert "flex-shrink: 0" in meta_block
    assert "white-space: nowrap" in meta_block


def test_p2_and_declutter_improvements_and_static_parity():
    html = _read("index.html")
    app_js = _read("app.js")
    auth_js = _read("supabase_auth.js")

    # Declutter #1: Guest PDF preview hides secondary duplicate lock button
    assert "openTabBtnEl.classList.toggle('hidden', !tierInfo.canDownloadSimPdf)" in app_js

    # Declutter #3: Collapsible mobile hero result strip on Tabs 3-5
    assert 'id="global-result-strip-compact-bar"' in html
    assert "function syncGlobalResultStripMobileMode()" in app_js
    assert "function toggleGlobalResultStripMobile(" in app_js

    # P2-2: Largest-remainder 1-decimal rounding helper
    assert "function roundWeightsToOneDecimalSum100(" in app_js

    # P2-3: Whole-unit actual weight chip
    assert "ใช้จริง ${actualW.toFixed(1)}%" in app_js

    # P2-4: Shortened IP dropdown label
    assert "กลุ่ม 5: ผู้วางแผนการลงทุน (IP) • จัดพอร์ตเฉพาะราย</option>" in html

    # P2-5: Empty toast guard in both app.js and supabase_auth.js
    assert "if (!cleanMsg) return;" in app_js
    assert "if (!cleanMsg) return;" in auth_js

    # Cache bust version bumped to 6.30 and Root <-> static/ SHA-256 parity 4/4
    assert "?v=6.30" in html
    for fname in ("index.html", "styles.css", "app.js", "supabase_auth.js"):
        h_root = hashlib.sha256((ROOT / fname).read_bytes()).hexdigest()
        h_static = hashlib.sha256((ROOT / "static" / fname).read_bytes()).hexdigest()
        assert h_root == h_static, f"Root <-> static mismatch for {fname}"
