"""
TDD suite for the Consumer-Fintech Pre-Calculation Landing Showcase & Header Polish:
1. Clean Header on Landing: no broken/idle 'รอคำนวณ • ยังไม่ดึงชุดวิเคราะห์' pill or '--' telemetry
   next to the QuantFolio logo while on Landing View; telemetry wrapper reveals inside Workspace.
2. Interactive Quick-Start on Hero: budget input + quick amount chips + 4 preset selectors update
   the live floating App Mockup preview (#landing-preview-card).
3. One-click 'คำนวณพอร์ตทันทีเลย' enters Workspace & triggers calculation on demand;
   'ปรับแต่งหุ้นเองก่อน' enters Tab 1 Setup cleanly.
4. High-contrast 5-module preview keeps honest illustrative badge and zero banned fake KPI strings.
"""
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


def test_landing_clean_header_and_quick_start_ux():
    html = _read_text("index.html")
    app_js = _read_text("app.js")

    # 1. No broken 'รอคำนวณ' branding pill anywhere in HTML or JS
    assert "รอคำนวณ • ยังไม่ดึงชุดวิเคราะห์" not in html
    assert "รอคำนวณ • ยังไม่ดึงชุดวิเคราะห์" not in app_js

    # Workspace-only header telemetry & action controls must start hidden on Landing
    assert 'id="header-workspace-telemetry"' in html
    telemetry_tag = html.split('id="header-workspace-telemetry"')[1].split(">")[0]
    assert "hidden" in telemetry_tag, "Header FX/Rf/status telemetry must start hidden on Landing View"
    assert 'id="header-workspace-actions"' in html
    actions_tag = html.split('id="header-workspace-actions"')[1].split(">")[0]
    assert "hidden" in actions_tag, "Header workspace tools (THB/USD, Saved, Settings) must start hidden on Landing View"
    assert 'id="header-landing-theme-btn"' in html

    # Landing view visible initially; Workspace hidden initially
    assert 'id="landing-showcase-view"' in html
    landing_tag = html.split('id="landing-showcase-view"')[1].split(">")[0]
    assert "hidden" not in landing_tag
    main_tag = html.split('id="main-app-workspace"')[1].split(">")[0]
    assert "hidden" in main_tag

    # 2. Bottom Quick-Start Budget & Dark Mockup Card removed per streamlined Landing design
    assert 'id="landing-budget-input"' not in html
    assert 'id="landing-preview-card"' not in html
    assert "US Tech + BTC • ตัวอย่างหน้าจอผลลัพธ์" not in html

    # Primary master brand logo SVG wired across favicon, header, footers & auth modal (no duplicate hero logo beside badge)
    assert 'href="/static/quantfolio-logo.svg' in html
    assert html.count('/static/quantfolio-logo.svg') >= 6
    assert 'id="landing-hero-logo"' not in html
    assert 'id="landing-resume-results-btn"' in html
    assert 'id="back-to-landing-btn"' in html
    assert "enterWorkspaceWithRiskProfile(" in html
    assert "scrollToSectionById('methodology')" in html

    # Functions exist in app.js
    for fn_name in (
        "setAppView",
        "showLandingShowcase",
        "selectLandingRiskProfile",
        "selectLandingRiskProfileByStep",
        "enterWorkspaceWithRiskProfile",
        "enterWorkspaceFromLanding",
    ):
        assert f"function {fn_name}(" in app_js, f"Missing JS handler {fn_name}"

    # Clean QuantFolio Landing Page sections (Split Hero with Real-Result Showcase, Plain Everyday Thai, 1+1 CTA)
    assert "QuantFolio" in html
    assert "QuantPort" not in html
    assert "เครื่องมือช่วยจัดพอร์ตอัตโนมัติ" in html
    assert "หุ้นสหรัฐฯ • หุ้นไทย • ETF •" in html and "ทองคำ • คริปโต" in html
    assert "น้ำหนักเท่ากัน" in html and "ไม่จัดสัดส่วน" not in html
    assert "เปลี่ยนงบที่มี เป็นแผนซื้อ–ขายที่ชัดเจนใน 3 ขั้นตอน" in html
    assert "ไม่ต้องตั้งสูตรเอง เลือกสินทรัพย์ที่สนใจแล้วดูผลเทียบได้ทันที" in html
    assert "ขั้นตอนที่ 1" not in html and "ขั้นตอนที่ 2" not in html and "ขั้นตอนที่ 3" not in html
    assert "ข้อมูลราคาปิดอ้างอิงจาก <strong class=\"text-white\">Yahoo Finance</strong> (ครอบคลุมหุ้นสหรัฐฯ, หุ้นไทย SET, ETF, ทองคำ และคริปโต)" in html
    assert "บันทึกพอร์ตแยกสิทธิ์ส่วนตัวตามบัญชีผู้ใช้" in html
    assert "(RLS)" not in html.split('id="trust"')[1].split('id="model-limitations-box"')[0]
    assert "QuantFolio เป็นซอฟต์แวร์เครื่องมือคำนวณเชิงปริมาณเพื่อการศึกษาและประกอบการวิเคราะห์ข้อมูลเท่านั้น ไม่ใช่ผู้ให้คำแนะนำการลงทุนที่ได้รับใบอนุญาต และไม่ใช่คำแนะนำการลงทุนเฉพาะบุคคล" in html
    assert "ผลการจำลองย้อนหลัง (Backtest) ไม่รับประกันผลตอบแทนในอนาคต" in html
    assert "การลงทุนมีความเสี่ยง ผู้ใช้งานควรตรวจสอบความถูกต้องของข้อมูลและใช้วิจารณญาณก่อนตัดสินใจลงทุน" in html
    assert 'id="hero-result-showcase"' in html
    assert "ตัวอย่างเพื่อการศึกษา" in html
    # Right-side showcase must stay visually quiet (no competing green CTA button, no noisy horizontal bar, neutral active tab)
    showcase_block = html.split('id="hero-result-showcase"')[1].split('<!-- SECTION 2')[0]
    assert "ลองจัดพอร์ตของคุณเอง" not in showcase_block, "Right showcase card must not have a competing green CTA button"
    assert "สลับเทียบได้ทันที" not in showcase_block, "Extra green pill inside right showcase chart should stay removed"
    assert 'title="MSFT 32%"' not in showcase_block, "Horizontal colorful allocation bar above the 4 stock cards should stay removed"
    assert 'id="hero-showcase-footnote"' in showcase_block
    assert "ภาพจำลองหน้าตาผลลัพธ์จริง (ตัวอย่างเพื่อการศึกษา)" in showcase_block
    assert "switchHeroSampleTab('frontier')" in html
    assert "switchHeroSampleTab('backtest')" in html
    assert "switchHeroSampleTab('orders')" in html
    assert "function switchHeroSampleTab(" in app_js
    # Strictly 1 Primary + 1 Secondary button inside #hero-primary-cta-group (3rd action moved beneath result showcase)
    hero_cta_block = html.split('id="hero-primary-cta-group"')[1].split('</div>')[0]
    assert hero_cta_block.count("<button") == 2, "Hero CTA group must have strictly 1 primary + 1 secondary button"
    assert 'id="landing-resume-results-btn"' not in hero_cta_block
    assert 'id="preview-widget"' not in html, "Legacy Interactive Portfolio Preview widget should remain removed"
    assert 'id="landing-risk-slider"' not in html
    assert 'id="features"' in html
    assert 'id="methodology"' in html
    assert 'id="trust"' in html
    assert 'id="landing-workflow-section"' not in html, "Duplicate Why QuantFolio 3-card block should stay merged into #methodology"
    assert "ลองเลือกสินทรัพย์และงบของคุณเอง" not in html, "Duplicate custom-setup text link under hero showcase should stay removed"
    nav_block = html.split('id="header-landing-nav"')[1].split("</nav>")[0]
    assert nav_block.count("<a ") == 2, "Landing nav should keep 2 section anchor links (วิธีใช้งาน & ความโปร่งใส)"
    assert 'id="header-landing-pricing-btn"' in nav_block
    assert "openProUpgradeModal('', 'pro', 'plans')" in nav_block
    assert "แพ็กเกจ" in nav_block

    # Account name truncation uses inline-block + max-w + truncate so laptop navbar never crowds
    user_name_tag = html.split('id="user-profile-name"')[1].split(">")[0]
    assert "inline-block" in user_name_tag and "truncate" in user_name_tag and "max-w-" in user_name_tag

    # Navbar secondary CTA button stays hidden on Landing Page (Hero already has primary CTA)
    landing_cta_tag = html.split('id="header-landing-cta-btn"')[1].split(">")[0]
    assert "hidden" in landing_cta_tag

    # Updated Hero subtitle, 4-tier-aligned checklist, and left-column resume link outside #hero-primary-cta-group
    assert "ช่วยแบ่งสัดส่วนหุ้นและสินทรัพย์ให้สมดุลจากข้อมูลตลาดและสถิติจริง คุมความเสี่ยงได้ง่าย โดยไม่ต้องนั่งคำนวณเอง" in html
    assert 'เทียบ 4 กลยุทธ์ + ปรับพอร์ตเดิม <span class="inline-block whitespace-nowrap">(Rebalance)</span>' in html
    assert 'แผนออม DCA + รายงาน PDF A4 <span class="inline-block whitespace-nowrap">(รองรับ IC/IP)</span>' in html
    assert 'เริ่มใช้งานฟรี ไม่ต้องสมัครสมาชิก <span class="inline-block whitespace-nowrap">(ดูผลบาท/ดอลลาร์)</span>' in html
    hero_left_block = html.split('id="hero-primary-cta-group"')[1].split('id="hero-result-showcase"')[0]
    assert 'id="landing-resume-results-btn"' in hero_left_block
    assert 'id="landing-resume-results-btn"' not in showcase_block

    # Updated 3-step cards, Trust card, Footer tagline & 3 working legal/help modal tabs
    assert "พร้อมวิเคราะห์ข่าวและสัญญาณสำคัญรายสินทรัพย์" in html
    assert "พร้อมแผนออมรายเดือนและส่งออกรายงาน PDF 2 หน้า A4" in html
    assert "ออกแบบสำหรับนักลงทุนรายบุคคลและผู้แนะนำการลงทุน (IC/IP) เพื่อช่วยทดสอบและจัดทำแผนพอร์ตจากข้อมูลตลาดจริงอย่างเป็นระบบ" in html
    assert "เครื่องมือจัดสัดส่วนพอร์ตการลงทุนเชิงปริมาณสำหรับนักลงทุนและที่ปรึกษาการเงิน (IC/IP)" in html
    assert "openHelpGuideModal('guide')" in html
    assert "openHelpGuideModal('privacy')" in html
    assert "openHelpGuideModal('terms')" in html
    for tab_panel_id in ("help-tab-panel-guide", "help-tab-panel-privacy", "help-tab-panel-terms"):
        assert f'id="{tab_panel_id}"' in html
    assert "function switchHelpGuideTab(" in app_js

    # Dark Mode high-contrast #CBD5E1 rule for secondary text inside right showcase card
    css = _read_text("styles.css")
    assert "html body.theme-dark #hero-result-showcase .text-slate-500" in css
    assert "color: #CBD5E1 !important;" in css
    assert '<details id="model-limitations-box"' in html, "Methodology & Model Limitations should be a collapsible <details> accordion"
    assert "ออกแบบเพื่อวางแผนระยะกลาง–ยาว (ไม่ใช่เทรดเรียลไทม์)" in html
    assert 'id="landing-data-asof-text"' not in html
    assert 'id="model-limitations-box"' in html
    assert 'id="landing-prominent-disclaimer"' in html
    assert "ในคลิกเดียว" not in html, "Hero headline must replace 'ในคลิกเดียว' with honest 3-step copy"
    assert "ใน 3 ขั้นตอน" in html
    assert "ไม่ต้องเชื่อมบัญชีโบรกเกอร์" in html
    assert "FT 318" not in html and "มหาวิทยาลัยธุรกิจบัณฑิตย์" not in html
    assert "Harry Markowitz" in html and "Marcos López de Prado" in html
    assert "ไม่ใช่ซุปเปอร์คอมพิวเตอร์" in html
    assert "ไม่ใช่ผู้ให้คำแนะนำการลงทุนที่ได้รับใบอนุญาต" in html
    assert "ไม่ใช่คำแนะนำการลงทุน" in html
    assert "ผล Backtest ไม่รับประกันผลตอบแทนในอนาคต" in html
    assert "ราคาสด" not in html.split('id="landing-showcase-view"')[1].split('id="main-app-workspace"')[0]
    assert 'id="global-workspace-footer"' in html
    workspace_footer_tag = html.split('id="global-workspace-footer"')[1].split(">")[0]
    assert "hidden" in workspace_footer_tag, "Global workspace footer must stay hidden on Landing to avoid duplicate footers"
    assert "Yahoo Finance" in html and "SET" in html
    assert "ผลในอดีตไม่รับประกันผลตอบแทนในอนาคต ผลลัพธ์นี้ไม่ใช่คำแนะนำการลงทุนเฉพาะบุคคล" in html

    # DOMContentLoaded must NOT auto-run optimization
    dom_ready_block = app_js.split("document.addEventListener('DOMContentLoaded'")[1].split("});")[0]
    assert "runOptimization(" not in dom_ready_block

    # Zero banned fake hardcoded KPI figures & Phase 2 copy compliance
    for fake in ("+24.85%", "฿245,850", "-38,352", "฿1,485,200", "148.5%"):
        assert fake not in html, f"Banned demo figure '{fake}' found in index.html"
    assert "แกว่งน้อย" not in html
    assert html.count("ผลในอดีตไม่รับประกันผลตอบแทนในอนาคต ผลลัพธ์นี้ไม่ใช่คำแนะนำการลงทุนเฉพาะบุคคล") >= 2

    # switchAppTab & setAppView manage header-workspace-telemetry cleanly
    set_view_fn = app_js.split("function setAppView(")[1].split("\nfunction ")[0]
    assert "header-workspace-telemetry" in set_view_fn


def test_landing_showcase_served_on_root_and_synced():
    client = ASGITestClient(quantfolio_app.app)
    res = client.get("/")
    assert res.status_code == 200
    assert 'id="landing-showcase-view"' in res.text
    assert 'id="landing-hero-logo"' not in res.text
    assert '/static/quantfolio-logo.svg' in res.text
    assert 'id="preview-widget"' not in res.text
    assert 'id="landing-preview-card"' not in res.text

    logo_res = client.get("/static/quantfolio-logo.svg")
    assert logo_res.status_code == 200
    assert "image/svg+xml" in logo_res.headers.get("content-type", "")
    assert "qf-logo-frame" in logo_res.text

    for fn in ("index.html", "app.js", "styles.css"):
        assert _read_text(fn) == _read_text(f"static/{fn}"), f"Root {fn} out of sync with static/{fn}"
