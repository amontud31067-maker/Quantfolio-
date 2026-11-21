"""
TDD regression test for Tab 2 Trade Order Checklist Cards layout & number formatting:
Prevents large amounts (e.g. +6,929,590.00 บาท) from colliding with ticker names,
prevents action pills ('สั่งซื้อเพิ่ม') from wrapping vertically into 3 stacked lines,
and ensures fractional share quantities render with thousand separators.
"""
import os

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read_text(rel_path: str) -> str:
    with open(os.path.join(PROJECT_ROOT, rel_path), "r", encoding="utf-8") as f:
        return f.read()


def test_order_checklist_cards_layout_prevents_overlap_and_pill_wrap():
    html = _read_text("index.html")
    app_js = _read_text("app.js")

    # 1. Grid uses max 2 columns (never cramped 3-column lg:grid-cols-3)
    grid_line = html.split('id="orders-checklist-cards-grid"')[1].split(">")[0]
    assert "lg:grid-cols-3" not in grid_line, "3-col grid squeezes order cards on desktop"
    assert "md:grid-cols-2" in grid_line

    # 2. renderOrderChecklistCards layout guarantees non-wrapping pills, dedicated amount row, and comma formatting
    fn_block = app_js.split("function renderOrderChecklistCards(")[1].split("\nfunction ")[0]
    for label in ("สั่งซื้อเพิ่ม", "สั่งขายออก", "ถือคงเดิม"):
        pill_snippet = fn_block.split(label)[0].rsplit("<span", 1)[-1]
        assert "whitespace-nowrap" in pill_snippet, f"Action pill '{label}' must include whitespace-nowrap"

    # Dedicated amount row separated from ticker/logo header
    assert "renderStockLogoBadge(item.ticker" in fn_block
    header_segment = fn_block.split("${amountText}")[0]
    # Header row ends before dedicated ${amountText} row
    assert "flex-1" in header_segment and "</div>" in header_segment.split("safeName")[1]

    # Fractional share counts formatted with commas via helper / toLocaleString
    assert "formatShareUnits(" in fn_block or "trade_shares_fractional.toLocaleString" in fn_block
    assert "function formatShareUnits(" in app_js
