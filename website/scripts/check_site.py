#!/usr/bin/env python3
"""Check static Cloudflare Pages site links, assets, and translation keys."""

from html.parser import HTMLParser
from pathlib import Path
import re
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.translations = set()
        self.alt_translations = set()
        self.ids = set()
        self.local_assets = set()
        self.external_links = []
        self.element_count = 0

    def handle_starttag(self, tag, attrs):
        self.element_count += 1
        values = dict(attrs)
        key = values.get("data-i18n")
        if key:
            self.translations.add(key)
        alt_key = values.get("data-i18n-alt")
        if alt_key:
            self.alt_translations.add(alt_key)
        element_id = values.get("id")
        if element_id:
            if element_id in self.ids:
                raise ValueError(f"Duplicate id: {element_id}")
            self.ids.add(element_id)
        for attr in ("src", "href"):
            path = values.get(attr, "")
            if not path:
                continue
            if path.startswith("http"):
                if tag == "a" and values.get("target") == "_blank":
                    self.external_links.append((path, values.get("rel", "")))
                continue
            if path.startswith("#") or path.startswith("mailto:"):
                continue
            if not path.startswith("./"):
                continue
            self.local_assets.add(path[2:])


def validate():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    js = (ROOT / "app.js").read_text(encoding="utf-8")
    css = (ROOT / "styles.css").read_text(encoding="utf-8")
    parser = PageParser()
    parser.feed(html)
    assert parser.element_count >= 100, "HTML seems unexpectedly empty"

    for asset in parser.local_assets:
        path = ROOT / asset
        assert path.is_file(), f"Missing local asset: {asset}"

    for key in parser.translations | parser.alt_translations:
        # Both dictionaries are explicit JavaScript object literals.
        matches = re.findall(r"(?:^|[,{])\s*" + re.escape(key) + r"\s*:", js, flags=re.MULTILINE)
        assert len(matches) == 2, f"Missing bilingual translation: {key}"

    for url, rel in parser.external_links:
        assert "noopener" in rel and "noreferrer" in rel, f"Unsafe external link: {url}"

    required_ids = {"main", "top", "features", "preview", "download", "trust",
                    "setup-link", "portable-link", "release-pill", "language-toggle"}
    assert required_ids.issubset(parser.ids), f"Missing anchor ids: {required_ids - parser.ids}"
    assert "prefers-reduced-motion" in css, "Respect reduced-motion preference"
    headers = (ROOT / "_headers").read_text(encoding="utf-8")
    assert "Content-Security-Policy" in headers
    assert "script-src 'self'" in headers
    assert "unsafe-inline" not in headers
    assert "api.github.com" in headers
    ET.parse(ROOT / "sitemap.xml")
    assert (ROOT / "robots.txt").is_file()
    print(f"Verified {parser.element_count} HTML elements, {len(parser.local_assets)} local assets, "
          f"{len(parser.translations | parser.alt_translations)} bilingual translations.")


if __name__ == "__main__":
    validate()
