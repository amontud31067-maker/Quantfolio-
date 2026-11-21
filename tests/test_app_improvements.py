"""
Regression test suite for QuantFolio UI/UX, Responsive, Dark Mode, Tab Deduplication,
Landing Streamlining, and Project Hygiene improvements (without altering optimizer.py).
"""
import hashlib
import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import app as quantfolio_app
from tests.test_access_control import ASGITestClient


def _read_text(rel_path: str) -> str:
    with open(os.path.join(PROJECT_ROOT, rel_path), "r", encoding="utf-8") as f:
        return f.read()


def _sha256(rel_path: str) -> str:
    with open(os.path.join(PROJECT_ROOT, rel_path), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def test_landing_navbar_never_overlaps_on_medium_or_wide_screens():
    html = _read_text("index.html")
    app_js = _read_text("app.js")

    nav_block = html.split('id="header-landing-nav"')[1].split("</nav>")[0]
    assert "hidden lg:flex" in nav_block
    assert "2xl:inline" not in nav_block, "English parentheticals at 2xl overflow max-w-7xl header"

    actions_tag = html.split('id="header-workspace-actions"')[1].split(">")[0]
    assert "hidden" in actions_tag, "Workspace actions must stay hidden on Landing to keep navbar clean"

    set_view_fn = app_js.split("function setAppView(")[1].split("\nfunction ")[0]
    assert "landingNavEl.classList.add('hidden')" in set_view_fn
    assert "landingNavEl.classList.toggle('hidden'" not in set_view_fn
    assert "landingNavEl.classList.toggle('lg:flex'" in set_view_fn
    assert "header-workspace-actions" in set_view_fn
    assert "header-landing-theme-btn" in set_view_fn


def test_landing_bottom_quickstart_and_dark_mockup_removed():
    html = _read_text("index.html")
    assert 'id="landing-hero-logo"' not in html
    assert '/static/quantfolio-logo.svg' in html
    assert 'id="preview-widget"' not in html
    assert 'id="landing-budget-input"' not in html
    assert 'id="landing-preview-card"' not in html
    assert 'id="landing-preset-card-colab_original"' not in html
    assert "กำหนดงบลงทุนและชุดสินทรัพย์เริ่มต้นได้ทันที" not in html


def test_dark_mode_covers_segmented_trays_and_kpi_tint_cards():
    css = _read_text("styles.css")
    required_selectors = [
        r".fin-card .bg-slate-100\/90",
        r"#main-nav-tabs .bg-slate-100\/90",
        r".fin-card .bg-slate-200\/80",
        r".bg-emerald-50\/35",
        r".bg-blue-50\/35",
        r".bg-amber-50\/35",
        r".bg-rose-50\/35",
        r".via-white",
        r".to-emerald-50\/30",
    ]
    for sel in required_selectors:
        assert sel in css, f"Missing Dark Mode override selector: {sel}"


def test_workspace_tabs_and_tab4_compact_tables_prevent_clipping():
    html = _read_text("index.html")
    css = _read_text("styles.css")

    nav_open = html.split('id="main-nav-tabs"')[1].split(">")[0]
    assert "xl:sticky" in nav_open
    assert "flex-wrap" in nav_open
    assert "@media (min-width: 768px) and (max-width: 1279px)" in css

    assert ".qf-compact-table th" in css
    assert "white-space: normal;" in css.split(".qf-compact-table th")[1].split("}")[0]

    tab4_growth = html.split('id="tab-content-growth"')[1].split('id="tab-content-frontier"')[0]
    tab4_assets = html.split('id="tab-content-assets"')[1].split('id="correlation-plot-container"')[0]
    assert "qf-compact-table" in tab4_growth
    assert "qf-compact-table" in tab4_assets


def test_tab2_view_switcher_and_tab3_four_badges_plus_show_more():
    html = _read_text("index.html")
    app_js = _read_text("app.js")

    # Tab 2: cards/table switcher is visible in execution card header (not wrapped in .hidden)
    exec_header = html.split('id="step-3-execution-card"')[1].split('id="order-kpi-budget"')[0]
    assert 'id="tp-view-btn-cards"' in exec_header
    assert 'id="tp-view-btn-table"' in exec_header
    assert "plan.totalBuyNet" in app_js and "plan.totalBuy," not in app_js

    # Tab 3: 4 distinct signal badges + show-more news toggle
    assert 'id="insights-count-overbought"' in html
    assert 'id="insights-count-caution"' in html
    assert "🟡 ร้อนแรง/ควรระวัง" not in html
    assert 'id="insights-news-toggle-btn"' in html
    assert "function toggleInsightsNewsExpand(" in app_js


def test_project_hygiene_ignore_files_legacy_cleanup_and_parity():
    gitignore = _read_text(".gitignore")
    dockerignore = _read_text(".dockerignore")
    vercelignore = _read_text(".vercelignore")

    for entry in ("node_modules/", ".pytest_cache/", "*.zip", "GITHUB_UPLOAD_FILES/"):
        assert entry in gitignore, f"Missing {entry} in .gitignore"

    for entry in ("landing-web/", "GITHUB_UPLOAD_FILES/", ".pytest_cache/"):
        assert entry in dockerignore, f"Missing {entry} in .dockerignore"
        assert entry in vercelignore, f"Missing {entry} in .vercelignore"

    # Legacy static/v2_preview.html removed and not allowlisted
    assert not os.path.exists(os.path.join(PROJECT_ROOT, "static", "v2_preview.html"))
    assert "v2_preview.html" not in quantfolio_app.PUBLIC_ROOT_ALLOWLIST

    # Health version aligned to 4.2.0
    client = ASGITestClient(quantfolio_app.app)
    health = client.get("/api/health").json()
    assert health["status"] == "ok"
    assert health["version"] == "4.2.0"

    # Root <-> static/ exact SHA-256 parity
    for fn in ("index.html", "styles.css", "app.js", "supabase_auth.js"):
        assert _sha256(fn) == _sha256(os.path.join("static", fn)), f"Parity mismatch: {fn}"


def test_setup_guided_flow_readiness_and_non_ejecting_modes():
    html = _read_text("index.html")
    app_js = _read_text("app.js")
    css = _read_text("styles.css")

    setup_block = html.split('id="tab-view-setup"')[1].split('id="tab-view-trade-plan"')[0]
    # 1. Clean guided setup + collapsed-by-default stock picker drawer + conditional warning bar
    for req_id in (
        "setup-mode-helper-bar",
        "setup-mode-helper-text",
        "setup-assets-status-pill",
        "stock-picker-drawer-btn",
        "setup-stock-picker-drawer",
        "stock-source-tab-catalog",
        "stock-source-tab-presets",
        "setup-presets-panel",
        "setup-readiness-bar",
        "setup-readiness-text",
    ):
        assert f'id="{req_id}"' in setup_block, f"Missing guided setup element #{req_id}"

    # Popular stock picker drawer & mode helper bar start collapsed/hidden by default
    picker_drawer_tag = setup_block.split('id="setup-stock-picker-drawer"')[1].split(">")[0]
    assert "hidden" in picker_drawer_tag, "Stock picker drawer must start collapsed by default"
    helper_bar_tag = setup_block.split('id="setup-mode-helper-bar"')[1].split(">")[0]
    assert "hidden" in helper_bar_tag, "Mode helper bar must start hidden on default mode"
    readiness_bar_tag = setup_block.split('id="setup-readiness-bar"')[1].split(">")[0]
    assert "hidden" in readiness_bar_tag, "Readiness warning bar must stay hidden when setup is ready"

    # 2. Clear active check indicators on all 4 strategy cards & optional badge on Advanced drawer
    assert setup_block.count('class="qf-goal-check"') == 4
    assert ".goal-option.active .qf-goal-check" in css
    assert "ไม่บังคับ" in setup_block

    # 3. Switching mode in Tab 1 must NOT immediately eject user to another tab before calculating
    mode_fn = app_js.split("function selectPrimaryInvestmentMode(")[1].split("\nfunction ")[0]
    assert "switchAppTab(" not in mode_fn, "selectPrimaryInvestmentMode must stay on Setup instead of ejecting user"
    assert "function toggleStockPickerDrawer(" in app_js
    assert "function switchStockPickerSource(" in app_js
    assert "function updateSetupReadinessUI(" in app_js
    assert "function jumpToActivePrimaryModeResult(" in app_js


def test_tab2_strategy_comparison_and_complete_asset_breakdown():
    html = _read_text("index.html")
    app_js = _read_text("app.js")
    css = _read_text("styles.css")

    # 1. Global result strip is a high-contrast dark hero focal point with clean 3-element KPIs (no cluttered vs-lines)
    strip_block = html.split('id="global-result-strip"')[1].split('id="tab-view-setup"')[0]
    assert "qf-hero-result-strip" in strip_block
    assert "#global-result-strip.qf-hero-result-strip" in css
    for old_vs in ("kpi-return-vs", "kpi-vol-vs", "kpi-mdd-vs", "kpi-sharpe-vs"):
        assert f'id="{old_vs}"' not in strip_block, f"Redundant clutter #{old_vs} should stay out of top hero strip"
    budget_input_tag = strip_block.split('id="strip-budget-input"')[1].split(">")[0]
    assert "text-left" in budget_input_tag, "Inline budget input should hug currency symbol tightly with text-left"
    assert "จากจุดสูงสุด" in app_js
    assert "จุดต่ำสุด ${formatMoney" not in app_js.split("mddRemEl.innerHTML =")[1].split("\n")[0]

    # 2. Tab 2 Left Card: Interactive 4-strategy comparison vs Equal Weight (1/N)
    trade_block = html.split('id="tab-view-trade-plan"')[1].split('id="tab-view-insights"')[0]
    for req_id in (
        "strat-compare-verdict",
        "strat-compare-metric-tabs",
        "strat-cmp-tab-return",
        "strat-cmp-tab-volatility",
        "strat-cmp-tab-sharpe",
        "strat-compare-bars",
    ):
        assert f'id="{req_id}"' in trade_block, f"Missing strategy comparison element #{req_id}"
    assert "function selectStrategyCompareMetric(" in app_js
    assert "function renderStrategyComparisonCard(" in app_js
    assert "qf-vbar-col" in app_js and "qfVbarActiveGrad" in app_js
    assert "qf-delta-tile" in app_js and ".qf-delta-tile.is-good" in css
    assert "qf-vbar-stage" in trade_block

    # 3. Tab 2 Right Card: Complete top-aligned asset breakdown (no justify-between gap, no 300px row clipping)
    holdings_tag = trade_block.split('id="dime-holdings-card"')[1].split(">")[0]
    assert "justify-between" not in holdings_tag, "#dime-holdings-card must be top-aligned without blank top gap"
    holdings_list_tag = trade_block.split('id="dime-holdings-card-list"')[1].split(">")[0]
    assert "max-h-[300px]" not in holdings_list_tag, "#dime-holdings-card-list must not slice asset rows at 300px"
    assert 'id="dime-holdings-footer"' in trade_block
    assert "เงินลงทุนแยกตามหุ้น" not in trade_block
    assert "สัดส่วน &amp; เงินลงทุนแยกตามสินทรัพย์" in trade_block

    # 4. Donut chart prevents clipping of tiny outside labels
    donut_fn = app_js.split("function renderDonutAllocationChart(")[1].split("\n/**")[0]
    assert "automargin: true" in donut_fn


def test_tab2_deep_dive_real_pnl_and_streamlined_flow():
    html = _read_text("index.html")
    app_js = _read_text("app.js")

    # 1. Existing portfolio editor supports real Cost + signed Negative/Positive P&L
    trade_block = html.split('id="tab-view-trade-plan"')[1].split('id="tab-view-insights"')[0]
    for req_id in ("custom-total-cost-val", "custom-total-pnl-val", "custom-total-portfolio-val"):
        assert f'id="{req_id}"' in trade_block, f"Missing existing portfolio summary #{req_id}"
    assert "customCost:" in app_js and "customPnl:" in app_js
    assert "function handleCustomCostPnlInput(" in app_js
    assert "formatLiveCommaInput(this, true); handleCustomCostPnlInput(this, 'pnl')" in app_js

    # 2. Streamlined cash-flow pairing (eliminates triple duplication & awkward wrapping arrow)
    flow_fn = app_js.split("function renderRebalanceActionSummaryBox(")[1].split("\nfunction ")[0]
    assert "sm:grid-cols-[1fr_auto_1fr]" in flow_fn
    assert "สรุปภาพรวม: ให้สั่งขาย" not in flow_fn
    assert "รายการที่ต้องสั่งขายก่อน (SELL)" not in flow_fn
    assert "นำเงินที่ได้ไปสั่งซื้อ (BUY)" not in flow_fn

    # 3. Streamlined 4-tile existing-vs-target portfolio audit strip
    audit_fn = app_js.split("function renderExistingPortfolioAudit(")[1].split("\n// ===")[0]
    assert "เทียบพอร์ตเดิมของคุณ ➔ พอร์ตเป้าหมาย" in audit_fn
    assert "qf-delta-tile" in audit_fn


def test_tab2_full_audit_fixes():
    html = _read_text("index.html")
    app_js = _read_text("app.js")
    css = _read_text("styles.css")

    # 1. Dark Mode #order-kpi-budget high-contrast fix + privacy input blur
    assert "html body.theme-dark #order-kpi-budget" in css
    assert "body.qf-privacy-hidden .qf-privacy-input" in css
    assert "body.qf-privacy-hidden .qf-privacy-input:focus" in css

    # 2. Complete Privacy Mode masking across Tab 2
    assert "function maskIfPrivate(" in app_js
    priv_fn = app_js.split("function toggleBalancePrivacy(")[1].split("\nfunction ")[0]
    assert "qf-privacy-hidden" in priv_fn
    assert "renderActiveGoalView();" in priv_fn
    assert "maskIfPrivate(formatMoney(plan.totalPortfolioBudget" in app_js

    # 3. Stale checkmarks cleared on strategy, rebalance mode, and unit mode changes
    for fn_name in ("function selectGoal(", "function setRebalanceMode(", "function setOrderExecutionUnitMode("):
        block = app_js.split(fn_name)[1].split("\nfunction ")[0]
        assert "state.executedOrders = {}" in block, f"{fn_name} must clear stale executedOrders"

    # 4. Whole-unit rounding reason for high-priced assets + Copy/CSV accuracy
    assert "WHOLE_UNIT_TOO_EXPENSIVE" in app_js
    assert "เกินงบเต็มหน่วย" in app_js
    copy_fn = app_js.split("function copyOrderSheet(")[1].split("\nfunction ")[0]
    assert "หุ้น)" not in copy_fn, "copyOrderSheet must use 'หน่วย' instead of 'หุ้น'"
    assert "plan.executionUnitMode === 'whole'" in copy_fn
    csv_fn = app_js.split("function downloadOrderCSV(")[1].split("\n// ")[0]
    assert "revokeObjectURL" in csv_fn and "Currency,ExecutionMode" in csv_fn

    # 5. Stale async request guard on THB <-> USD switch + proportional audit drawdown + withdrawal pill
    assert "optRequestId:" in app_js and "reqId !== state.optRequestId" in app_js
    assert "budgetScale" in app_js and "ลงลึกขึ้น +" in app_js
    assert "โหมดขายรับเงินสดเพื่อถอนออก" in app_js and "ถอนออก " in app_js

    # 6. Mobile 390px zero-overflow grid & bottom-nav footer clearance
    strip_block = html.split('id="global-result-strip"')[1].split('id="tab-view-setup"')[0]
    assert "qf-hero-pill-group grid grid-cols-2 sm:flex" in strip_block
    assert "#global-workspace-footer {\n    padding-bottom:" in css
    assert "grid-cols-1 sm:grid-cols-3" in app_js


def test_news_transparency_and_pure_historical_default():
    html = _read_text("index.html")
    app_js = _read_text("app.js")
    css = _read_text("styles.css")

    # 1. Pure historical default across state & Tab 1 setup drawer
    import re
    assert "useNewsAdjustment: false," in app_js
    assert "useNewsAdjustment: true," not in app_js
    news_toggle_tag = html.split('id="news-signal-toggle"')[1].split(">")[0]
    assert not re.search(r'(?<!\.)\bchecked\b', news_toggle_tag), "#news-signal-toggle must be unchecked by default"
    assert "สถิติอดีตล้วน" in html.split('id="setup-advanced-summary"')[1].split("<")[0]
    assert "เฉพาะ Max Sharpe" in html

    # 2. Landing methodology box honestly discloses Max Sharpe vs Min Volatility / HRP news impact
    limits_box = html.split('id="model-limitations-box"')[1].split("</aside>")[0]
    assert "Max Sharpe" in limits_box and "HRP" in limits_box and "Min Volatility" in limits_box
    assert "ราคาปิดย้อนหลังล้วน" in limits_box

    # 3. Tab 3 defaults to pure historical on left, includes dynamic impact banner, uses 'สินทรัพย์'
    insights_block = html.split('id="tab-view-insights"')[1].split('id="tab-view-backtest"')[0]
    assert insights_block.index('id="btn-news-adj-off"') < insights_block.index('id="btn-news-adj-on"')
    assert 'id="insights-news-impact-banner"' in insights_block
    assert "ครบทุกสินทรัพย์ในพอร์ต" in insights_block

    # 4. renderNewsAndSignalSection handles 3 truthful states & 1-click Max Sharpe shortcut + Dark Mode CSS
    render_fn = app_js.split("function renderNewsAndSignalSection()")[1].split("\nfunction refreshLiveMarketNews(")[0]
    assert "isNewsActiveOnWeights" in render_fn
    assert "data-banner-mode" in render_fn or "dataset.bannerMode" in render_fn
    assert "selectGoal('max_sharpe')" in render_fn
    assert "ลองดูผลบน Max Sharpe ➔" in render_fn
    assert "ใช้สัดส่วนสถิติ" in render_fn
    assert "html body.theme-dark .qf-news-impact-active" in css
    assert "html body.theme-dark .qf-news-impact-info" in css
    assert "html body.theme-dark .qf-banner-cta-btn" in css
