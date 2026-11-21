"""
TDD regression test for Tab 4 Backtest Stress-Test card (Card 4.1):
Prevents large monetary figures (e.g. 10,000,000.00 บาท) from overflowing
their card tiles on mobile or desktop without altering any calculation logic.
"""
import os

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read_text(rel_path: str) -> str:
    with open(os.path.join(PROJECT_ROOT, rel_path), "r", encoding="utf-8") as f:
        return f.read()


def test_backtest_stress_card_tiles_do_not_overflow():
    html = _read_text("index.html")
    css = _read_text("styles.css")

    card_section = html.split("<!-- 4 Hero Stress KPI Tiles")[1].split("<!-- Dime!-Style Stacked Survival Bar -->")[0]
    grid_open = card_section.split("<div class=\"")[1].split("\">")[0]

    # Must use 1 column on narrow mobile (375px) rather than squeezed 2 columns
    assert "grid-cols-1" in grid_open, "Backtest stress KPI grid must stack to 1 column on narrow mobile"
    assert "min-w-0" in card_section, "Stress KPI tiles must set min-w-0 to constrain text inside grid cells"

    # #bt-dd-* figures must NOT remain in the oversized 2.05rem desktop rule or nowrap mobile rule
    hero_kpi_rule = css.split("/* Hero KPI & Balance Figures across Tabs 1-5 */")[1].split("}")[0]
    assert "#bt-dd-initial-budget" not in hero_kpi_rule, "#bt-dd-* must use dedicated compact sizing inside 4-col cards"

    media_end = css.split("@media (max-width: 639px)")[1].split("@media (prefers-reduced-motion")[0]
    assert "#bt-dd-initial-budget" not in media_end, "#bt-dd-* must not force white-space: nowrap on mobile"
    # Check #bt-dd-initial-budget has a dedicated overflow-safe rule (clamp <= 1.5rem and wrap-safe)
    assert "#bt-dd-initial-budget," in css
    bt_rule = css.split("#bt-dd-initial-budget,\n#bt-dd-loss-baht,\n#bt-dd-remaining-baht")[1].split("}")[0]
    assert "overflow-wrap" in bt_rule or "word-break" in bt_rule
    assert "nowrap" not in bt_rule
    assert "2.05rem" not in bt_rule


def test_tab4_backtest_audit_fixes():
    html = _read_text("index.html")
    css = _read_text("styles.css")
    app_js = _read_text("app.js")

    tab4 = html.split('id="tab-view-backtest"')[1].split('id="tab-view-goals"')[0]

    # 1. Card 4.1 Peak -> Loss -> Trough self-consistent copy & Worst-Timing Stress note (no misleading 'ของเงินต้น')
    assert "มูลค่าจุดสูงสุดก่อนย่อ" in tab4
    assert "ย่อตัวสูงสุดจากจุดสูงสุด" in tab4
    assert 'id="bt-dd-initial-sub"' in tab4
    assert 'id="bt-dd-remaining-sub"' in tab4
    assert 'id="bt-dd-worst-timing-note"' in tab4
    stress_fn = app_js.split("function renderBacktestStressCard()")[1].split("\nfunction switchBacktestChartMode")[0]
    assert "ของเงินต้น" not in stress_fn, "Max Drawdown % is peak-to-trough, not % of initial principal"
    assert "จากจุดสูงสุดในอดีต" in stress_fn
    assert "dd.peak_value" in stress_fn
    assert "dd.initial_budget_scaled_loss" in stress_fn
    assert "maskIfPrivate(" in stress_fn

    # 2. Card 4.2 3-pill OOS summary strip, downward tooltip, Dark Mode annotation fix, Privacy % mode & clean Drawdown axis
    assert 'id="bt-growth-summary-strip"' in tab4
    assert "qf-tip qf-tip-down" in tab4
    assert ".qf-tip.qf-tip-down .qf-tip-box" in css
    growth_fn = app_js.split("function renderPortfolioGrowthChart()")[1].split("\nfunction renderStrategyCompareTable")[0]
    assert "ct.plotBg === '#111620'" not in growth_fn, "Dark Mode annotation must use ct.dark instead of stale hex comparison"
    assert "ct.dark ?" in growth_fn
    assert "isPrivate" in growth_fn and "toPctSeries" in growth_fn
    assert "bt-growth-summary-strip" in growth_fn

    # 3. Privacy Mode re-renders all Tab 4 components & masks strategy/asset tables
    priv_fn = app_js.split("function toggleBalancePrivacy()")[1].split("\nfunction selectStrategyCompareMetric")[0]
    for fn_call in ("renderBacktestStressCard()", "renderPortfolioGrowthChart()", "renderStrategyCompareTable()", "renderAssetStatsTable()"):
        assert fn_call in priv_fn, f"toggleBalancePrivacy must re-render {fn_call}"
    strat_tbl_fn = app_js.split("function renderStrategyCompareTable()")[1].split("\n// Tab 2:")[0]
    assert "maskIfPrivate(" in strat_tbl_fn
    assert "คุ้มความเสี่ยง (Max Sharpe)" in strat_tbl_fn
    assert "จุดต่ำสุด " in strat_tbl_fn
    asset_tbl_fn = app_js.split("function renderAssetStatsTable()")[1].split("\nfunction renderCorrelationAndGrowthPlots")[0]
    assert "maskIfPrivate(" in asset_tbl_fn

    # 4. Dark Mode Sub-tab 3 card fix + Frontier staggered labels + Mobile Correlation angle
    assert "bg-slate-50/50" not in tab4
    assert r"html body.theme-dark .fin-card .bg-slate-50\/50" in css
    assert r"html body.theme-dark .fin-card .bg-slate-200\/70" in css
    frontier_fn = app_js.split("function renderEfficientFrontierPlot()")[1].split("\n// Tab 3:")[0]
    assert "frontierAnnotations" in frontier_fn and "ay: -34" in frontier_fn
    corr_fn = app_js.split("function renderCorrelationAndGrowthPlots()")[1].split("\nfunction renderGrowth100Plot")[0]
    assert "mobile ? -35 : 0" in corr_fn and "tickangle:" in corr_fn
