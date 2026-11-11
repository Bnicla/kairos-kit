#!/bin/zsh
# Visual layout validation for a rendered resume docx (template-agnostic):
#   1. LibreOffice headless -> PDF (real pagination, whatever the template)
#   2. pypdf -> page count + per-page text volume + last-page fill ratio
#   3. pdftoppm -> per-page PNGs for actual visual inspection
# Usage: scripts/validate-resume-layout.sh <resume.docx> [outdir]
#   With no outdir, a new temporary folder is used. A given outdir must be empty
#   or not exist yet: the script never deletes a folder.
set -e
f="$1"
[ -f "$f" ] || { print -u2 "Usage: $0 <resume.docx> [outdir]"; exit 1; }
if [ -n "${2:-}" ]; then
  out="$2"
  if [ -e "$out" ] && [ -n "$(ls -A "$out" 2>/dev/null)" ]; then print -u2 "$out is not empty; give an empty or new folder."; exit 1; fi
  mkdir -p "$out"
else
  out="$(mktemp -d "${TMPDIR:-/tmp}/resume-layout.XXXXXX")"
fi
soffice=""
for c in "${SOFFICE_PATH:-}" /opt/homebrew/bin/soffice /usr/local/bin/soffice /Applications/LibreOffice.app/Contents/MacOS/soffice; do
  [ -n "$c" ] && [ -x "$c" ] && { soffice="$c"; break; }
done
[ -n "$soffice" ] || { print -u2 "LibreOffice not found (brew install --cask libreoffice)."; exit 1; }
"$soffice" --headless --invisible --norestore -env:UserInstallation=file:///tmp/lo-kairos-profile --convert-to pdf --outdir "$out" "$f" >/dev/null 2>&1
pdf=("$out"/*.pdf)
pdftoppm -png -r 80 "$pdf" "$out/page"
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
