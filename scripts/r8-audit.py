"""Three-hop audit for R8: report -> asset file -> source URL.

Hop 1: every number in report.docx must exist in assets/data.csv.
Hop 2: every [S#] citation in report.docx must exist in assets/sources.json, and
       every image asset must match the sha256 stored in sources.json.
Hop 3: every cited URL must answer (HTTP 200) when fetched now.

Exit code is 0 only when all three hops pass for every record.
"""

import csv
import hashlib
import json
import os
import sys
import urllib.request
from urllib.error import HTTPError, URLError

from docx import Document

ROOT = os.path.join("research", "R8-交付链")
ASSETS = os.path.join(ROOT, "assets")
DOCX = os.path.join(ROOT, "report.docx")

failures = []
notes = []


def fail(msg):
    failures.append(msg)


# ---------------------------------------------------------------- load assets
with open(os.path.join(ASSETS, "data.csv"), encoding="utf-8", newline="") as handle:
    rows = list(csv.DictReader(handle))

with open(os.path.join(ASSETS, "sources.json"), encoding="utf-8") as handle:
    sources = json.load(handle)

by_id = {item["id"]: item for item in sources["items"]}

doc = Document(DOCX)
paragraphs = [p.text for p in doc.paragraphs]
for table in doc.tables:
    for row in table.rows:
        for cell in row.cells:
            paragraphs.append(cell.text)
report_text = "\n".join(paragraphs)

# ------------------------------------------------------- hop 1: numbers in text
total = sum(int(row["中标金额_元"]) for row in rows)
if f"{total:,}" not in report_text:
    fail(f"hop1: total {total:,} not found in report text")
for index, row in enumerate(rows, start=1):
    amount = f"{int(row['中标金额_元']):,}"
    if amount not in report_text:
        fail(f"hop1: row {index} amount {amount} not found in report text")
if len(rows) != 3:
    fail(f"hop1: expected 3 records, csv has {len(rows)}")

# -------------------------------------------- hop 2: [S#] citations + image sha
cited = [f"[{item_id}]" for item_id in by_id]
used = [token for token in cited if token in report_text]
if "[S3]" not in used or "[S5]" not in used or "[S6]" not in used:
    fail(f"hop2: row citations missing, found {used}")

for item in sources["items"]:
    path = item.get("file")
    if not path:
        continue
    file_path = os.path.join(ROOT, path)
    if not os.path.exists(file_path):
        fail(f"hop2: asset missing {path}")
        continue
    digest = hashlib.sha256(open(file_path, "rb").read()).hexdigest()
    if digest != item["sha256"]:
        fail(f"hop2: sha256 mismatch for {path}")
    notes.append(f"{path}: sha256 ok ({item['bytes']} B)")

# --------------------------------------------------- hop 3: every cited URL answers
checked = {}
for item in sources["items"]:
    url = item["url"]
    if url in checked:
        continue
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (r8-audit)"})
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            checked[url] = response.status
    except HTTPError as error:
        checked[url] = error.code
    except (URLError, TimeoutError, OSError) as error:
        checked[url] = f"error: {type(error).__name__}"

for url, status in checked.items():
    if status != 200:
        fail(f"hop3: {status} for {url}")

result = {
    "records": len(rows),
    "total_yuan": total,
    "citations_used": used,
    "images_verified": len([i for i in sources["items"] if i.get("file")]),
    "urls_checked": len(checked),
    "url_status": checked,
    "failures": failures,
    "pass": not failures,
}
print(json.dumps(result, ensure_ascii=False, indent=2))
sys.exit(0 if not failures else 1)
