#!/usr/bin/env python3
"""Generate the deterministic synthetic supplier invoice used by live Xero UAT."""

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


def draw_text(c: canvas.Canvas, x: float, y: float, text: str, *, size: float = 10,
              font: str = "Helvetica", color: Color = TEXT) -> None:
    c.setFont(font, size)
    c.setFillColor(color)
    c.drawString(x, y, text)


def draw_right(c: canvas.Canvas, x: float, y: float, text: str, *, size: float = 10,
               font: str = "Helvetica", color: Color = TEXT) -> None:
    c.setFont(font, size)
    c.setFillColor(color)
    c.drawRightString(x, y, text)


def build_invoice(output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(
        str(output_path),
        pagesize=A4,
        invariant=1,
        pageCompression=1,
    )
    c.setTitle("Synthetic Supplier Invoice - Xero MCP UAT")
    c.setAuthor("zCloak Accounting MCP Demo")
    c.setSubject("Synthetic test document with no legal or payment effect")

    # Header.
    c.setFillColor(NAVY)
    c.rect(0, PAGE_HEIGHT - 118, PAGE_WIDTH, 118, stroke=0, fill=1)
    draw_text(c, 48, PAGE_HEIGHT - 54, "zCloak Synthetic Supplies Pte. Ltd.",
              size=14, font="Helvetica-Bold", color=white)
    draw_text(c, 48, PAGE_HEIGHT - 75, "1 Demo Ledger Lane, Singapore 000001",
              size=9, color=HexColor("#D8E4F2"))
    draw_text(c, 48, PAGE_HEIGHT - 92, "Registration: TEST-ONLY-20260803",
              size=9, color=HexColor("#D8E4F2"))
    draw_right(c, PAGE_WIDTH - 48, PAGE_HEIGHT - 58, "INVOICE",
               size=21, font="Helvetica-Bold", color=white)
    draw_right(c, PAGE_WIDTH - 48, PAGE_HEIGHT - 84, "SGD", size=12,
               font="Helvetica-Bold", color=HexColor("#D8E4F2"))

    # Test-only notice.
    c.setFillColor(LIGHT_RED)
    c.roundRect(48, PAGE_HEIGHT - 160, PAGE_WIDTH - 96, 26, 5, stroke=0, fill=1)
    draw_text(c, 60, PAGE_HEIGHT - 151,
              "AUTHORIZED UAT ARTIFACT - SYNTHETIC DATA - NO GOODS, SERVICES, TAX OR PAYMENT",
              size=8.5, font="Helvetica-Bold", color=RED)

    # Invoice metadata.
    meta_top = PAGE_HEIGHT - 202
    draw_text(c, 48, meta_top, "BILL TO", size=8.5, font="Helvetica-Bold", color=BLUE)
    draw_text(c, 48, meta_top - 22, "Xero Trial Organisation", size=12, font="Helvetica-Bold")
    draw_text(c, 48, meta_top - 39, "Test organisation only", size=9, color=MUTED)
    draw_text(c, 48, meta_top - 56, "No bank connection or payment authority", size=9, color=MUTED)

    label_x = 340
    value_x = PAGE_WIDTH - 48
    metadata = [
        ("Invoice number", "ZC-MCP-SYN-20260803-001"),
        ("Invoice date", "2026-08-03"),
        ("Due date", "2026-08-17"),
        ("Source reference", "SRC-ZC-XERO-20260803-001"),
    ]
    for index, (label, value) in enumerate(metadata):
        y = meta_top - (index * 22)
        draw_text(c, label_x, y, label, size=8.5, color=MUTED)
        draw_right(c, value_x, y, value, size=9, font="Helvetica-Bold")

    # Line item table.
    table_top = PAGE_HEIGHT - 320
    c.setFillColor(NAVY)
    c.roundRect(48, table_top, PAGE_WIDTH - 96, 30, 5, stroke=0, fill=1)
    draw_text(c, 60, table_top + 10, "DESCRIPTION", size=8.5, font="Helvetica-Bold", color=white)
    draw_right(c, 425, table_top + 10, "QTY", size=8.5, font="Helvetica-Bold", color=white)
    draw_right(c, 492, table_top + 10, "UNIT", size=8.5, font="Helvetica-Bold", color=white)
    draw_right(c, PAGE_WIDTH - 60, table_top + 10, "AMOUNT", size=8.5,
               font="Helvetica-Bold", color=white)

    row_top = table_top - 58
    draw_text(c, 60, row_top + 30, "Synthetic accounting workflow validation service",
              size=10, font="Helvetica-Bold")
    draw_text(c, 60, row_top + 13, "No real goods or services. No payment is permitted.",
              size=8.5, color=MUTED)
    draw_right(c, 425, row_top + 23, "1.0000", size=9)
    draw_right(c, 492, row_top + 23, "100.00", size=9)
    draw_right(c, PAGE_WIDTH - 60, row_top + 23, "100.00", size=9, font="Helvetica-Bold")
    c.setStrokeColor(LINE)
    c.line(48, row_top, PAGE_WIDTH - 48, row_top)

    # Totals.
    totals_top = row_top - 42
    totals = [
        ("Subtotal", "SGD 100.00", False),
        ("Tax (No Tax)", "SGD 0.00", False),
        ("TOTAL", "SGD 100.00", True),
        ("Amount due", "SGD 100.00", True),
    ]
    for index, (label, value, emphasized) in enumerate(totals):
        y = totals_top - (index * 25)
        draw_text(c, 340, y, label, size=9.5,
                  font="Helvetica-Bold" if emphasized else "Helvetica", color=NAVY if emphasized else MUTED)
        draw_right(c, PAGE_WIDTH - 48, y, value, size=10,
                   font="Helvetica-Bold" if emphasized else "Helvetica", color=NAVY if emphasized else TEXT)
        if index == 1:
            c.setStrokeColor(LINE)
            c.line(340, y - 11, PAGE_WIDTH - 48, y - 11)

    # Review instructions.
    notice_y = 174
    c.setFillColor(LIGHT_BLUE)
    c.roundRect(48, notice_y, PAGE_WIDTH - 96, 82, 8, stroke=0, fill=1)
    draw_text(c, 62, notice_y + 59, "HUMAN REVIEW REQUIRED", size=10,
              font="Helvetica-Bold", color=BLUE)
    draw_text(c, 62, notice_y + 39,
              "Create only a DRAFT supplier bill. Do not authorise until the reviewer confirms",
              size=8.5, color=TEXT)
    draw_text(c, 62, notice_y + 24,
              "supplier, dates, currency, account, tax treatment, description and total.",
              size=8.5, color=TEXT)
    draw_text(c, 62, notice_y + 9,
              "Never connect a bank, make a payment, or reuse this document outside the test tenant.",
              size=8.5, color=RED)

    # Footer.
    c.setStrokeColor(LINE)
    c.line(48, 112, PAGE_WIDTH - 48, 112)
    draw_text(c, 48, 92, "PAYMENT DETAILS", size=8.5, font="Helvetica-Bold", color=MUTED)
    draw_text(c, 48, 75, "DO NOT PAY - no bank account is provided.", size=9,
              font="Helvetica-Bold", color=RED)
    draw_right(c, PAGE_WIDTH - 48, 92, "Page 1 of 1", size=8.5, color=MUTED)
    draw_right(c, PAGE_WIDTH - 48, 75,
               "Generated solely for authorized Xero MCP testing.", size=8.5, color=MUTED)
    draw_right(c, PAGE_WIDTH - 48, 60,
               "No legal, tax, payment or commercial effect.", size=8.5, color=MUTED)

    c.showPage()
    c.save()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("output/pdf/synthetic-supplier-invoice-xero-mcp-2026-08-03.pdf"),
    )
    args = parser.parse_args()
    build_invoice(args.output)
    print(args.output)


if __name__ == "__main__":
    main()
