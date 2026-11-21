"""
TDD regression suite for Tab 5 (Goals, DCA Simulator, Always-Usable Saved Portfolios Vault)
and the 2-Page A4 Modern Institutional Client PDF Executive Report (IBM Plex Sans Thai + IBM Plex Mono).
"""
import os

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read_text(rel_path: str) -> str:
    with open(os.path.join(PROJECT_ROOT, rel_path), "r", encoding="utf-8") as f:
        return f.read()


def test_tab5_goal_simulator_and_saved_vault_structure():
    html = _read_text("index.html")
    app_js = _read_text("app.js")
    auth_js = _read_text("supabase_auth.js")
    css = _read_text("styles.css")

    tab5 = html.split('id="tab-view-goals"')[1].split('id="loading-card"')[0]

    # 1. Card 5.1 includes initial budget sync input, inflation toggle pills, and editing banner
    for req_id in (
        "save-portfolio-name",
        "save-goal-category",
        "save-initial-budget",
        "save-target-amount",
        "save-monthly-dca",
        "save-period-years",
        "goal-infl-0",
        "goal-infl-25",
        "goal-infl-30",
        "editing-saved-portfolio-banner",
    ):
        assert f'id="{req_id}"' in tab5, f"Missing Tab 5 control #{req_id}"

    # Apply-tickers checkbox must NOT be checked by default (protects user's custom portfolio)
    apply_tickers_tag = tab5.split('id="goal-template-apply-tickers"')[1].split(">")[0]
    assert "checked" not in apply_tickers_tag, "goal-template-apply-tickers should default unchecked"

    # 2. Card 5.2 displays Smart Advice upfront, 3-Scenario strip, and Per-Asset DCA schedule table
    for req_id in (
        "goal-smart-advice-box",
        "goal-scenarios-strip",
        "goal-projection-chart",
        "goal-dca-schedule-body",
        "btn-open-pdf-modal",
        "btn-save-portfolio",
    ):
        assert f'id="{req_id}"' in tab5, f"Missing Card 5.2 element #{req_id}"
    assert "deep-dive-body-goals" not in tab5, "Saved Portfolios Vault & Smart Advice must be upfront, not hidden in collapsed drawer"

    # 3. Card 5.3 Always-Visible Saved Portfolios Vault with Export / Import JSON
    assert 'id="saved-portfolios-vault-card"' in tab5
    assert 'id="saved-portfolios-container"' in tab5
    assert "exportSavedPortfoliosJson()" in tab5
    assert "triggerImportSavedPortfoliosJson()" in tab5

    # 4. Guest LocalStorage Save / Update / Delete / Export / Import + Cloud Auto-Migration
    assert "GUEST_PORTFOLIOS_STORAGE_KEY" in auth_js
    assert "function migrateGuestPortfoliosToAuthenticatedUser(" in auth_js
    assert "function editSavedPortfolioInForm(" in auth_js
    assert "function exportSavedPortfoliosJson(" in auth_js
    assert "function handleImportSavedPortfoliosFile(" in auth_js
    save_fn = auth_js.split("async function saveUserPortfolio(")[1].split("async function fetchUserPortfolios(")[0]
    assert "if (!currentUser) {\n    openSupabaseConfigModal();" not in save_fn, "Guest users must be able to save locally without login wall"
    assert "openPdfReportConfigModal(" in auth_js

    # 5. Privacy Mode & Inflation support in app.js
    recalc_fn = app_js.split("function recalculateGoalProjection()")[1].split("function renderGoalProjectionChart(")[0]
    assert "maskIfPrivate(" in recalc_fn
    assert "goal-scenarios-strip" in recalc_fn
    assert "goal-dca-schedule-body" in recalc_fn
    priv_fn = app_js.split("function toggleBalancePrivacy()")[1].split("function selectStrategyCompareMetric(")[0]
    assert "recalculateGoalProjection()" in priv_fn
    assert "refreshSavedPortfoliosUI" in priv_fn

    # 6. Pre-Print PDF Config Modal, In-App A4 Preview Overlay & Dark Mode CSS
    assert 'id="pdf-report-config-modal"' in html
    assert 'id="pdf-cfg-client-name"' in html
    assert 'id="pdf-cfg-advisor-name"' in html
    assert 'id="pdf-cfg-commentary"' in html
    assert 'id="pdf-cfg-mode-full"' in html and 'id="pdf-cfg-mode-pct"' in html
    assert 'id="pdf-a4-preview-overlay"' in html
    assert 'id="pdf-a4-preview-iframe"' in html
    assert "function printInstitutionalPdfPreview(" in app_js
    assert "html body.theme-dark #pdf-report-config-modal" in css


