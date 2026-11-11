#!/bin/zsh
# Visual layout validation for a rendered resume docx (template-agnostic):
#   1. LibreOffice headless -> PDF (real pagination, whatever the template)
#   2. pypdf -> page count + per-page text volume + last-page fill ratio
#   3. pdftoppm -> per-page PNGs for actual visual inspection
# Usage: scripts/validate-resume-layout.sh <resume.docx> [outdir]
set -e
f="$1"
out="${2:-/tmp/resume-layout-check}"
rm -rf "$out" && mkdir -p "$out"
/opt/homebrew/bin/soffice --headless --invisible --norestore -env:UserInstallation=file:///tmp/lo-kairos-profile --convert-to pdf --outdir "$out" "$f" >/dev/null 2>&1
pdf=("$out"/*.pdf)
/opt/homebrew/bin/pdftoppm -png -r 80 "$pdf" "$out/page"
python3 - "$pdf" <<'PY'
import sys
from pypdf import PdfReader
r=PdfReader(sys.argv[1])
chars=[len((p.extract_text() or '')) for p in r.pages]
print(f"pages: {len(chars)}")
for i,c in enumerate(chars,1): print(f"  page {i}: {c} chars")
if len(chars)>1:
    fill=chars[-1]/chars[0]*100
    print(f"  last-page fill vs page 1: {fill:.0f}%")
    if len(chars)>2: print("  VERDICT: FAIL (spills past 2 pages)")
    elif fill<80: print("  VERDICT: FAIL (last page under 80% full)")
    else: print("  VERDICT: PASS")
PY
echo "page images: $out/page-*.png"
