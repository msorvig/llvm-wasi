#!/bin/bash
#
# Build everything: LLVM (macOS host + WASI), sysroot bundle, and JS dist.
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${SCRIPT_DIR}"

# Step 1: Build LLVM for macOS (host toolchain)
./configure_macos.sh
ninja -C clang-macos

# Step 2: Build LLVM for WASI (clang.wasm)
./configure_wasi.sh
ninja -C clang-wasi clang

# Step 3: Create sysroot bundle
./create-sysroot-bundle.sh

# Step 4: Build JS dist
./create-dist.sh
