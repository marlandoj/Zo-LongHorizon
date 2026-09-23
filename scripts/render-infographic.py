#!/usr/bin/env python3
"""Render the kit's HTML infographic to a 2x PNG.

HTML is used instead of an image model because the graphic is dense technical text —
script names, thresholds, contract steps — where a generated image would produce
plausible-looking but wrong labels.

  render-infographic.py [--html PATH] [--out PATH] [--scale 2]
"""
from __future__ import annotations

import argparse
import os
import sys

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_HTML = os.path.join(KIT, "assets", "infographic", "bridge-workflows.html")
DEFAULT_OUT = os.path.join(KIT, "assets", "infographic", "bridge-workflows.png")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--html", default=DEFAULT_HTML)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--scale", type=int, default=2)
    ap.add_argument("--width", type=int, default=1400)
    args = ap.parse_args()

    if not os.path.isfile(args.html):
        print(f"ERROR html not found: {args.html}", file=sys.stderr)
        return 2
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR playwright not installed: pip install playwright && playwright install chromium",
              file=sys.stderr)
        return 2

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox", "--font-render-hinting=none"])
        page = browser.new_page(viewport={"width": args.width, "height": 100},
                                device_scale_factor=args.scale)
        page.goto(f"file://{os.path.abspath(args.html)}", wait_until="load")
        page.wait_for_timeout(600)
        height = page.evaluate("document.documentElement.scrollHeight")
        page.screenshot(path=args.out, full_page=True)
        browser.close()

    size = os.path.getsize(args.out)
    print(f"rendered  {args.out}\n          {args.width}x{height} css px at {args.scale}x  "
          f"({size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
