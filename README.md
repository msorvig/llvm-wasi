
# llvm-wasi

Clang/LLVM compiled to WebAssembly (wasm32-wasi), for running clang and lld in the browser.
Based on the approach and WASI portability patch from [YoWASP](https://github.com/YoWASP).

## Prerequisites

- [wasi-sdk](https://github.com/WebAssembly/wasi-sdk/releases) (tested with 30.0)
- CMake, Ninja
- Node.js (for bundling and sysroot creation)
- nuscripten-core (WASI runtime)
- macOS host (hardcoded for now; any host can work)

## Clone

    git clone --recurse-submodules git@github.com:msorvig/wasi-sdk-custom.git

## Submodules

- `llvm` — LLVM/Clang source with WASI portability patch (msorvig/llvm-project-wasi, branch `wasi`)
- `nuscripten-core` — WASI runtime for loading and running .wasm binaries in the browser

## Build

Set the `WASI_SDK` environment variable to your wasi-sdk install path:

    export WASI_SDK=/path/to/wasi-sdk-30.0

    ./build.sh

This runs four steps:

1. Build LLVM/Clang for macOS (native host toolchain)
2. Cross-compile Clang/LLD to wasm32-wasi using wasi-sdk
3. Create sysroot bundle (headers + libraries for in-browser use)
4. Bundle JS sources and assets into `dist/`

Individual steps can be run separately:

    ./configure_macos.sh && ninja -C clang-macos
    ./configure_wasi.sh && ninja -C clang-wasi clang
    ./create-sysroot-bundle.sh
    ./create-dist.sh

## Output

The `dist/` directory contains everything needed to run clang in the browser:

- `llvm.js` — main API (ES module)
- `llvm-worker.js` — web worker that runs LLVM tools
- `llvm.wasm` — clang + lld compiled to WebAssembly
- `sysroot.bundle.gz` — headers and static libraries (clang builtins, wasi-libc, libc++, compiler-rt)
- `index.html` — interactive playground
- `playground.js` — playground API (Playground class + runtime)

The `dist/` branch contains checked in versions of the files.

## Playground

Open `dist/index.html` in a browser (requires a local server for ES module and worker support):

    cd dist && python3 -m http.server 8080

The playground lets you compile, link, and run C and C++ programs entirely in the browser.
It includes examples for C (printf), C++ (std::print), and nuscripten (val.h JS interop).

## API

```js
import { createLlvm } from './llvm.js';

const llvm = createLlvm();
const result = await llvm.run(args, files, runOptions);
llvm.terminate();
```

### `createLlvm(options)`

Creates a worker pool that loads the wasm binary and sysroot in the background. Returns immediately.

- `options.wasmPath` — URL to `llvm.wasm` (default: `./llvm.wasm` relative to `llvm.js`)
- `options.sysrootPath` — URL to `sysroot.bundle.gz` (default: `./sysroot.bundle.gz`; plain `.bundle` also supported)
- `options.poolSize` — max concurrent workers (default: `navigator.hardwareConcurrency`)

### `clang.run(args, files, runOptions)`

Runs an LLVM tool. Waits for initialization if needed.

- `args` — command line as an array, e.g. `['clang', '-c', 'hello.c', '-o', 'hello.o']`.
  The first element selects the tool: `clang`, `clang++`, `wasm-ld`, `llvm-ar`, etc.
- `files` — input files as `{ path: content }` where content is a string or Uint8Array.
  These are placed in an in-memory filesystem visible to the tool.
- `runOptions.onStdout(line)` — callback for each stdout line
- `runOptions.onStderr(line)` — callback for each stderr line

Returns a result object:

- `result.exitCode` — process exit code (0 = success)
- `result.files` — output files as `{ path: Uint8Array }`. Output files are
  everything written by the tool, excluding sysroot files.
- `result.stdout` — array of stdout lines
- `result.stderr` — array of stderr lines

Examples:

```js
const llvm = createLlvm();

// Compile C to object file
const src = `#include <stdio.h>\nint main() { printf("hello\\n"); }`;
const compile = await llvm.run(
    ['clang', '--target=wasm32-wasip1', '-c', 'main.c', '-o', 'main.o'],
    { 'main.c': src }
);

// Link object file to wasm binary
const link = await llvm.run(
    ['wasm-ld', 'main.o', '-o', 'main.wasm', '--no-entry', '--export-all'],
    { 'main.o': compile.files['main.o'] }
);

const wasmBinary = link.files['main.wasm'];
```

### Convenience functions

```js
import { runClang, runClangPP, runWasmLd, runLLVM } from './llvm.js';

// Single-shot clang run
const result = await runClang(['-c', 'hello.c', '-o', 'hello.o'], { 'hello.c': src });

// C++
const result = await runClangPP(['-c', 'hello.cpp', '-o', 'hello.o'], { 'hello.cpp': src });

// Link
const result = await runWasmLd(['main.o', '-o', 'main.wasm', ...], { 'main.o': objectFile });

// Any LLVM tool
const result = await runLLVM(['llvm-ar', 'rcs', 'lib.a', 'a.o'], { 'a.o': objectFile });
```

### Playground class

```js
import { Playground } from './playground.js';

const pg = new Playground({
    onStdout: (line) => console.log(line),
    onStderr: (line) => console.error(line),
    onStatus: (text, type) => { /* 'Compiling...', 'Linking...', etc. */ },
});

const version = await pg.getVersion();  // "clang version 23.0.0git"
const result = await pg.run('c', source);   // compile + link + run
const result = await pg.run('cpp', source); // compile + link + run (C++)
```
