"""보고서 공통 내보내기 (CSV / XLSX / PDF).

report = {"title": str, "meta": [[label, value], ...],
          "tables": [{"title": str, "columns": [[key, label], ...], "rows": [dict, ...]}]}
"""
from __future__ import annotations

import csv
import io
from urllib.parse import quote

from fastapi.responses import Response


def _fmt(v):
    if v is None:
        return ""
    if isinstance(v, float):
        return round(v, 2)
    return v


def to_csv(report: dict) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([report["title"]])
    for label, value in report.get("meta", []):
        w.writerow([label, _fmt(value)])
    for t in report["tables"]:
        w.writerow([])
        w.writerow([t["title"]])
        w.writerow([lbl for _, lbl in t["columns"]])
        for r in t["rows"]:
            w.writerow([_fmt(r.get(k)) for k, _ in t["columns"]])
    return ("﻿" + buf.getvalue()).encode("utf-8")


def to_xlsx(report: dict) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = "요약"
    ws.append([report["title"]])
    ws["A1"].font = Font(size=14, bold=True)
    for label, value in report.get("meta", []):
        ws.append([label, _fmt(value)])
    ws.column_dimensions["A"].width = 22
    ws.column_dimensions["B"].width = 50
    header_fill = PatternFill("solid", fgColor="DDE6F5")
    used = set()
    for t in report["tables"]:
        name = "".join(ch for ch in t["title"] if ch not in '[]:*?/\\')[:28] or "표"
        base, n = name, 2
        while name in used:
            name = f"{base[:25]}_{n}"; n += 1
        used.add(name)
        sh = wb.create_sheet(name)
        sh.append([lbl for _, lbl in t["columns"]])
        for c in sh[1]:
            c.font = Font(bold=True)
            c.fill = header_fill
            c.alignment = Alignment(horizontal="center")
        for r in t["rows"]:
            sh.append([_fmt(r.get(k)) for k, _ in t["columns"]])
        for i, (_, lbl) in enumerate(t["columns"], start=1):
            sh.column_dimensions[get_column_letter(i)].width = max(10, min(40, len(str(lbl)) * 2 + 4))
        sh.freeze_panes = "A2"
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def to_pdf(report: dict) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    font = "HYGothic-Medium"  # 한글 CID 폰트 (별도 폰트 파일 불필요)
    try:
        pdfmetrics.getFont(font)
    except KeyError:
        pdfmetrics.registerFont(UnicodeCIDFont(font))
    h1 = ParagraphStyle("h1", fontName=font, fontSize=16, leading=22, spaceAfter=6)
    h2 = ParagraphStyle("h2", fontName=font, fontSize=12, leading=16, spaceBefore=10, spaceAfter=4)
    body = ParagraphStyle("b", fontName=font, fontSize=8, leading=10)

    def esc(s):
        return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(A4), leftMargin=12 * mm, rightMargin=12 * mm,
                            topMargin=12 * mm, bottomMargin=12 * mm, title=report["title"])
    story = [Paragraph(esc(report["title"]), h1)]
    meta = report.get("meta", [])
    if meta:
        mt = Table([[Paragraph(esc(l), body), Paragraph(esc(_fmt(v)), body)] for l, v in meta],
                   colWidths=[45 * mm, 200 * mm])
        mt.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.3, colors.grey),
                                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#EEF2F8"))]))
        story.append(mt)
    for t in report["tables"]:
        story.append(Paragraph(esc(t["title"]), h2))
        data = [[Paragraph(esc(lbl), body) for _, lbl in t["columns"]]]
        for r in t["rows"][:2000]:
            data.append([Paragraph(esc(_fmt(r.get(k))), body) for k, _ in t["columns"]])
        if len(data) == 1:
            data.append([Paragraph("데이터 없음", body)] + [""] * (len(t["columns"]) - 1))
        tb = Table(data, repeatRows=1)
        tb.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.3, colors.grey),
                                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DDE6F5")),
                                ("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(tb)
        story.append(Spacer(1, 4 * mm))
    doc.build(story)
    return buf.getvalue()


MEDIA = {"csv": "text/csv; charset=utf-8",
         "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
         "pdf": "application/pdf"}


def export_response(report: dict, fmt: str, filename: str):
    if fmt == "json":
        return report
    if fmt not in MEDIA:
        from fastapi import HTTPException
        raise HTTPException(400, "format 은 json, csv, xlsx, pdf 중 하나여야 합니다")
    data = {"csv": to_csv, "xlsx": to_xlsx, "pdf": to_pdf}[fmt](report)
    fname = f"{filename}.{fmt}"
    return Response(data, media_type=MEDIA[fmt], headers={
        "Content-Disposition": f"attachment; filename=\"report.{fmt}\"; filename*=UTF-8''{quote(fname)}"})
