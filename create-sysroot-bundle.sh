#!/bin/bash
# Create a sysroot.bundle for in-browser clang from wasi-sdk headers.
# The bundle provides C headers (no C++ libc++) and clang resource headers.
# Usage: ./create-sysroot-bundle.sh [wasi-sdk-path]

set -e
cd "$(dirname "$0")"

WASI_SDK="${1:-${WASI_SDK:?Set WASI_SDK to your wasi-sdk install path}}"
STAGING=$(mktemp -d)
trap "rm -rf $STAGING" EXIT

echo "Using wasi-sdk at: $WASI_SDK"

# Detect clang version for resource dir
CLANG_VER=$(ls "$WASI_SDK/lib/clang/")
echo "Clang version: $CLANG_VER"

# 1. Clang resource headers (stdarg.h, stddef.h, float.h, limits.h, etc.)
#    Clang binary built with -DCLANG_RESOURCE_DIR=/usr → searches /usr/include/
mkdir -p "$STAGING/include"
cp -r "$WASI_SDK/lib/clang/$CLANG_VER/include/"* "$STAGING/include/"

# 2. WASI libc headers (C and C++) for each target triple.
#    Include both short triples (wasm32-wasi, wasm32-wasip1) and full triples
#    (wasm32-unknown-wasi, wasm32-unknown-wasip1) since clang may use either form.
for target in wasm32-wasi wasm32-wasip1; do
    srcdir="$WASI_SDK/share/wasi-sysroot/include/$target"
    [ -d "$srcdir" ] || continue
    cp -r "$srcdir" "$STAGING/include/$target"
    cp -r "$srcdir" "$STAGING/include/wasm32-unknown-${target#wasm32-}"
done

# Create bundle
OUTPUT="clang-wasi/sysroot.bundle"
node nuscripten-core/runtime/filesystem.js create-bundle "$STAGING" "$OUTPUT"
echo "Done: $OUTPUT"
