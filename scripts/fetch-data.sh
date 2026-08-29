#!/usr/bin/env bash
# Fetch the WebShop corpus. See data/PROVENANCE.md for source, licence and caveats.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data && cd data

if [ -f items_human_ins.json ] && [ -f items_shuffle_1000.json ]; then
  echo "Data already present. Run 'npm run data:verify' to check integrity."
  exit 0
fi

# Official source is Google Drive via gdown, but those links now require
# sign-in (checked 2026-08-28). Public HuggingFace mirror of the same
# MIT-licensed files:
echo "Downloading webshop-small.tar.gz ..."
curl -fL "https://huggingface.co/datasets/zhangdw/webshop/resolve/main/raw/webshop-small.tar.gz" \
  -o webshop-small.tar.gz
tar -xzf webshop-small.tar.gz --strip-components=1
echo "Done. Verify with: npm run data:verify"
