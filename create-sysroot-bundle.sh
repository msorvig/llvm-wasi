#!/bin/bash
# Create a sysroot.bundle for in-browser clang from wasi-sdk headers and libraries.
# The bundle provides C/C++ headers, clang resource headers, and static libraries
# needed for compiling and linking wasm32-wasip1 programs.
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

# 3. Static libraries and CRT objects for linking.
#    wasm-ld looks for libs under the sysroot at lib/<triple>/
for target in wasm32-wasi wasm32-wasip1; do
    srcdir="$WASI_SDK/share/wasi-sysroot/lib/$target"
    [ -d "$srcdir" ] || continue
    mkdir -p "$STAGING/lib/$target"
    # Copy .a and .o files (skip .so and llvm-lto dirs)
    find "$srcdir" -maxdepth 1 \( -name '*.a' -o -name '*.o' \) -exec cp {} "$STAGING/lib/$target/" \;
    # Also create the full triple variant
    cp -r "$STAGING/lib/$target" "$STAGING/lib/wasm32-unknown-${target#wasm32-}"
done

# 4. Compiler-rt builtins (libclang_rt.builtins.a)
#    With -DCLANG_RESOURCE_DIR=/usr, clang looks for builtins at /usr/lib/<triple>/
for target in wasm32-unknown-wasi wasm32-unknown-wasip1; do
    srcdir="$WASI_SDK/lib/clang/$CLANG_VER/lib/$target"
    [ -d "$srcdir" ] || continue
    mkdir -p "$STAGING/lib/$target"
    cp "$srcdir"/libclang_rt.builtins.a "$STAGING/lib/$target/" 2>/dev/null || true
done

# 5. Nuscripten-core headers (val.h etc. for JS interop)
NUSCRIPTEN_INCLUDE="$(dirname "$0")/nuscripten-core/include"
if [ -d "$NUSCRIPTEN_INCLUDE" ]; then
    mkdir -p "$STAGING/include/nuscripten"
    cp "$NUSCRIPTEN_INCLUDE"/val.h "$STAGING/include/nuscripten/"
    cp "$NUSCRIPTEN_INCLUDE"/val_detail.h "$STAGING/include/nuscripten/"
    cp "$NUSCRIPTEN_INCLUDE"/val_backend_objects.h "$STAGING/include/nuscripten/"
    cp "$NUSCRIPTEN_INCLUDE"/val_backend_table.h "$STAGING/include/nuscripten/"
    cp "$NUSCRIPTEN_INCLUDE"/export.h "$STAGING/include/nuscripten/"
fi

echo "Sysroot contents:"
find "$STAGING" -type f | sort | while read f; do
    size=$(du -h "$f" | cut -f1)
    echo "  $size  ${f#$STAGING/}"
done

# Create bundle
OUTPUT="clang-wasi/sysroot.bundle"
node nuscripten-core/runtime/filesystem.js create-bundle "$STAGING" "$OUTPUT"
echo "Done: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
