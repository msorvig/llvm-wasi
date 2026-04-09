// clang-worker.js - Web Worker that runs clang/LLVM tools using nuscripten-core runtime

import { createRuntimeComponents, MemoryFileSystem, ExitStatus } from '../nuscripten-core/runtime/loader.js';

let wasmModule = null;
let sysrootBundle = null;

self.onmessage = async (e) => {
    const { type, id, ...data } = e.data;
    try {
        switch (type) {
            case 'init':
                await handleInit(id, data);
                break;
            case 'init-from':
                handleInitFrom(id, data);
                break;
            case 'run':
                await handleRun(id, data);
                break;
        }
    } catch (err) {
        self.postMessage({ type: 'error', id, error: err.message });
    }
};

// First worker: fetch + compile module, fetch sysroot, return both to main thread
async function handleInit(id, { wasmUrl, sysrootUrl }) {
    const fetches = [fetch(wasmUrl)];
    if (sysrootUrl) {
        fetches.push(fetch(sysrootUrl));
    }

    const responses = await Promise.all(fetches);

    if (!responses[0].ok) {
        throw new Error(`Failed to fetch ${wasmUrl}: ${responses[0].status}`);
    }
    wasmModule = await WebAssembly.compileStreaming(responses[0]);

    if (responses[1]) {
        if (!responses[1].ok) {
            throw new Error(`Failed to fetch sysroot: ${responses[1].status}`);
        }
        sysrootBundle = new Uint8Array(await responses[1].arrayBuffer());
    }

    // Return compiled module + sysroot to main thread for sharing with other workers
    self.postMessage({ type: 'ready', id, module: wasmModule, sysroot: sysrootBundle });
}

// Additional workers: receive pre-compiled module + sysroot from main thread
function handleInitFrom(id, { module, sysroot }) {
    wasmModule = module;
    if (sysroot) {
        sysrootBundle = new Uint8Array(sysroot);
    }
    self.postMessage({ type: 'ready', id });
}

async function handleRun(id, { args, files }) {
    if (!wasmModule) {
        throw new Error('Module not initialized. Call init first.');
    }

    const fs = new MemoryFileSystem();

    if (sysrootBundle) {
        fs.loadBundle(sysrootBundle, '/usr');
    }

    for (const [path, content] of Object.entries(files)) {
        fs.addFile(path, content);
    }

    const stdoutLines = [];
    const stderrLines = [];

    const memory = new WebAssembly.Memory({
        initial: 4096,   // 256MB
        maximum: 65536,  // 4GB
    });

    const { imports, setInstance, startInstance } = createRuntimeComponents({
        memory,
        skipGL: true,
        args,
        fs,
        preopens: { '/': '/' },
        stdout: (line) => {
            stdoutLines.push(line);
            self.postMessage({ type: 'stdout', id, line });
        },
        stderr: (line) => {
            stderrLines.push(line);
            self.postMessage({ type: 'stderr', id, line });
        },
    });

    const instance = await WebAssembly.instantiate(wasmModule, imports);
    setInstance(instance);

    let exitCode = 0;
    try {
        await startInstance(instance);
    } catch (e) {
        if (e instanceof ExitStatus) {
            exitCode = e.code;
        } else if (e.name === 'ExitStatus') {
            exitCode = e.code;
        } else {
            exitCode = -1;
        }
    }

    const resultFiles = {};
    const transferables = [];
    for (const [path, content] of Object.entries(fs.getOutputFiles())) {
        if (path.startsWith('/usr/')) continue;
        const key = path.startsWith('/') ? path.slice(1) : path;
        if (key) {
            const copy = new Uint8Array(content);
            resultFiles[key] = copy;
            transferables.push(copy.buffer);
        }
    }

    self.postMessage({
        type: 'result',
        id,
        exitCode,
        files: resultFiles,
        stdout: stdoutLines,
        stderr: stderrLines,
    }, transferables);
}