def test_institutional_2page_a4_pdf_report_typography_and_sections():
    app_js = _read_text("app.js")
    pdf_fn = app_js.split("function openPrintableGoalReport(")[1].split("function showPortfolioToastApp(")[0]

    # Modern Institutional Font Pairing: IBM Plex Sans Thai + IBM Plex Mono + tabular-nums
    assert "IBM+Plex+Sans+Thai" in pdf_fn
    assert "IBM+Plex+Mono" in pdf_fn
    assert "'IBM Plex Sans Thai'" in pdf_fn
    assert "'IBM Plex Mono'" in pdf_fn
    assert "tabular-nums" in pdf_fn

    # True 2-Page A4 Layout with Print Color Fidelity & Inline Vector Charts
    assert "size: A4 portrait" in pdf_fn
    assert "print-color-adjust: exact" in pdf_fn
    assert "page-break-after: always" in pdf_fn
    assert "หน้า 1 / ${totalPages}" in pdf_fn and "หน้า 2 / ${totalPages}" in pdf_fn and "หน้า 3 / 3" in pdf_fn
    assert "buildPdfAllocationDonutSvg(" in pdf_fn
    assert "buildPdfGoalTrajectorySvg(" in pdf_fn
    assert "buildPdfMasterLogoInlineSvg(" in pdf_fn

    # Complete Client Proposal Sections
    for required_section in (
        "ตารางแผนจัดสรรเงินก้อนแรกและออมรายเดือน (DCA Schedule)",
        "เปรียบเทียบ 4 กลยุทธ์เชิงปริมาณ",
        "ผลทดสอบช่วงวิกฤตในอดีต",
        "ตารางเป้าหมายรายปีแยก 3 สถานการณ์",
        "บทสรุปและข้อเสนอแนะเชิงกลยุทธ์",
        "ข้อสงวนสิทธิ์ (Disclaimer)",
    ):
        assert required_section in pdf_fn, f"Missing institutional PDF section: {required_section}"


def test_pdf_dual_compliance_mode_whitelabel_exact_rounding_and_dividend_tax():
    html = _read_text("index.html")
    app_js = _read_text("app.js")
    css = _read_text("styles.css")

    # 1. Dual-Mode Compliance Controls & White-label Modal Fields
    modal_html = html.split('id="pdf-report-config-modal"')[1].split('id="pdf-a4-preview-overlay"')[0]
    for req_id in (
        "pdf-cfg-report-mode-sim",
        "pdf-cfg-report-mode-advisor",
        "pdf-cfg-alert",
        "pdf-cfg-client-name",
        "pdf-cfg-advisor-name",
        "pdf-cfg-advisor-req",
        "pdf-cfg-whitelabel-fields",
        "pdf-cfg-license-no",
        "pdf-cfg-firm-name",
        "pdf-cfg-logo-input",
        "pdf-cfg-logo-preview",
        "pdf-cfg-logo-status",
        "btn-clear-pdf-logo",
    ):
        assert f'id="{req_id}"' in modal_html, f"Missing PDF modal control #{req_id}"

    # Default mode must be Simulation Report (checked) while Advisor mode starts unchecked
    sim_tag = modal_html.split('id="pdf-cfg-report-mode-sim"')[1].split(">")[0]
    adv_tag = modal_html.split('id="pdf-cfg-report-mode-advisor"')[1].split(">")[0]
    assert "checked" in sim_tag, "Default PDF mode must be Simulation Report (SEC compliant)"
    assert "checked" not in adv_tag, "Advisor White-label mode must not be default checked"
    assert "clearSavedPdfProfile()" in modal_html

    # 2. Preparer Identity Guard: NEVER auto-fill raw email prefix (e.g. "amon" from email.split('@')[0])
    open_modal_fn = app_js.split("function openPdfReportConfigModal(")[1].split("function closePdfReportConfigModal(")[0]
    assert "email.split('@')" not in open_modal_fn
    assert "readSavedPdfPreparerProfile()" in open_modal_fn

    confirm_fn = app_js.split("function confirmAndOpenInstitutionalPdf(")[1].split("function closePdfA4PreviewOverlay(")[0]
    assert "reportMode === 'advisor'" in confirm_fn
    assert "if (!advisorName)" in confirm_fn
    assert "if (!licenseNo)" in confirm_fn
    assert "savePdfPreparerProfile(" in confirm_fn

    # 3. Dual-Mode PDF Wording: Simulation default avoids "แนะนำให้" while Advisor unlocks White-label
    pdf_fn = app_js.split("function openPrintableGoalReport(")[1].split("function showPortfolioToastApp(")[0]
    assert "PORTFOLIO SIMULATION REPORT" in pdf_fn
    assert "PLANNING SUMMARY" in pdf_fn
    assert "EXECUTIVE INVESTMENT PROPOSAL" in pdf_fn
    assert "ADVISORY NOTE" in pdf_fn
    assert "บทสรุปผลการจำลองและกรอบการวางแผน (Planning Summary)" in pdf_fn
    assert "ไม่ใช่ผู้ให้คำแนะนำการลงทุนที่ได้รับใบอนุญาต" in pdf_fn
    assert "เลขที่ใบอนุญาต" in pdf_fn

    # Verify Simulation commentary branch strictly avoids advisory imperative "แนะนำให้"
    sim_commentary_block = pdf_fn.split("} else if (isIcLicense) {")[1].split("} else {")[1].split("const finalCommentaryHtml")[0]
    assert "แนะนำให้" not in sim_commentary_block, "Simulation mode auto-commentary must not contain 'แนะนำให้'"

    # 4. Exact Integer & Basis-Point Rounding (Hamilton / Largest Remainder) — Zero ±1 Baht Drift
    assert "function allocateExactIntegers(" in app_js
    assert "allocateExactIntegers," in app_js.split("window.QuantFolioCalc = {")[1]
    proj_fn = app_js.split("function computeGoalProjectionMetrics(")[1].split("function recalculateGoalProjection(")[0]
    assert "allocateExactIntegers(initialBudget, rawWeightVals)" in proj_fn
    assert "allocateExactIntegers(monthlyDca, rawWeightVals)" in proj_fn
    assert "allocateExactIntegers(10000, rawWeightVals)" in proj_fn

    # 5. Dividend Withholding Tax Footnote on Tab 5 UI & PDF Pages 1 and 2
    tab5_html = html.split('id="tab-view-goals"')[1].split('id="loading-card"')[0]
    assert "ก่อนหักภาษี ณ ที่จ่าย" in tab5_html
    assert "10%" in tab5_html and "15%–30%" in tab5_html
    assert pdf_fn.count("ก่อนหักภาษี ณ ที่จ่าย") >= 2, "Dividend withholding tax footnote must appear on both Page 1 and Page 2 of PDF"
    assert "10%" in pdf_fn and "15%–30%" in pdf_fn

    # Dark Mode CSS for PDF modal text inputs & alert box
    assert 'html body.theme-dark #pdf-report-config-modal input[type="text"]' in css
    assert "html body.theme-dark #pdf-report-config-modal #pdf-cfg-alert" in css


