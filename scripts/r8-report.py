"""Build research/R8-交付链/report.docx from the local assets only.

Data comes from assets/data.csv and assets/sources.json — no network access, no
re-scraping. Every number in the report is taken from the CSV row it cites.
"""

import csv
import json
import os
from datetime import datetime
from io import BytesIO

from PIL import Image
from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Cm, Pt

ROOT = os.path.join("research", "R8-交付链")
ASSETS = os.path.join(ROOT, "assets")
OUT = os.path.join(ROOT, "report.docx")

with open(os.path.join(ASSETS, "data.csv"), encoding="utf-8", newline="") as handle:
    rows = list(csv.DictReader(handle))

with open(os.path.join(ASSETS, "sources.json"), encoding="utf-8") as handle:
    sources = json.load(handle)

by_id = {item["id"]: item for item in sources["items"]}

doc = Document()
style = doc.styles["Normal"]
style.font.name = "等线"
style.font.size = Pt(10.5)
style.element.rPr.rFonts.set(qn("w:eastAsia"), "等线")

title = doc.add_heading("服务器类政府采购中标情况调研（近 30 天）", level=0)
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
for run in title.runs:
    run.font.size = Pt(18)

section = doc.sections[0]
section.top_margin = Cm(2.0)
section.bottom_margin = Cm(2.0)
section.left_margin = Cm(2.2)
section.right_margin = Cm(2.2)

sub = doc.add_paragraph()
sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = sub.add_run("数据源：中国政府采购网 · 检索口径：标题含「服务器」+ 中标公告 + 2026-10-20 至 2026-11-20 · 编制时间：2026-11-20")
run.font.size = Pt(9)

doc.add_heading("一、摘要", level=1)
total = sum(int(row["中标金额_元"]) for row in rows)
doc.add_paragraph(
    f"以「服务器」为标题关键词检索中国政府采购网，限定类型为“中标公告”、时间窗 2026-10-20 至 2026-11-20，"
    f"共命中 167 条。本文抽取前 3 条核验到详情页的记录，合计中标金额 {total:,} 元"
    f"（{total / 10000:,.2f} 万元）。三单分别来自高校、科研院所与地方公安，采购内容均为算力或存储服务器。"
)

doc.add_heading("二、方法", level=1)
for line in [
    "站点：中国政府采购网（search.ccgp.gov.cn 检索页 + www.ccgp.gov.cn 公告详情页），仅访问公开页面，未登录、未提交任何表单。",
    "筛选：类型＝中标公告；时间＝近 1 月（站点实际给出 2026-10-20 至 2026-11-20）；类别与品目保持“所有”。",
    "抽样：取结果页第 1 页前 3 条，逐条打开详情页核对项目编号、供应商、中标金额与公告时间。",
    "去重：比对第 1–3 页共 60 条记录的公告 ID，无重复；另记录到「（二次）」重新招标样本 1 条，说明同一项目多次公告确有其事。",
    "口径：金额一律取公告原文，万元按 1 万元＝10,000 元换算为“元”；金额原文同时保留在素材表中。",
]:
    doc.add_paragraph(line, style="List Bullet")

doc.add_heading("三、发现", level=1)

table = doc.add_table(rows=1, cols=4)
table.style = "Table Grid"
table.alignment = WD_TABLE_ALIGNMENT.CENTER
head = table.rows[0].cells
for cell, text in zip(head, ["项目（简称）", "中标供应商", "中标金额（元）", "公告日期"]):
    cell.text = ""
    cell.paragraphs[0].add_run(text).bold = True

for row, src in zip(rows, ["S3", "S5", "S6"]):
    cells = table.add_row().cells
    cells[0].text = row["项目名称"] + f" [{src}]"
    cells[1].text = row["中标供应商"] + f" [{src}]"
    cells[2].text = f"{int(row['中标金额_元']):,}" + f" [{src}]"
    cells[3].text = row["公告日期"] + f" [{src}]"

for cell in table.rows[0].cells:
    for paragraph in cell.paragraphs:
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER

doc.add_paragraph()
para = doc.add_paragraph(
    "三单的采购人、供应商与金额互不相同，且均为单一来源/公开招标后的中标结果，未见同一项目重复计入。"
    f"合计 {total:,} 元；若按单笔看，最大一单为 {max(int(r['中标金额_元']) for r in rows):,} 元。"
)

figs = doc.add_table(rows=1, cols=2)
figs.alignment = WD_TABLE_ALIGNMENT.CENTER


def crop(name, box):
    """裁剪可读区域；整页原图仍留在 assets/ 里。"""
    buffer = BytesIO()
    with Image.open(os.path.join(ASSETS, name)) as image:
        image.crop(box).save(buffer, format="PNG")
    buffer.seek(0)
    return buffer


for cell, name, box, caption in [
    (figs.rows[0].cells[0], "shot-list.png", (0, 0, 768, 1120),
     "图 1　检索页（中标公告 + 近 1 月，共 167 条）[S2]\n整页 768 × 2472 见 assets/shot-list.png"),
    (figs.rows[0].cells[1], "shot-detail.png", (0, 0, 768, 1250),
     "图 2　合肥工业大学中标公告（144.6200000 万元）[S4]\n整页 768 × 2779 见 assets/shot-detail.png"),
]:
    cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
    cell.paragraphs[0].add_run().add_picture(crop(name, box), width=Cm(8.0))
    note = cell.add_paragraph(caption)
    note.alignment = WD_ALIGN_PARAGRAPH.CENTER
    note.runs[0].font.size = Pt(8)

doc.add_heading("四、来源清单", level=1)
for item in sources["items"]:
    para = doc.add_paragraph(style="List Bullet")
    when = item["capturedAt"][5:16].replace("T", " ")
    url = item["url"]
    shown = url if len(url) <= 92 else url[:88] + "…（完整 URL 见 assets/sources.json）"
    run = para.add_run(f"[{item['id']}] {item['title']}　{shown}　（抓取 {when}）")
    run.font.size = Pt(8.5)

doc.add_heading("五、不确定项与口径提醒", level=1)
for line in [
    "第 1 行（合肥工业大学）公告正文的“主要标的信息”只列 1 项：2 台 × 48,000 元 ＝ 96,000 元，与总价 1,446,200 元不一致。报告按公告总额记录，未推断差额构成；需要明细时应索取附件或向采购人核实。",
    "第 2 行（生物育种钟山实验室）含两个采购包：包 1 为 5,980,000 元（中电鸿信），包 2 为 3,439,600 元（南京信同诚）。本报告只计包 1，包 2 未计入合计；且包 1 单价 5,890,000 元与中标金额 5,980,000 元相差 90,000 元，差额未说明。",
    "第 3 行（张家港市公安局）主要标的以附件形式给出，页面本身不含单价与数量，无法复算总额。",
    "本次抽样只取第 1 页前 3 条，不代表 167 条的整体分布；如需结论性统计，应全量抽取并按采购人类别分层。",
    "本站“近 1 月”实际为 2026-10-20 至 2026-11-20（32 天），与自然月不完全一致，检索时以站点显示的起止日为准。",
]:
    doc.add_paragraph(line, style="List Bullet")

doc.save(OUT)
print(json.dumps({"out": OUT, "bytes": os.path.getsize(OUT), "rows": len(rows), "images": 2}, ensure_ascii=False))
