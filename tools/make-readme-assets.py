"""Regenerate the two case screenshots used by the root README.

Both sources are real captures kept in the repo (docs/cases/shots/, screenshots/);
this script only crops and downscales them so the README stays light.

    python tools/make-readme-assets.py

Requires Pillow. `docs/assets/hero.svg` is hand-written and not generated here.
"""

from PIL import Image
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out = root / "docs" / "assets"
out.mkdir(parents=True, exist_ok=True)


def save(img, name, width, quality=84):
    if img.width > width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    path = out / name
    img.convert("RGB").save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    print(f"{name}: {img.width}x{img.height} {path.stat().st_size / 1024:.0f} KB")


# 1. 百度地图地球视图（真实站点，JS 渲染）
earth = Image.open(root / "reference" / "shots" / "baidu-earth-hangzhou.png")
save(earth, "case-baidu-earth.jpg", 960)

# 2. 政府采购整页拼接截图（裁到「搜索区 + 前几条结果」，保留整页感）
ccgp = Image.open(root / "screenshots" / "ccgp-list-full.png")
save(ccgp.crop((0, 0, ccgp.width, 1180)), "case-ccgp-list.jpg", 720)
