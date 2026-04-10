// clang.js - Async API for running clang/LLVM tools via a worker pool
//
// Usage:
//   // Non-blocking — starts fetching immediately while user interacts with UI
//   const clang = createLlvm();
//   // run() waits for initialization to complete if needed, then dispatches:
//   const [r1, r2] = await Promise.all([
//       clang.run(['clang', '-c', 'a.c', '-o', 'a.o', '--target=wasm32-wasip1'], { 'a.c': src1 }),
//       clang.run(['clang', '-c', 'b.c', '-o', 'b.o', '--target=wasm32-wasip1'], { 'b.c': src2 }),
//   ]);
//   clang.terminate();

const LLVM_WASM_PATH = './llvm.wasm';
const SYSROOT_BUNDLE_PATH = './sysroot.bundle.gz';

// Create a clang pool. Returns immediately (non-blocking).
// Fetching + compilation happens in the background on a worker.
// run() calls wait until initialization is complete, then dispatch.
//
// Options:
//   wasmPath: URL to the llvm wasm binary (default: ../clang-wasi/bin/llvm.wasm)
//   sysrootPath: URL to sysroot bundle (default: ../clang-wasi/sysroot.bundle)
//   poolSize: max concurrent workers (default: navigator.hardwareConcurrency or 4)
export function createLlvm(options = {}) {
    const wasmUrl = new URL(options.wasmPath || LLVM_WASM_PATH, import.meta.url).href;
    const sysrootUrl = new URL(options.sysrootPath || SYSROOT_BUNDLE_PATH, import.meta.url).href;
    const poolSize = options.poolSize || navigator.hardwareConcurrency || 4;
    const workerUrl = new URL('./llvm-worker.js', import.meta.url);

    // Shared state set by the init worker
    let module = null;
    let sysroot = null;

    // The first worker fetches + compiles; its ready promise gates everything
    const initWorker = createWorkerWrapper();
    const initReady = initWorker.init(wasmUrl, sysrootUrl);

    // Pool state
    const workers = [initWorker];
    const idle = [];
    const waiting = [];

    function createWorkerWrapper() {
        const w = new Worker(workerUrl, { type: 'module' });
        let nextId = 0;
        const pending = new Map();

        w.onmessage = (e) => {
            const { type, id, ...data } = e.data;
            const handler = pending.get(id);
            if (!handler) return;
            if (type === 'stdout') { handler.onStdout?.(data.line); return; }
            if (type === 'stderr') { handler.onStderr?.(data.line); return; }
            pending.delete(id);
            if (type === 'error') handler.reject(new Error(data.error));
            else handler.resolve(data);
        };

        w.onerror = (e) => {
            const error = new Error(e.message || 'Worker error');
            for (const h of pending.values()) h.reject(error);
            pending.clear();
        };

        function send(msg, callbacks = {}) {
            return new Promise((resolve, reject) => {
                const id = nextId++;
                pending.set(id, { resolve, reject, ...callbacks });
                w.postMessage({ ...msg, id });
            });
        }

        return {
            // Init worker: fetch URLs, compile module, return both
            init(wasmUrl, sysrootUrl) {
                return send({ type: 'init', wasmUrl, sysrootUrl });
            },
            // Additional workers: receive pre-compiled module + sysroot
            initFrom(module, sysroot) {
                return send({ type: 'init-from', module, sysroot });
            },
            run(args, files, runOptions = {}) {
                return send({ type: 'run', args, files }, {
                    onStdout: runOptions.onStdout,
                    onStderr: runOptions.onStderr,
                });
            },
            terminate() { w.terminate(); },
        };
    }

    async function ensureReady() {
        if (!module) {
            const result = await initReady;
            module = result.module;
            sysroot = result.sysroot;
            // Init worker is now idle
            idle.push(0);
        }
    }

    async function acquireWorker() {
        await ensureReady();
        if (idle.length > 0) {
            return idle.pop();
        }
        if (workers.length < poolSize) {
            const wrapper = createWorkerWrapper();
            const idx = workers.length;
            workers.push(wrapper);
            await wrapper.initFrom(module, sysroot);
            return idx;
        }
        return new Promise(resolve => waiting.push(resolve));
    }

    function releaseWorker(idx) {
        if (waiting.length > 0) {
            waiting.shift()(idx);
        } else {
            idle.push(idx);
        }
    }

    return {
        // Resolves when fetch + compile is done. Optional — run() waits automatically.
        get ready() { return ensureReady(); },

        // Run an LLVM tool. Waits for init if needed, then dispatches to a pool worker.
        async run(args, files = {}, runOptions = {}) {
            const idx = await acquireWorker();
            try {
                const result = await workers[idx].run(args, files, runOptions);
                return {
                    exitCode: result.exitCode,
                    files: result.files || {},
                    stdout: result.stdout || [],
                    stderr: result.stderr || [],
                };
            } finally {
                releaseWorker(idx);
            }
        },

        get workerCount() { return workers.length; },

        terminate() {
            for (const w of workers) w.terminate();
            workers.length = 0;
            idle.length = 0;
            for (const w of waiting) w(-1);
            waiting.length = 0;
        },
    };
}

// Convenience: run clang once
export async function runClang(args, files = {}, options = {}) {
    const clang = createLlvm({ ...options, poolSize: 1 });
    try {
        return await clang.run(['clang', ...args], files, options);
    } finally {
        clang.terminate();
    }
}

// Convenience: run clang++ once
export async function runClangPP(args, files = {}, options = {}) {
    const clang = createLlvm({ ...options, poolSize: 1 });
    try {
        return await clang.run(['clang++', ...args], files, options);
    } finally {
        clang.terminate();
    }
}

// Convenience: run wasm-ld once
export async function runWasmLd(args, files = {}, options = {}) {
    const clang = createLlvm({ ...options, poolSize: 1 });
    try {
        return await clang.run(['wasm-ld', ...args], files, options);
    } finally {
        clang.terminate();
    }
}

// Convenience: run any LLVM tool once
export async function runLLVM(args, files = {}, options = {}) {
    const clang = createLlvm({ ...options, poolSize: 1 });
    try {
        return await clang.run(args, files, options);
    } finally {
        clang.terminate();
    }
}
