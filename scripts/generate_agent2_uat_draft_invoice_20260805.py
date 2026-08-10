#!/usr/bin/env python3
"""Generate the controlled Agent2 supplier-bill DRAFT UAT source document."""

from __future__ import annotations

import argparse
from pathlib import Path

from reportlab.lib.colors import Color, HexColor, white
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


PAGE_WIDTH, PAGE_HEIGHT = A4
NAVY = HexColor("#10243E")
BLUE = HexColor("#315EF5")
LIGHT_BLUE = HexColor("#EEF3FF")
TEXT = HexColor("#1D2733")
MUTED = HexColor("#637083")
LINE = HexColor("#D8E0EA")
RED = HexColor("#B42318")
LIGHT_RED = HexColor("#FFF0EE")


def draw_text(
    page: canvas.Canvas,
    x: float,
    y: float,
    value: str,
    *,
    size: float = 10,
    font: str = "Helvetica",
    color: Color = TEXT,
) -> None:
    page.setFont(font, size)
    page.setFillColor(color)
    page.drawString(x, y, value)


def draw_right(
    page: canvas.Canvas,
    x: float,
    y: float,
    value: str,
    *,
    size: float = 10,
    font: str = "Helvetica",
    color: Color = TEXT,
) -> None:
    page.setFont(font, size)
    page.setFillColor(color)
    page.drawRightString(x, y, value)