def test_sec_fair_dealing_ic_vs_ip_and_vulnerable_investor_safeguards():
    html = _read_text("index.html")
    app_js = _read_text("app.js")
    css = _read_text("styles.css")

    modal_html = html.split('id="pdf-report-config-modal"')[1].split('id="pdf-a4-preview-overlay"')[0]

    # 1. Modal includes SEC/SET License Type (IC Groups 1-4 vs IP Group 5), 6 Client Segments, Suitability & Fair Dealing Checkboxes
    for req_id in (
        "pdf-cfg-suitability-panel",
        "pdf-cfg-client-segment",
        "pdf-cfg-client-suitability",
        "pdf-cfg-suitability-live-badge",
        "pdf-cfg-license-type",
        "pdf-cfg-license-scope-hint",
        "pdf-cfg-chk-factsheet",
        "pdf-cfg-chk-knowledge",
        "pdf-cfg-chk-noforce",
    ):
        assert f'id="{req_id}"' in modal_html, f"Missing Fair Dealing PDF control #{req_id}"

    # Verify all 5 SEC/SET license categories from Page 7 Table (IC Plain, IC Complex 2, IC Complex 3, IC Complex 1, IP)
    for lic_val in ("ic_plain", "ic_complex_2", "ic_complex_3", "ic_complex_1", "ip"):
        assert f'value="{lic_val}"' in modal_html, f"Missing SEC/SET license option {lic_val}"

    # Verify all 6 SEC client segmentation categories from Pages 5-6 (including Vulnerable Investors >= 60)
    for seg_val in ("general", "senior_exp", "vulnerable", "hnw", "uhnw", "institutional"):
        assert f'value="{seg_val}"' in modal_html, f"Missing SEC client segment option {seg_val}"

    # 2. Fair Dealing Diagnostic Engine & Role Separation in app.js
    assert "function evaluatePdfFairDealingCompliance(" in app_js
    assert "evaluatePdfFairDealingCompliance," in app_js.split("window.QuantFolioCalc = {")[1]

    pdf_fn = app_js.split("function openPrintableGoalReport(")[1].split("function showPortfolioToastApp(")[0]
    assert "BASIC ASSET ALLOCATION REPORT • IC STANDARD MODEL" in pdf_fn
    assert "EXECUTIVE INVESTMENT PROPOSAL • IP ASSET ALLOCATION" in pdf_fn
    assert "มิใช่การจัดพอร์ตเฉพาะเจาะจงรายบุคคล" in pdf_fn
    assert "Vulnerable Investors อายุ ≥ 60 ปี" in pdf_fn
    assert "Knowledge Assessment" in pdf_fn
    assert "Factsheet" in pdf_fn
    assert "html body.theme-dark #pdf-report-config-modal select" in css
