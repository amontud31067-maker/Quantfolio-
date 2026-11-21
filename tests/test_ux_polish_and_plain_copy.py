"""
TDD regression suite for the 5 browser-verified layout fixes + plain everyday Thai copy:
1. Active nav circle contrast (.qf-tab-btn.active .qf-tab-step never black-on-black).
2. Responsive #main-nav-tabs (flex-wrap, concise mode pills, compact mobile trade count badge).
3. Mobile #global-result-strip (no '?' icon overlap, no cut-off profit/remaining wrap).
4. Tab 5 Goals (#tab-view-goals) 4-tile grid responsive + overflow-safe #goal-proj-* CSS.
5. Tab 4 Backtest Plotly chart (#portfolio-growth-chart) margin/legend/annotation separation.
6. Plain everyday Thai labels on Landing & Workspace (technical terms tucked into tooltips).
"""
import os

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read_text(rel_path: str) -> str:
    with open(os.path.join(PROJECT_ROOT, rel_path), "r", encoding="utf-8") as f:
        return f.read()


def test_five_layout_and_contrast_fixes():
    html = _read_text("index.html")
    css = _read_text("styles.css")
    app_js = _read_text("app.js")

    # 1. Active nav step circle must NOT be forced to #0A0D12 text color on #0A0D12 bg
    assert ".qf-tab-btn.active span," not in css, ".qf-tab-btn.active span rule forces dark digit on dark step circle"
    assert ".qf-tab-btn.active > span:not(.qf-tab-step)" in css
    assert ".qf-tab-btn.active .qf-tab-step" in css
    dark_active_idx = css.find("html body.theme-dark .qf-tab-btn.active .qf-tab-step")
    assert dark_active_idx != -1, "Dark theme must explicitly preserve bright active step digit contrast"

    # 2. #main-nav-tabs wraps cleanly & uses concise view-depth pills + mobile compact badge
    nav_open = html.split('id="main-nav-tabs"')[1].split(">")[0]
    assert "flex-wrap" in nav_open, "#main-nav-tabs must wrap on narrow desktop (~950-1150px)"
    assert ">อ่านง่าย<" in html and ">ละเอียด + กราฟ<" in html
    assert 'hidden md:inline"> รายการ' in app_js

    # 3. Mobile #global-result-strip hides decorative icons under 640px and wraps profit/remaining cleanly
    strip_section = html.split('id="global-result-strip"')[1].split('id="tab-view-setup"')[0]
    assert "lucide=\"activity\" class=\"w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-500 hidden sm:block shrink-0\"" in strip_section
    assert "lucide=\"award\" class=\"w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-600 hidden sm:block shrink-0\"" in strip_section

    # 4. Tab 5 Goals KPI grid stacks cleanly (1-2-4 cols) & uses compact overflow-safe sizing
    goals_card = html.split("<!-- Card 5.2")[1].split('id="goal-projection-chart"')[0]
    assert "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4" in goals_card
    hero_kpi_rule = css.split("/* Hero KPI & Balance Figures across Tabs 1-5 */")[1].split("}")[0]
    assert "#goal-proj-total-principal" not in hero_kpi_rule
    media_end = css.split("@media (max-width: 639px)")[1].split("@media (prefers-reduced-motion")[0]
    assert "#goal-proj-total-principal" not in media_end
    compact_rule = css.split("#bt-dd-initial-budget,")[1].split("}")[0]
    for gid in ("#goal-proj-total-principal", "#goal-proj-final-wealth", "#goal-proj-annual-dividend", "#goal-proj-achievement-pct"):
        assert gid in compact_rule, f"{gid} must share overflow-safe compact clamp CSS"

    # 5. Tab 4 Portfolio Growth chart separates horizontal legend from split annotation
    growth_fn = app_js.split("function renderPortfolioGrowthChart()")[1].split("\n// Tab 2:")[0]
    assert "yanchor: 'bottom'" in growth_fn, "Legend must sit above chart cleanly anchored at bottom"
    assert "y: 1," not in growth_fn, "Annotation must sit safely below y=1 boundary so legend cannot overlap"
    assert "bgcolor:" in growth_fn, "Split annotation should have pill background for readability"


def test_plain_everyday_thai_copy_replaces_raw_jargon():
    import re
    html = _read_text("index.html")
    app_js = _read_text("app.js")

    landing_block = html.split('id="landing-showcase-view"')[1].split('id="main-app-workspace"')[0]
    visible_landing = re.sub(r'\s(?:title|aria-label)="[^"]*"', '', landing_block)
    # Landing visible text must lead with everyday Thai instead of exposed English jargon (titles/tooltips may keep terms)
    for raw_jargon in (
        "Oversold ⇄ Neutral ⇄ Overbought",
        "Momentum &amp; SMA",
        "RSI-14 Spectrum",
        "Walk-Forward OOS เทียบ 1/N Benchmark",
        "Peak-to-Trough Max Drawdown",
    ):
        assert raw_jargon not in visible_landing, f"Raw jargon '{raw_jargon}' still exposed in visible Landing Showcase text"

    # Backtest growth & frontier charts use friendly Thai trace names
    growth_fn = app_js.split("function renderPortfolioGrowthChart()")[1].split("\n// Tab 2:")[0]
    assert "Walk-Forward OOS (" not in growth_fn
    assert "เริ่ม Out-of-Sample" not in growth_fn
    assert "เริ่มช่วงทดสอบจริง" in growth_fn

    assert "แกว่งน้อย" not in app_js
    assert "ซื้อเป็นเศษหุ้นได้ (Fractional 4 ตำแหน่ง)" not in app_js


def test_quick_stock_catalog_and_insights_all_stocks_coverage():
    html = _read_text("index.html")
    app_js = _read_text("app.js")
    opt_py = _read_text("optimizer.py")

    # 1. Tab 1 Quick-Add Stock Catalog by Category
    assert 'id="quick-stock-catalog-box"' in html
    assert 'id="quick-stock-catalog-chips"' in html
    for cat in ("thai_set50", "us_equities", "etf_gold_bonds", "crypto"):
        assert f"selectStockCatalogCategory('{cat}')" in html
    assert "function selectStockCatalogCategory(" in app_js
    assert "function toggleCatalogTicker(" in app_js
    assert "function renderQuickStockCatalog(" in app_js

    # 2. Tab 3 Upfront Per-Stock Intelligence Cards + Ticker Filter + Round-Robin Coverage
    assert 'id="insights-ticker-filter-bar"' in html
    assert 'id="insights-stock-cards-grid"' in html
    assert 'id="insights-stocks-coverage-badge"' in html
    assert "function filterInsightsByTicker(" in app_js
    assert "function buildClientFallbackPulseArticle(" in app_js
    assert "โซนราคาสมดุลปกติ" in app_js
    assert "โซนราคาร้อนแรง" in app_js
    assert "โซนราคาอ่อนตัวลงลึก" in app_js
    # No longer truncating market news at slice(0, 8)
    assert "articles.slice(0, 8)" not in app_js
    # Optimizer guarantees Market Pulse fallback & round-robin interleaving across all valid_tickers
    assert "QuantFolio Market Pulse" in opt_py
    assert "for pass_idx in range(max_art_len):" in opt_py

