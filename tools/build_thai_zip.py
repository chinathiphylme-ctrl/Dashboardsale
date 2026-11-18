"""Build the compact Thai postcode table that index.html embeds (const THAI_ZIP_DATA).

Source: thailand-geography-data/thailand-geography-json@1.3.0 src/geography.json (MIT, Thailand Post data),
downloaded once from cdn.jsdelivr.net (18 Nov 2026). Usage:
    python -I tools/build_thai_zip.py <geography.json>   -> prints the JS string literal + stats to stdout files

Format (one line per province):  จังหวัด>อำเภอ=รหัสหลัก:ตำบล,ตำบล=รหัส,*ตำบล|อำเภอ=...
  - รหัสหลัก = the postcode most subdistricts of that district use; a bare ตำบล uses it
  - ตำบล=รหัส = a subdistrict whose primary postcode differs
  - *ตำบล = a subdistrict with more than one postcode (depends on village) -> the page marks it "ตรวจสอบ"
"""
import collections
import json
import sys
from pathlib import Path


def build(rows):
    tree = collections.OrderedDict()
    for r in rows:
        p, d, s = r['provinceNameTh'].strip(), r['districtNameTh'].strip(), r['subdistrictNameTh'].strip()
        codes = [c['postalCode'] for c in (r.get('postalCodes') or [])] or [r['postalCode']]
        tree.setdefault(p, collections.OrderedDict()).setdefault(d, []).append((s, str(r['postalCode']), len(set(codes)) > 1))
    lines = []
    for p, ds in tree.items():
        parts = []
        for d, subs in ds.items():
            main = collections.Counter(z for _, z, _ in subs).most_common(1)[0][0]
            subl = ','.join(('*' if m else '') + s + ('' if z == main else '=' + z) for s, z, m in subs)
            parts.append(f'{d}={main}:{subl}')
        lines.append(p + '>' + '|'.join(parts))
    return '\n'.join(lines), tree


def main():
    src = Path(sys.argv[1])
    rows = json.loads(src.read_text(encoding='utf-8'))
    text, tree = build(rows)
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_name('thai_zip_data.txt')
    out.write_text(text, encoding='utf-8')
    nd = sum(len(v) for v in tree.values())
    print(f'provinces {len(tree)} districts {nd} subdistricts {len(rows)} -> {len(text.encode("utf-8")):,} bytes -> {out}')


if __name__ == '__main__':
    main()
