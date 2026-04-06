
# wasi-sdk-custom

Clang/LLVM compiled to WebAssembly (wasm32-wasi), for running clang in the browser.
Based on the approach and WASI portability patch from [YoWASP](https://github.com/YoWASP).

## Prerequisites

- [wasi-sdk](https://github.com/WebAssembly/wasi-sdk/releases) (tested with 30.0)
- CMake, Ninja
- Node.js (for bundling and sysroot creation)

Set the `WASI_SDK` environment variable to your wasi-sdk install path:

    export WASI_SDK=/path/to/wasi-sdk-30.0

## Clone

    git clone --recurse-submodules git@github.com:msorvig/wasi-sdk-custom.git

## Submodules

- `llvm` — LLVM/Clang source with WASI portability patch (msorvig/llvm-project-wasi, branch `wasi`)
- `nuscripten-core` — WASI runtime for loading and running .wasm binaries in the browser

## Build

    ./build.sh

This runs four steps:

1. Build LLVM/Clang for macOS (native host toolchain)
2. Cross-compile Clang/LLD to wasm32-wasi using wasi-sdk
3. Create sysroot bundle (C headers for in-browser use)
4. Bundle JS sources and assets into `dist/`

Individual steps can be run separately:

    ./configure_macos.sh && ninja -C clang-macos
    ./configure_wasi.sh && ninja -C clang-wasi clang
    ./create-sysroot-bundle.sh
    ./create-dist.sh

## Output

The `dist/` directory contains everything needed to run clang in the browser:

- `clang.js` — main API (ES module)
- `clang-worker.js` — web worker that runs LLVM tools
- `bin/llvm.wasm` — clang/lld compiled to WebAssembly
- `sysroot.bundle` — C headers (clang builtins + wasi-libc)
- `index.html` — example page

## Example

Open `dist/index.html` in a browser (requires a local server for ES module and worker support):

    cd dist && python3 -m http.server 8080

The example page lets you compile C and C++ source code to `.o` files and check the clang version,
all running in the browser.

## API

```js
import { createClang } from './clang.js';

const clang = createClang();
const result = await clang.run(args, files, runOptions);
clang.terminate();
```

### `createClang(options)`

Creates a worker pool that loads the wasm binary and sysroot in the background. Returns immediately.

- `options.wasmPath` — URL to `llvm.wasm` (default: `./bin/llvm.wasm` relative to `clang.js`)
- `options.sysrootPath` — URL to `sysroot.bundle` (default: `./sysroot.bundle`)
- `options.poolSize` — max concurrent workers (default: `navigator.hardwareConcurrency`)

### `clang.run(args, files, runOptions)`

Runs an LLVM tool. Waits for initialization if needed.

- `args` — command line as an array, e.g. `['clang', '-c', 'hello.c', '-o', 'hello.o']`
- `files` — input files as `{ path: content }` where content is a string or Uint8Array.
  These are placed in an in-memory filesystem visible to the tool.
- `runOptions.onStdout(line)` — callback for each stdout line
- `runOptions.onStderr(line)` — callback for each stderr line

Returns a result object:

- `result.exitCode` — process exit code (0 = success)
- `result.files` — output files as `{ path: Uint8Array }`. Output files are
  everything written by the tool, excluding sysroot files. For example,
  `result.files['hello.o']` contains the compiled object file.
- `result.stdout` — array of stdout lines
- `result.stderr` — array of stderr lines

### Convenience functions

```js
import { runClang, runClangPP, runLLVM } from './clang.js';

// Single-shot clang run (creates and terminates a worker automatically)
const result = await runClang(['-c', 'hello.c', '-o', 'hello.o'], { 'hello.c': src });

// Same for C++
const result = await runClangPP(['-c', 'hello.cpp', '-o', 'hello.o'], { 'hello.cpp': src });
```