def build_invoice(output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    page = canvas.Canvas(
        str(output_path),
        pagesize=A4,
        invariant=1,
        pageCompression=1,
    )
    page.setTitle("Agent2 Xero DRAFT UAT Supplier Invoice")
    page.setAuthor("zCloak Accounting MCP UAT")
    page.setSubject("Synthetic source document with no legal or payment effect")

    page.setFillColor(NAVY)
    page.rect(0, PAGE_HEIGHT - 118, PAGE_WIDTH, 118, stroke=0, fill=1)
    draw_text(
        page,
        48,
        PAGE_HEIGHT - 54,
        "zCloak Synthetic Supplier HK Limited",
        size=14,
        font="Helvetica-Bold",
        color=white,
    )
    draw_text(
        page,
        48,
        PAGE_HEIGHT - 75,
        "1 Test Ledger Road, Hong Kong",
        size=9,
        color=HexColor("#D8E4F2"),
    )
    draw_text(
        page,
        48,
        PAGE_HEIGHT - 92,
        "Registration: TEST-ONLY-AGENT2-20260805",
        size=9,
        color=HexColor("#D8E4F2"),
    )
    draw_right(
        page,
        PAGE_WIDTH - 48,
        PAGE_HEIGHT - 58,
        "INVOICE",
        size=21,
        font="Helvetica-Bold",
        color=white,
    )
    draw_right(
        page,
        PAGE_WIDTH - 48,
        PAGE_HEIGHT - 84,
        "HKD",
        size=12,
        font="Helvetica-Bold",
        color=HexColor("#D8E4F2"),
    )

    page.setFillColor(LIGHT_RED)
    page.roundRect(48, PAGE_HEIGHT - 160, PAGE_WIDTH - 96, 26, 5, stroke=0, fill=1)
    draw_text(
        page,
        60,
        PAGE_HEIGHT - 151,
        "CONTROLLED UAT SOURCE - SYNTHETIC - DRAFT ONLY - DO NOT PAY",
        size=9,
        font="Helvetica-Bold",
        color=RED,
    )

    meta_top = PAGE_HEIGHT - 202
    draw_text(page, 48, meta_top, "BILL TO", size=8.5, font="Helvetica-Bold", color=BLUE)
    draw_text(page, 48, meta_top - 22, "zcloak - Xero Trial Organisation", size=12, font="Helvetica-Bold")
    draw_text(page, 48, meta_top - 39, "Authorized test organisation only", size=9, color=MUTED)
    draw_text(page, 48, meta_top - 56, "No bank connection or payment authority", size=9, color=MUTED)

    metadata = [
        ("Reference", "ZC-AGENT2-UAT-20260805-001"),
        ("Invoice date", "2026-08-05"),
        ("Due date", "2026-08-19"),
        ("Source reference", "SRC-AGENT2-UAT-20260805-001"),
    ]
    for index, (label, value) in enumerate(metadata):
        y = meta_top - (index * 22)
        draw_text(page, 340, y, label, size=8.5, color=MUTED)
        draw_right(page, PAGE_WIDTH - 48, y, value, size=9, font="Helvetica-Bold")

    table_top = PAGE_HEIGHT - 320
    page.setFillColor(NAVY)
    page.roundRect(48, table_top, PAGE_WIDTH - 96, 30, 5, stroke=0, fill=1)
    draw_text(page, 60, table_top + 10, "DESCRIPTION", size=8.5, font="Helvetica-Bold", color=white)
    draw_right(page, 425, table_top + 10, "QTY", size=8.5, font="Helvetica-Bold", color=white)
    draw_right(page, 492, table_top + 10, "UNIT", size=8.5, font="Helvetica-Bold", color=white)
    draw_right(page, PAGE_WIDTH - 60, table_top + 10, "AMOUNT", size=8.5, font="Helvetica-Bold", color=white)

    row_top = table_top - 58
    draw_text(page, 60, row_top + 30, "Controlled Agent2 DRAFT UAT service", size=10, font="Helvetica-Bold")
    draw_text(page, 60, row_top + 13, "Synthetic validation only. No real goods, services or payment.", size=8.5, color=MUTED)
    draw_right(page, 425, row_top + 23, "1.0000", size=9)
    draw_right(page, 492, row_top + 23, "12.34", size=9)
    draw_right(page, PAGE_WIDTH - 60, row_top + 23, "12.34", size=9, font="Helvetica-Bold")
    page.setStrokeColor(LINE)
    page.line(48, row_top, PAGE_WIDTH - 48, row_top)

    totals_top = row_top - 42
    totals = [
        ("Subtotal", "HKD 12.34", False),
        ("Tax (No Tax)", "HKD 0.00", False),
        ("TOTAL", "HKD 12.34", True),
        ("Amount due", "HKD 12.34", True),
    ]
    for index, (label, value, emphasized) in enumerate(totals):
        y = totals_top - (index * 25)
        draw_text(
            page,
            340,
            y,
            label,
            size=9.5,
            font="Helvetica-Bold" if emphasized else "Helvetica",
            color=NAVY if emphasized else MUTED,
        )
        draw_right(
            page,
            PAGE_WIDTH - 48,
            y,
            value,
            size=10,
            font="Helvetica-Bold" if emphasized else "Helvetica",
            color=NAVY if emphasized else TEXT,
        )
        if index == 1:
            page.setStrokeColor(LINE)
            page.line(340, y - 11, PAGE_WIDTH - 48, y - 11)

    notice_y = 166
    page.setFillColor(LIGHT_BLUE)
    page.roundRect(48, notice_y, PAGE_WIDTH - 96, 90, 8, stroke=0, fill=1)
    draw_text(page, 62, notice_y + 68, "HUMAN REVIEW REQUIRED", size=10, font="Helvetica-Bold", color=BLUE)
    draw_text(page, 62, notice_y + 48, "Suggested coding: 485 - Subscriptions; tax type NONE (Tax Exempt).", size=8.5)
    draw_text(page, 62, notice_y + 32, "The Agent must re-read the live Xero contact, account and tax code before preparing.", size=8.5)
    draw_text(page, 62, notice_y + 16, "Create one DRAFT only after a new explicit confirmation. Never authorise or pay.", size=8.5, color=RED)

    page.setStrokeColor(LINE)
    page.line(48, 112, PAGE_WIDTH - 48, 112)
    draw_text(page, 48, 92, "PAYMENT DETAILS", size=8.5, font="Helvetica-Bold", color=MUTED)
    draw_text(page, 48, 75, "DO NOT PAY - no bank account is provided.", size=9, font="Helvetica-Bold", color=RED)
    draw_right(page, PAGE_WIDTH - 48, 92, "Page 1 of 1", size=8.5, color=MUTED)
    draw_right(page, PAGE_WIDTH - 48, 75, "Generated solely for authorized Agent2 and Xero MCP testing.", size=8.5, color=MUTED)
    draw_right(page, PAGE_WIDTH - 48, 60, "No legal, tax, payment or commercial effect.", size=8.5, color=MUTED)

    page.showPage()
    page.save()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("output/pdf/agent2-xero-draft-uat-invoice-2026-08-05.pdf"),
    )
    args = parser.parse_args()
    build_invoice(args.output)
    print(args.output)


if __name__ == "__main__":
    main()
