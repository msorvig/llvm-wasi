#!/bin/bash
# Create the JS dist directory with bundled sources, wasm binary, and sysroot.
# Usage: ./create-dist.sh

set -e
cd "$(dirname "$0")"

if [ ! -d node_modules/rollup ]; then
    npm install
fi

rm -rf dist
mkdir -p dist

npx rollup -c

cp -L clang-wasi/bin/llvm dist/llvm.wasm
cp clang-wasi/sysroot.bundle dist/
cp example/index.html dist/

echo ""
echo "Built dist/:"
du -sh dist/*
echo ""
echo "Serve with: cd dist && python3 -m http.server 8080"
