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
function createLlvm(options = {}) {
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

// val.js - Emscripten-compatible val API for JS interop
//
// Handle allocation and ref counting are on the C++ side.
// JS just stores/retrieves objects by handle index.

// Check for JSPI support
const hasJSPI$2 = typeof WebAssembly.Suspending !== 'undefined' &&
                typeof WebAssembly.promising !== 'undefined';

// Create val component for WebAssembly
// Returns { imports, setInstance, getObject } - caller must call setInstance after instantiation
function createValComponent(memory, suspendController) {
    // Per-instance object store. Handles 0-4 are pre-populated.
    const objects = [undefined, null, true, false, globalThis];

    function getObject(handle) {
        return objects[handle];
    }

    let instance = null;
    const setInstance = (inst) => { instance = inst; };

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    function readString(ptr, len) {
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        return decoder.decode(bytes);
    }

    async function valAwait(dest, promiseHandle) {
        const promise = getObject(promiseHandle);
        suspendController.enterExclusive();
        try {
            const result = await promise;
            objects[dest] = result;
        } finally {
            const queued = suspendController.resume();
            // Drain queued events: replay each through the original dispatch path
            for (const entry of queued) {
                if (entry.isFunctor) {
                    instance.exports._val_dispatch_generic_functor(entry.callbackId, entry.args);
                } else {
                    instance.exports._val_dispatch_generic_callback(entry.callbackId, entry.args);
                }
            }
        }
    }

    const imports = {
        // Store externref at destination handle
        _val_from_externref(dest, ref) {
            objects[dest] = ref;
        },

        // Convert handle to externref
        _val_to_externref(handle) {
            return getObject(handle);
        },

        // Release object (C++ ref count reached zero)
        _val_release(handle) {
            objects[handle] = undefined;
        },

        // Get global object by name, store at dest
        _val_global(dest, namePtr, nameLen) {
            const name = readString(namePtr, nameLen);
            objects[dest] = globalThis[name];
        },

        // Get property of object, store at dest
        _val_get(dest, handle, namePtr, nameLen) {
            const obj = getObject(handle);
            const name = readString(namePtr, nameLen);
            objects[dest] = obj[name];
        },

        // Set property of object (value is a handle)
        _val_set(handle, namePtr, nameLen, valueHandle) {
            const obj = getObject(handle);
            const name = readString(namePtr, nameLen);
            obj[name] = getObject(valueHandle);
        },

        // Set property to a string value
        _val_set_string(handle, namePtr, nameLen, valuePtr, valueLen) {
            const obj = getObject(handle);
            const name = readString(namePtr, nameLen);
            obj[name] = readString(valuePtr, valueLen);
        },

        // Set property to an int value
        _val_set_int(handle, namePtr, nameLen, value) {
            const obj = getObject(handle);
            const name = readString(namePtr, nameLen);
            obj[name] = value;
        },

        // Call method, store result at dest
        _val_call_args(dest, handle, namePtr, nameLen, argArrayPtr, argCount) {
            const obj = getObject(handle);
            const name = readString(namePtr, nameLen);
            if (argCount > 0) {
                const argHandles = new Int32Array(memory.buffer, argArrayPtr, argCount);
                const args = Array.from(argHandles).map(h => getObject(h));
                objects[dest] = obj[name](...args);
            } else {
                objects[dest] = obj[name]();
            }
        },

        // Create a string val from C++ string
        _val_new_string(dest, ptr, len) {
            objects[dest] = readString(ptr, len);
        },

        // Store int value
        _val_new_int(dest, value) {
            objects[dest] = value;
        },

        // Store double value
        _val_new_double(dest, value) {
            objects[dest] = value;
        },

        // Call constructor: new Constructor(...args)
        _val_new(dest, constructorHandle, argArrayPtr, argCount) {
            const Constructor = getObject(constructorHandle);
            if (argCount > 0) {
                const argHandles = new Int32Array(memory.buffer, argArrayPtr, argCount);
                const args = Array.from(argHandles).map(h => getObject(h));
                objects[dest] = new Constructor(...args);
            } else {
                objects[dest] = new Constructor();
            }
        },

        // Create JS function from callback ID
        _val_function(dest, callbackId) {
            objects[dest] = (...args) => {
                const entry = { callbackId, args, isFunctor: false };
                suspendController.gate(
                    () => instance.exports._val_dispatch_generic_callback(callbackId, args),
                    entry,
                );
            };
        },

        // Create JS function from functor ID
        _val_functor(dest, functorId) {
            objects[dest] = (...args) => {
                const entry = { callbackId: functorId, args, isFunctor: true };
                suspendController.gate(
                    () => instance.exports._val_dispatch_generic_functor(functorId, args),
                    entry,
                );
            };
        },

        // Await a Promise (wrapped with JSPI if available)
        _val_await: hasJSPI$2 ? new WebAssembly.Suspending(valAwait) : valAwait,

        // Process events: suspend until at least one event is queued (JSPI)
        _val_process_events: hasJSPI$2
            ? new WebAssembly.Suspending(async () => { await suspendController.enterReady(); })
            : () => { throw new Error('processEvents requires JSPI'); },

        // Drain event queue: dispatch all queued events synchronously
        _val_drain_event_queue() {
            const queued = suspendController.resume();
            for (const entry of queued) {
                if (entry.isFunctor) {
                    instance.exports._val_dispatch_generic_functor(entry.callbackId, entry.args);
                } else {
                    instance.exports._val_dispatch_generic_callback(entry.callbackId, entry.args);
                }
            }
        },

        // Log to console
        _val_log(handle) {
            console.log(getObject(handle));
        },

        // Get string representation, write to buffer, return length
        _val_to_string(handle, bufPtr, bufLen) {
            const str = String(getObject(handle));
            const bytes = encoder.encode(str);
            const len = Math.min(bytes.length, bufLen);
            new Uint8Array(memory.buffer, bufPtr, len).set(bytes.subarray(0, len));
            return bytes.length;
        },

        // Get wasm instance handle
        _val_instance(dest) {
            objects[dest] = instance;
        },

        // Get number value
        _val_as_double(handle) {
            return Number(getObject(handle));
        },

        _val_as_int(handle) {
            return getObject(handle) | 0;
        },

        // Get wasm memory object
        _val_memory(dest) {
            objects[dest] = memory;
        },

        // Create Uint8Array view into wasm memory
        _val_typed_array(dest, ptr, len) {
            objects[dest] = new Uint8Array(memory.buffer, ptr, len);
        },

        // Create Float32Array view into wasm memory
        _val_float32_array(dest, ptr, count) {
            objects[dest] = new Float32Array(memory.buffer, ptr, count);
        },

        // Copy from JS ArrayBuffer/TypedArray to wasm memory
        _val_copy_to_memory(sourceHandle, destPtr, len) {
            const source = getObject(sourceHandle);
            const dest = new Uint8Array(memory.buffer, destPtr, len);
            if (source instanceof ArrayBuffer) {
                dest.set(new Uint8Array(source, 0, len));
            } else {
                dest.set(new Uint8Array(source.buffer, source.byteOffset, len));
            }
        },

        // Get byteLength of ArrayBuffer/TypedArray
        _val_byte_length(handle) {
            return getObject(handle).byteLength;
        },

        // Property access by val key (no string encoding)
        _val_get_v(dest, obj_handle, key_handle) {
            objects[dest] = getObject(obj_handle)[getObject(key_handle)];
        },

        // Fused property access + type conversion (single JS call)
        _val_get_double_v(obj_handle, key_handle) {
            return Number(getObject(obj_handle)[getObject(key_handle)]);
        },

        _val_get_int_v(obj_handle, key_handle) {
            return getObject(obj_handle)[getObject(key_handle)] | 0;
        },

        // Externref-based fused getters (obj and key are externrefs, not handles)
        _val_get_double_ext(obj, key) {
            return Number(obj[key]);
        },

        _val_get_int_ext(obj, key) {
            return obj[key] | 0;
        }
    };

    return { imports, setInstance, getObject };
}

// val_table.js - Externref-based val backend
//
// All imports take/return externref. JS never accesses the wasm table.
// C++ handles table load/store via builtins, passes externrefs to these imports.

// Check for JSPI support
const hasJSPI$1 = typeof WebAssembly.Suspending !== 'undefined' &&
                typeof WebAssembly.promising !== 'undefined';

// Create val table component for WebAssembly
// Returns { imports, setInstance, getObject }
function createValTableComponent(memory, suspendController) {
    let instance = null;

    const setInstance = (inst) => {
        instance = inst;
        // C++ grows table and pre-populates handles 0-4 via builtins
        inst.exports._val_table_init();
    };

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    function readString(ptr, len) {
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        return decoder.decode(bytes);
    }

    async function valAwait(promise) {
        suspendController.enterExclusive();
        try {
            return await promise;
        } finally {
            const queued = suspendController.resume();
            // Drain queued events: replay each through the original dispatch path
            for (const entry of queued) {
                if (entry.isFunctor) {
                    instance.exports._val_dispatch_generic_functor(entry.callbackId, entry.args);
                } else {
                    instance.exports._val_dispatch_generic_callback(entry.callbackId, entry.args);
                }
            }
        }
    }

    const imports = {
        // Init helpers: return values for pre-populated handles
        _val_null_ref() { return null; },
        _val_true_ref() { return true; },
        _val_false_ref() { return false; },
        _val_global_this_ref() { return globalThis; },

        // Get global by name → externref
        _val_global(namePtr, nameLen) {
            return globalThis[readString(namePtr, nameLen)];
        },

        // Get property → externref
        _val_get(obj, namePtr, nameLen) {
            return obj[readString(namePtr, nameLen)];
        },

        // Set property (externref value)
        _val_set(obj, namePtr, nameLen, value) {
            obj[readString(namePtr, nameLen)] = value;
        },

        // Set property (string value from wasm memory)
        _val_set_string(obj, namePtr, nameLen, valuePtr, valueLen) {
            obj[readString(namePtr, nameLen)] = readString(valuePtr, valueLen);
        },

        // Set property (int value)
        _val_set_int(obj, namePtr, nameLen, value) {
            obj[readString(namePtr, nameLen)] = value;
        },

        // Fixed-arity method calls → externref
        _val_call0(obj, namePtr, nameLen) {
            return obj[readString(namePtr, nameLen)]();
        },

        _val_call1(obj, namePtr, nameLen, a0) {
            return obj[readString(namePtr, nameLen)](a0);
        },

        _val_call2(obj, namePtr, nameLen, a0, a1) {
            return obj[readString(namePtr, nameLen)](a0, a1);
        },

        _val_call3(obj, namePtr, nameLen, a0, a1, a2) {
            return obj[readString(namePtr, nameLen)](a0, a1, a2);
        },

        _val_call4(obj, namePtr, nameLen, a0, a1, a2, a3) {
            return obj[readString(namePtr, nameLen)](a0, a1, a2, a3);
        },

        _val_call5(obj, namePtr, nameLen, a0, a1, a2, a3, a4) {
            return obj[readString(namePtr, nameLen)](a0, a1, a2, a3, a4);
        },

        // Value constructors → externref
        _val_new_int(value) { return value; },
        _val_new_double(value) { return value; },
        _val_new_string(ptr, len) { return readString(ptr, len); },

        // Fixed-arity new → externref
        _val_new0(ctor) { return new ctor(); },
        _val_new1(ctor, a0) { return new ctor(a0); },
        _val_new2(ctor, a0, a1) { return new ctor(a0, a1); },
        _val_new3(ctor, a0, a1, a2) { return new ctor(a0, a1, a2); },
        _val_new4(ctor, a0, a1, a2, a3) { return new ctor(a0, a1, a2, a3); },
        _val_new5(ctor, a0, a1, a2, a3, a4) { return new ctor(a0, a1, a2, a3, a4); },

        // Function/functor creation → externref
        _val_function(callbackId) {
            return (...args) => {
                const entry = { callbackId, args, isFunctor: false };
                suspendController.gate(
                    () => instance.exports._val_dispatch_generic_callback(callbackId, args),
                    entry,
                );
            };
        },

        _val_functor(functorId) {
            return (...args) => {
                const entry = { callbackId: functorId, args, isFunctor: true };
                suspendController.gate(
                    () => instance.exports._val_dispatch_generic_functor(functorId, args),
                    entry,
                );
            };
        },

        // Await: externref promise → externref result
        _val_await: hasJSPI$1 ? new WebAssembly.Suspending(valAwait) : valAwait,

        // Process events: suspend until at least one event is queued (JSPI)
        _val_process_events: hasJSPI$1
            ? new WebAssembly.Suspending(async () => { await suspendController.enterReady(); })
            : () => { throw new Error('processEvents requires JSPI'); },

        // Drain event queue: dispatch all queued events synchronously
        _val_drain_event_queue() {
            const queued = suspendController.resume();
            for (const entry of queued) {
                if (entry.isFunctor) {
                    instance.exports._val_dispatch_generic_functor(entry.callbackId, entry.args);
                } else {
                    instance.exports._val_dispatch_generic_callback(entry.callbackId, entry.args);
                }
            }
        },

        // Log
        _val_log(obj) { console.log(obj); },

        // String conversion
        _val_to_string(obj, bufPtr, bufLen) {
            const str = String(obj);
            const bytes = encoder.encode(str);
            const len = Math.min(bytes.length, bufLen);
            new Uint8Array(memory.buffer, bufPtr, len).set(bytes.subarray(0, len));
            return bytes.length;
        },

        // Type conversion
        _val_as_double(obj) { return Number(obj); },
        _val_as_int(obj) { return obj | 0; },

        // Instance / memory → externref
        _val_instance() { return instance; },
        _val_memory() { return memory; },

        // Typed arrays → externref
        _val_typed_array(ptr, len) {
            return new Uint8Array(memory.buffer, ptr, len);
        },

        _val_float32_array(ptr, count) {
            return new Float32Array(memory.buffer, ptr, count);
        },

        // Memory operations
        _val_copy_to_memory(source, destPtr, len) {
            const dest = new Uint8Array(memory.buffer, destPtr, len);
            if (source instanceof ArrayBuffer) {
                dest.set(new Uint8Array(source, 0, len));
            } else {
                dest.set(new Uint8Array(source.buffer, source.byteOffset, len));
            }
        },

        _val_byte_length(obj) { return obj.byteLength; },

        // Val-key property access → externref
        _val_get_v(obj, key) { return obj[key]; },

        // Fused property access + type conversion
        _val_get_double_v(obj, key) { return Number(obj[key]); },
        _val_get_int_v(obj, key) { return obj[key] | 0; }
    };

    // getObject not available in table backend (table is internal to wasm)
    function getObject(handle) {
        throw new Error('getObject not supported in table backend');
    }

    return { imports, setInstance, getObject };
}

// filesystem.js - In-memory filesystem for WASI

const WASI_ERRNO = {
    SUCCESS: 0,
    BADF: 8,
    EXIST: 20,
    NOENT: 44,
    NOSYS: 52,
    SPIPE: 70,
};

const WASI_FILETYPE = {
    CHARACTER_DEVICE: 2,
    DIRECTORY: 3,
    REGULAR_FILE: 4};

const WASI_RIGHTS = {
    FD_DATASYNC: 1n << 0n,
    FD_READ: 1n << 1n,
    FD_SEEK: 1n << 2n,
    FD_FDSTAT_SET_FLAGS: 1n << 3n,
    FD_SYNC: 1n << 4n,
    FD_TELL: 1n << 5n,
    FD_WRITE: 1n << 6n,
    FD_ADVISE: 1n << 7n,
    FD_ALLOCATE: 1n << 8n,
    PATH_CREATE_DIRECTORY: 1n << 9n,
    PATH_CREATE_FILE: 1n << 10n,
    PATH_LINK_SOURCE: 1n << 11n,
    PATH_LINK_TARGET: 1n << 12n,
    PATH_OPEN: 1n << 13n,
    FD_READDIR: 1n << 14n,
    PATH_READLINK: 1n << 15n,
    PATH_RENAME_SOURCE: 1n << 16n,
    PATH_RENAME_TARGET: 1n << 17n,
    PATH_FILESTAT_GET: 1n << 18n,
    PATH_FILESTAT_SET_SIZE: 1n << 19n,
    PATH_FILESTAT_SET_TIMES: 1n << 20n,
    FD_FILESTAT_GET: 1n << 21n,
    FD_FILESTAT_SET_SIZE: 1n << 22n,
    FD_FILESTAT_SET_TIMES: 1n << 23n,
    PATH_SYMLINK: 1n << 24n,
    PATH_REMOVE_DIRECTORY: 1n << 25n,
    PATH_UNLINK_FILE: 1n << 26n,
    POLL_FD_READWRITE: 1n << 27n,
    SOCK_SHUTDOWN: 1n << 28n,
};

const ALL_RIGHTS = Object.values(WASI_RIGHTS).reduce((a, b) => a | b, 0n);

class MemoryFileSystem {
    constructor(options = {}) {
        this.files = options.files || {}; // { path: Uint8Array | string }

        // File descriptor table (0-2 reserved for stdio)
        this.fds = new Map();
        this.nextFd = 3;

        // Inode counter for unique inode numbers
        this._nextIno = 1;
        this._inodeMap = new Map(); // path → inode

        // Persistent storage key (set via setStateName)
        this.stateName = null;

        // Text encoder/decoder
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
    }

    // Get a stable unique inode number for a path
    _inode(path) {
        let ino = this._inodeMap.get(path);
        if (ino === undefined) {
            ino = this._nextIno++;
            this._inodeMap.set(path, ino);
        }
        return ino;
    }

    // Set localStorage key for persistence
    setStateName(name) {
        this.stateName = name;
    }

    // Add or update a file
    addFile(path, content) {
        if (typeof content === 'string') {
            content = this.encoder.encode(content);
        }
        this.files[path] = content;
    }

    // Get file content
    getFile(path) {
        return this.files[path];
    }

    // Get all output files (files written during execution)
    getOutputFiles() {
        const result = {};
        for (const [path, content] of Object.entries(this.files)) {
            if (content instanceof Uint8Array) {
                result[path] = content;
            }
        }
        return result;
    }

    // Resolve a path relative to a preopened directory
    resolvePath(dirFd, path) {
        const dir = this.fds.get(dirFd);
        if (!dir || dir.type !== 'preopen') {
            return null;
        }
        let fullPath = path;
        if (!path.startsWith('/')) {
            fullPath = dir.path === '/' ? '/' + path : dir.path + '/' + path;
        }
        // Normalize: resolve . and .., collapse slashes
        const parts = fullPath.split('/');
        const resolved = [];
        for (const part of parts) {
            if (part === '' || part === '.') continue;
            if (part === '..') { resolved.pop(); continue; }
            resolved.push(part);
        }
        return '/' + resolved.join('/');
    }

    // Look up file content, trying with and without leading slash
    lookupFile(path) {
        let content = this.files[path];
        if (content === undefined) {
            const altPath = path.startsWith('/') ? path.slice(1) : '/' + path;
            content = this.files[altPath];
        }
        return content;
    }

    // File descriptor operations
    getFd(fd) {
        return this.fds.get(fd);
    }

    allocateFd(entry) {
        const fd = this.nextFd++;
        this.fds.set(fd, entry);
        return fd;
    }

    closeFd(fd) {
        if (fd < 3) return WASI_ERRNO.SUCCESS;
        if (!this.fds.has(fd)) return WASI_ERRNO.BADF;
        this.fds.delete(fd);
        return WASI_ERRNO.SUCCESS;
    }

    // Open a file
    // oflags: bit 0 = O_CREAT, bit 2 = O_EXCL, bit 3 = O_TRUNC
    openFile(dirFd, path, oflags) {
        const fullPath = this.resolvePath(dirFd, path);
        if (!fullPath) return { errno: WASI_ERRNO.BADF };

        const creat = oflags & 1;
        const excl = oflags & 4;
        const trunc = oflags & 8;

        let content = this.lookupFile(fullPath);
        if (content === undefined) {
            if (creat) {
                content = new Uint8Array(0);
                this.files[fullPath] = content;
            } else {
                return { errno: WASI_ERRNO.NOENT };
            }
        } else {
            if (creat && excl) {
                return { errno: WASI_ERRNO.EXIST };
            }
            if (trunc) {
                content = new Uint8Array(0);
                this.files[fullPath] = content;
            }
        }

        // Convert string content to Uint8Array
        if (typeof content === 'string') {
            content = this.encoder.encode(content);
            this.files[fullPath] = content;
        }

        const fd = this.allocateFd({
            type: 'file',
            path: fullPath,
            content: content,
            offset: 0,
        });

        return { errno: WASI_ERRNO.SUCCESS, fd };
    }

    // Read from file
    read(fd, length) {
        const fdEntry = this.fds.get(fd);
        if (!fdEntry) return { errno: WASI_ERRNO.BADF, data: null };

        if (fdEntry.type !== 'file') {
            return { errno: WASI_ERRNO.BADF, data: null };
        }

        const available = fdEntry.content.length - fdEntry.offset;
        const toRead = Math.min(length, available);
        const data = fdEntry.content.subarray(fdEntry.offset, fdEntry.offset + toRead);
        fdEntry.offset += toRead;

        return { errno: WASI_ERRNO.SUCCESS, data };
    }

    // Read at specific offset (pread)
    pread(fd, length, offset) {
        const fdEntry = this.fds.get(fd);
        if (!fdEntry) return { errno: WASI_ERRNO.BADF, data: null };

        if (fdEntry.type !== 'file') {
            return { errno: WASI_ERRNO.BADF, data: null };
        }

        const available = fdEntry.content.length - offset;
        const toRead = Math.min(length, Math.max(0, available));
        const data = fdEntry.content.subarray(offset, offset + toRead);

        return { errno: WASI_ERRNO.SUCCESS, data };
    }

    // Write to file at current offset
    write(fd, data) {
        const fdEntry = this.fds.get(fd);
        if (!fdEntry) return { errno: WASI_ERRNO.BADF, written: 0 };

        if (fdEntry.type !== 'file') {
            return { errno: WASI_ERRNO.BADF, written: 0 };
        }

        const writeEnd = fdEntry.offset + data.length;
        if (writeEnd > fdEntry.content.length) {
            // Expand file to fit
            const newContent = new Uint8Array(writeEnd);
            newContent.set(fdEntry.content);
            fdEntry.content = newContent;
        }
        fdEntry.content.set(data, fdEntry.offset);
        fdEntry.offset = writeEnd;
        this.files[fdEntry.path] = fdEntry.content;

        return { errno: WASI_ERRNO.SUCCESS, written: data.length };
    }

    // Write at specific offset (pwrite)
    pwrite(fd, data, offset) {
        const fdEntry = this.fds.get(fd);
        if (!fdEntry || fdEntry.type !== 'file') {
            return { errno: WASI_ERRNO.BADF, written: 0 };
        }

        // Expand file if needed
        const neededSize = offset + data.length;
        if (neededSize > fdEntry.content.length) {
            const newContent = new Uint8Array(neededSize);
            newContent.set(fdEntry.content);
            fdEntry.content = newContent;
            this.files[fdEntry.path] = newContent;
        }

        fdEntry.content.set(data, offset);
        return { errno: WASI_ERRNO.SUCCESS, written: data.length };
    }

    // Seek in file
    seek(fd, offset, whence) {
        const fdEntry = this.fds.get(fd);
        if (!fdEntry) return { errno: WASI_ERRNO.BADF, offset: 0 };

        if (fdEntry.type !== 'file') {
            return { errno: WASI_ERRNO.SPIPE, offset: 0 };
        }

        switch (whence) {
            case 0: fdEntry.offset = Number(offset); break; // SEEK_SET
            case 1: fdEntry.offset += Number(offset); break; // SEEK_CUR
            case 2: fdEntry.offset = fdEntry.content.length + Number(offset); break; // SEEK_END
        }

        return { errno: WASI_ERRNO.SUCCESS, offset: fdEntry.offset };
    }

    // Tell current position
    tell(fd) {
        const fdEntry = this.fds.get(fd);
        if (!fdEntry) return { errno: WASI_ERRNO.BADF, offset: 0 };
        if (fdEntry.type !== 'file') return { errno: WASI_ERRNO.SPIPE, offset: 0 };
        return { errno: WASI_ERRNO.SUCCESS, offset: fdEntry.offset || 0 };
    }

    // Get file stat
    fileStat(fd) {
        const fdEntry = this.fds.get(fd);
        if (!fdEntry) return { errno: WASI_ERRNO.BADF };

        let filetype = WASI_FILETYPE.REGULAR_FILE;
        let size = 0;

        if (fdEntry.type === 'stdio') {
            filetype = WASI_FILETYPE.CHARACTER_DEVICE;
        } else if (fdEntry.type === 'preopen') {
            filetype = WASI_FILETYPE.DIRECTORY;
        } else if (fdEntry.type === 'file') {
            size = fdEntry.content.length;
        }

        return {
            errno: WASI_ERRNO.SUCCESS,
            filetype,
            size,
            nlink: 1,
            ino: this._inode(fdEntry.path || `fd:${fd}`),
        };
    }

    // Get path stat
    pathStat(dirFd, path) {
        const fullPath = this.resolvePath(dirFd, path);
        if (!fullPath) return { errno: WASI_ERRNO.BADF };

        // Check for file
        const content = this.lookupFile(fullPath);
        if (content !== undefined) {
            const size = typeof content === 'string'
                ? this.encoder.encode(content).length
                : content.length;
            return {
                errno: WASI_ERRNO.SUCCESS,
                filetype: WASI_FILETYPE.REGULAR_FILE,
                size,
                nlink: 1,
                ino: this._inode(fullPath),
            };
        }

        // Check if path is a directory (root, or has files under it)
        const dirPrefix = fullPath === '/' ? '/' : fullPath + '/';
        const isDir = fullPath === '/' || Object.keys(this.files).some(f => {
            const normalized = f.startsWith('/') ? f : '/' + f;
            return normalized.startsWith(dirPrefix);
        });
        if (isDir) {
            return {
                errno: WASI_ERRNO.SUCCESS,
                filetype: WASI_FILETYPE.DIRECTORY,
                size: 0,
                nlink: 1,
                ino: this._inode(fullPath),
            };
        }

        return { errno: WASI_ERRNO.NOENT };
    }

    // Set file size (truncate/extend)
    setFileSize(fd, size) {
        const fdEntry = this.fds.get(fd);
        if (!fdEntry || fdEntry.type !== 'file') {
            return WASI_ERRNO.BADF;
        }

        const newSize = Number(size);
        const newContent = new Uint8Array(newSize);
        const copyLen = Math.min(fdEntry.content.length, newSize);
        newContent.set(fdEntry.content.subarray(0, copyLen));

        fdEntry.content = newContent;
        this.files[fdEntry.path] = newContent;

        if (fdEntry.offset > newSize) {
            fdEntry.offset = newSize;
        }

        return WASI_ERRNO.SUCCESS;
    }

    // Allocate space in file
    allocate(fd, offset, len) {
        const fdEntry = this.fds.get(fd);
        if (!fdEntry || fdEntry.type !== 'file') {
            return WASI_ERRNO.BADF;
        }

        const neededSize = Number(offset) + Number(len);
        if (neededSize > fdEntry.content.length) {
            const newContent = new Uint8Array(neededSize);
            newContent.set(fdEntry.content);
            fdEntry.content = newContent;
            this.files[fdEntry.path] = newContent;
        }

        return WASI_ERRNO.SUCCESS;
    }

    // Unlink (delete) file
    unlink(dirFd, path) {
        const fullPath = this.resolvePath(dirFd, path);
        if (fullPath) {
            delete this.files[fullPath];
        }
        return WASI_ERRNO.SUCCESS;
    }

    // Rename file
    rename(oldDirFd, oldPath, newDirFd, newPath) {
        const oldFullPath = this.resolvePath(oldDirFd, oldPath);
        const newFullPath = this.resolvePath(newDirFd, newPath);

        if (oldFullPath && newFullPath && this.files[oldFullPath]) {
            this.files[newFullPath] = this.files[oldFullPath];
            delete this.files[oldFullPath];
        }
        return WASI_ERRNO.SUCCESS;
    }

    // Save filesystem state to persistent storage (localStorage)
    // Uses stateName if no key provided
    // Returns true on success
    saveState(key = this.stateName) {
        if (!key) return false;
        try {
            const serialized = {};
            for (const [path, content] of Object.entries(this.files)) {
                if (content instanceof Uint8Array) {
                    // Convert Uint8Array to base64
                    let binary = '';
                    for (let i = 0; i < content.length; i++) {
                        binary += String.fromCharCode(content[i]);
                    }
                    serialized[path] = { type: 'binary', data: btoa(binary) };
                } else if (typeof content === 'string') {
                    serialized[path] = { type: 'string', data: content };
                }
            }
            localStorage.setItem(key, JSON.stringify(serialized));
            return true;
        } catch (e) {
            console.warn('MemoryFileSystem.saveState failed:', e);
            return false;
        }
    }

    // Restore filesystem state from persistent storage (localStorage)
    // Uses stateName if no key provided
    // Returns true if state was found and restored
    restoreState(key = this.stateName) {
        if (!key) return false;
        try {
            const json = localStorage.getItem(key);
            if (!json) return false;

            const serialized = JSON.parse(json);
            for (const [path, entry] of Object.entries(serialized)) {
                if (entry.type === 'binary') {
                    // Convert base64 back to Uint8Array
                    const binary = atob(entry.data);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) {
                        bytes[i] = binary.charCodeAt(i);
                    }
                    this.files[path] = bytes;
                } else if (entry.type === 'string') {
                    this.files[path] = entry.data;
                }
            }
            return true;
        } catch (e) {
            console.warn('MemoryFileSystem.restoreState failed:', e);
            return false;
        }
    }

    // Clear saved state from persistent storage
    // Uses stateName if no key provided
    clearState(key = this.stateName) {
        if (!key) return false;
        try {
            localStorage.removeItem(key);
            return true;
        } catch (e) {
            return false;
        }
    }

    // Load a bundle into the filesystem.
    // data: Uint8Array or ArrayBuffer (bundle created by createBundle)
    // prefix: path prefix to prepend to all files (e.g. '/usr/include')
    // Returns number of files loaded.
    loadBundle(data, prefix = '') {
        if (data instanceof ArrayBuffer) data = new Uint8Array(data);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const decoder = new TextDecoder();

        // Check magic "FSBD"
        if (data[0] !== 0x46 || data[1] !== 0x53 || data[2] !== 0x42 || data[3] !== 0x44) {
            throw new Error('Invalid bundle: bad magic');
        }

        let offset = 4;
        const version = view.getUint32(offset, true);
        offset += 4;
        if (version !== 1) throw new Error(`Unsupported bundle version: ${version}`);

        const fileCount = view.getUint32(offset, true);
        offset += 4;

        // Normalize prefix: ensure it starts with / and doesn't end with /
        if (prefix && !prefix.startsWith('/')) prefix = '/' + prefix;
        if (prefix.endsWith('/')) prefix = prefix.slice(0, -1);

        for (let i = 0; i < fileCount; i++) {
            const pathLen = view.getUint32(offset, true);
            offset += 4;
            const path = decoder.decode(data.subarray(offset, offset + pathLen));
            offset += pathLen;
            const contentLen = view.getUint32(offset, true);
            offset += 4;
            const content = data.slice(offset, offset + contentLen);
            offset += contentLen;

            const fullPath = prefix ? prefix + '/' + path : '/' + path;
            this.files[fullPath] = content;
        }

        return fileCount;
    }

    // Create a bundle from a { path: Uint8Array } object.
    // Returns Uint8Array.
    static createBundle(files) {
        const encoder = new TextEncoder();
        const entries = Object.entries(files);

        // Calculate total size: header (12) + per-file (4 + pathBytes + 4 + content)
        let totalSize = 12;
        const encodedEntries = [];
        for (const [path, content] of entries) {
            const pathBytes = encoder.encode(path);
            const contentBytes = content instanceof Uint8Array ? content : encoder.encode(content);
            totalSize += 4 + pathBytes.length + 4 + contentBytes.length;
            encodedEntries.push({ pathBytes, contentBytes });
        }

        const buffer = new ArrayBuffer(totalSize);
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);
        let offset = 0;

        // Magic "FSBD"
        bytes[0] = 0x46; bytes[1] = 0x53; bytes[2] = 0x42; bytes[3] = 0x44;
        offset = 4;
        view.setUint32(offset, 1, true); // version
        offset += 4;
        view.setUint32(offset, encodedEntries.length, true);
        offset += 4;

        for (const { pathBytes, contentBytes } of encodedEntries) {
            view.setUint32(offset, pathBytes.length, true);
            offset += 4;
            bytes.set(pathBytes, offset);
            offset += pathBytes.length;
            view.setUint32(offset, contentBytes.length, true);
            offset += 4;
            bytes.set(contentBytes, offset);
            offset += contentBytes.length;
        }

        return new Uint8Array(buffer);
    }
}

// CLI: node filesystem.js create-bundle <dir> <output> [--prefix <prefix>]
// Creates a bundle file from all files in <dir>.
// Paths in the bundle are relative to <dir>.
if (typeof process !== 'undefined' && process.argv[1]) {
    const { fileURLToPath } = await import('url');
    const thisFile = fileURLToPath(import.meta.url);
    if (process.argv[1] === thisFile) {
        const fs = await import('fs');
        const path = await import('path');

        const args = process.argv.slice(2);
        if (args[0] === 'create-bundle' && args.length >= 3) {
            const sourceDir = path.resolve(args[1]);
            const outputFile = path.resolve(args[2]);

            // Collect all files recursively
            const files = {};
            function walk(dir, rel) {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fullPath = path.join(dir, entry.name);
                    const relPath = rel ? rel + '/' + entry.name : entry.name;
                    if (entry.isDirectory()) {
                        walk(fullPath, relPath);
                    } else if (entry.isFile()) {
                        files[relPath] = fs.readFileSync(fullPath);
                    }
                }
            }
            walk(sourceDir, '');

            const bundle = MemoryFileSystem.createBundle(files);
            fs.writeFileSync(outputFile, bundle);
            console.log(`Bundle: ${Object.keys(files).length} files, ${bundle.length} bytes → ${outputFile}`);
        } else {
            console.log('Usage: node filesystem.js create-bundle <directory> <output-file>');
            process.exit(1);
        }
    }
}

// wasi.js - WASI implementation for browser


// Validate imports
if (typeof MemoryFileSystem !== 'function') {
    throw new Error('Failed to import MemoryFileSystem from filesystem.js');
}

// Rights for stdio (no seek/tell - this makes isatty() return true)
const STDIO_RIGHTS = ALL_RIGHTS & ~WASI_RIGHTS.FD_SEEK & ~WASI_RIGHTS.FD_TELL;

// Exit status - thrown by proc_exit, can be caught to get exit code
class ExitStatus extends Error {
    constructor(code) {
        super(`Process exited with code ${code}`);
        this.name = 'ExitStatus';
        this.code = code;
    }
}

// Create WASI component for WebAssembly
// Returns { imports, setInstance, setLog }
// Options: { fs, files, preopens, stdout, stderr, log }
// If options.fs is provided, uses that filesystem; otherwise creates a new one
function createWasiComponent(memory, options = {}) {
    const fs = options.fs || new MemoryFileSystem(options);
    const encoder = new TextEncoder();
    let logEnabled = options.log ?? false;

    // Initialize stdio file descriptors (0-2 reserved in MemoryFileSystem)
    fs.fds.set(0, { type: 'stdio', name: 'stdin' });
    fs.fds.set(1, { type: 'stdio', name: 'stdout' });
    fs.fds.set(2, { type: 'stdio', name: 'stderr' });

    // Initialize preopened directories
    const preopens = options.preopens || { '/': '/' };
    for (const [wasiPath, hostPath] of Object.entries(preopens)) {
        const fd = fs.nextFd++;
        fs.fds.set(fd, {
            type: 'preopen',
            path: wasiPath,
            hostPath: hostPath,
        });
    }

    // Syscall logging
    function log(name, ...args) {
        if (logEnabled) {
            console.log(`[wasi] ${name}`, ...args);
        }
    }

    // Helper to read string from memory
    function readString(ptr, len) {
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        return fs.decoder.decode(bytes);
    }

    // Stdio buffering and output
    const stdoutBuffer = { text: '' };
    const stderrBuffer = { text: '' };
    const stdout = options.stdout || ((line) => console.log(line));
    const stderr = options.stderr || ((line) => console.error(line));
    const decoder = new TextDecoder();

    function writeStdio(fd, data) {
        const buffer = fd === 1 ? stdoutBuffer : stderrBuffer;
        const output = fd === 1 ? stdout : stderr;

        buffer.text += decoder.decode(data);

        // Flush on newlines
        while (buffer.text.includes('\n')) {
            const idx = buffer.text.indexOf('\n');
            const line = buffer.text.substring(0, idx);
            buffer.text = buffer.text.substring(idx + 1);
            output(line);
        }
        return data.length;
    }

    function flushStdio() {
        if (stdoutBuffer.text) {
            stdout(stdoutBuffer.text);
            stdoutBuffer.text = '';
        }
        if (stderrBuffer.text) {
            stderr(stderrBuffer.text);
            stderrBuffer.text = '';
        }
    }

    const imports = {
        // fd_write - write to file descriptor
        fd_write(fd, iovs_ptr, iovs_len, nwritten_ptr) {
            const view = new DataView(memory.buffer);
            const bytes = new Uint8Array(memory.buffer);
            let totalWritten = 0;

            for (let i = 0; i < iovs_len; i++) {
                const ptr = view.getUint32(iovs_ptr + i * 8, true);
                const len = view.getUint32(iovs_ptr + i * 8 + 4, true);
                const data = bytes.subarray(ptr, ptr + len);

                if (logEnabled && (fd === 1 || fd === 2)) {
                    const text = decoder.decode(data);
                    console.log(`[wasi] fd_write data (fd=${fd}, len=${len}): ${JSON.stringify(text)}`);
                }

                if (fd === 1 || fd === 2) {
                    totalWritten += writeStdio(fd, data);
                } else {
                    const { written } = fs.write(fd, data);
                    totalWritten += written;
                }
            }

            view.setUint32(nwritten_ptr, totalWritten, true);
            return WASI_ERRNO.SUCCESS;
        },

        // fd_read - read from file descriptor
        fd_read(fd, iovs_ptr, iovs_len, nread_ptr) {
            const view = new DataView(memory.buffer);
            let totalRead = 0;

            for (let i = 0; i < iovs_len; i++) {
                const ptr = view.getUint32(iovs_ptr + i * 8, true);
                const len = view.getUint32(iovs_ptr + i * 8 + 4, true);

                const { errno, data } = fs.read(fd, len);
                if (errno !== WASI_ERRNO.SUCCESS) {
                    view.setUint32(nread_ptr, totalRead, true);
                    return errno;
                }

                if (data && data.length > 0) {
                    new Uint8Array(memory.buffer, ptr, data.length).set(data);
                    totalRead += data.length;
                }
            }

            view.setUint32(nread_ptr, totalRead, true);
            return WASI_ERRNO.SUCCESS;
        },

        // fd_pread - read at offset
        fd_pread(fd, iovs_ptr, iovs_len, offset, nread_ptr) {
            const view = new DataView(memory.buffer);
            let totalRead = 0;
            let currentOffset = Number(offset);

            for (let i = 0; i < iovs_len; i++) {
                const ptr = view.getUint32(iovs_ptr + i * 8, true);
                const len = view.getUint32(iovs_ptr + i * 8 + 4, true);

                const { errno, data } = fs.pread(fd, len, currentOffset);
                if (errno !== WASI_ERRNO.SUCCESS) {
                    view.setUint32(nread_ptr, totalRead, true);
                    return errno;
                }

                if (data && data.length > 0) {
                    new Uint8Array(memory.buffer, ptr, data.length).set(data);
                    currentOffset += data.length;
                    totalRead += data.length;
                }
            }

            view.setUint32(nread_ptr, totalRead, true);
            return WASI_ERRNO.SUCCESS;
        },

        // fd_pwrite - write at offset
        fd_pwrite(fd, iovs_ptr, iovs_len, offset, nwritten_ptr) {
            const view = new DataView(memory.buffer);
            const bytes = new Uint8Array(memory.buffer);
            let totalWritten = 0;
            let currentOffset = Number(offset);

            for (let i = 0; i < iovs_len; i++) {
                const ptr = view.getUint32(iovs_ptr + i * 8, true);
                const len = view.getUint32(iovs_ptr + i * 8 + 4, true);
                const data = bytes.subarray(ptr, ptr + len);

                const { written } = fs.pwrite(fd, data, currentOffset);
                currentOffset += written;
                totalWritten += written;
            }

            view.setUint32(nwritten_ptr, totalWritten, true);
            return WASI_ERRNO.SUCCESS;
        },

        // fd_close - close file descriptor
        fd_close(fd) {
            return fs.closeFd(fd);
        },

        // fd_seek - seek in file
        fd_seek(fd, offset, whence, newoffset_ptr) {
            const view = new DataView(memory.buffer);
            const { errno, offset: newOffset } = fs.seek(fd, offset, whence);
            view.setBigUint64(newoffset_ptr, BigInt(newOffset), true);
            return errno;
        },

        // fd_tell - get current position
        fd_tell(fd, offset_ptr) {
            const view = new DataView(memory.buffer);
            const { errno, offset } = fs.tell(fd);
            view.setBigUint64(offset_ptr, BigInt(offset), true);
            return errno;
        },

        // fd_fdstat_get - get file descriptor status
        fd_fdstat_get(fd, stat_ptr) {

            const view = new DataView(memory.buffer);
            const fdEntry = fs.getFd(fd);
            if (!fdEntry) return WASI_ERRNO.BADF;


            let filetype = WASI_FILETYPE.REGULAR_FILE;
            let rights = ALL_RIGHTS;
            if (fdEntry.type === 'stdio') {
                filetype = WASI_FILETYPE.CHARACTER_DEVICE;
                rights = STDIO_RIGHTS; // No seek/tell - makes isatty() return true
            } else if (fdEntry.type === 'preopen') {
                filetype = WASI_FILETYPE.DIRECTORY;
            }

            view.setUint8(stat_ptr, filetype);
            view.setUint16(stat_ptr + 2, 0, true); // flags
            view.setBigUint64(stat_ptr + 8, rights, true); // rights_base
            view.setBigUint64(stat_ptr + 16, rights, true); // rights_inheriting
            return WASI_ERRNO.SUCCESS;
        },

        fd_fdstat_set_flags(fd, flags) {
            return WASI_ERRNO.SUCCESS;
        },

        fd_sync(fd) {
            return WASI_ERRNO.SUCCESS;
        },

        fd_datasync(fd) {
            return WASI_ERRNO.SUCCESS;
        },

        fd_advise(fd, offset, len, advice) {
            return WASI_ERRNO.SUCCESS;
        },

        fd_allocate(fd, offset, len) {
            return fs.allocate(fd, offset, len);
        },

        // fd_filestat_get - get file stats by fd
        fd_filestat_get(fd, buf_ptr) {
            const view = new DataView(memory.buffer);
            const stat = fs.fileStat(fd);
            if (stat.errno !== WASI_ERRNO.SUCCESS) return stat.errno;

            view.setBigUint64(buf_ptr + 0, 0n, true); // dev
            view.setBigUint64(buf_ptr + 8, BigInt(stat.ino || 0), true); // ino
            view.setUint8(buf_ptr + 16, stat.filetype);
            view.setBigUint64(buf_ptr + 24, BigInt(stat.nlink), true);
            view.setBigUint64(buf_ptr + 32, BigInt(stat.size), true);
            view.setBigUint64(buf_ptr + 40, 0n, true); // atim
            view.setBigUint64(buf_ptr + 48, 0n, true); // mtim
            view.setBigUint64(buf_ptr + 56, 0n, true); // ctim
            return WASI_ERRNO.SUCCESS;
        },

        fd_filestat_set_size(fd, size) {
            return fs.setFileSize(fd, size);
        },

        fd_filestat_set_times(fd, atim, mtim, fst_flags) {
            return WASI_ERRNO.SUCCESS;
        },

        // fd_prestat_get - get preopened fd info
        fd_prestat_get(fd, buf_ptr) {
            const fdEntry = fs.getFd(fd);
            if (!fdEntry || fdEntry.type !== 'preopen') {
                return WASI_ERRNO.BADF;
            }

            const view = new DataView(memory.buffer);
            view.setUint8(buf_ptr, 0); // pr_type = directory
            view.setUint32(buf_ptr + 4, encoder.encode(fdEntry.path).length, true);
            return WASI_ERRNO.SUCCESS;
        },

        // fd_prestat_dir_name - get preopened dir name
        fd_prestat_dir_name(fd, path_ptr, path_len) {
            const fdEntry = fs.getFd(fd);
            if (!fdEntry || fdEntry.type !== 'preopen') {
                return WASI_ERRNO.BADF;
            }

            const pathBytes = encoder.encode(fdEntry.path);
            const len = Math.min(pathBytes.length, path_len);
            new Uint8Array(memory.buffer, path_ptr, len).set(pathBytes.subarray(0, len));
            return WASI_ERRNO.SUCCESS;
        },

        fd_readdir(fd, buf_ptr, buf_len, cookie, bufused_ptr) {
            const view = new DataView(memory.buffer);
            view.setUint32(bufused_ptr, 0, true);
            return WASI_ERRNO.SUCCESS;
        },

        // path_open - open file by path
        path_open(dirfd, dirflags, path_ptr, path_len, oflags, fs_rights_base, fs_rights_inheriting, fdflags, fd_ptr) {
            const view = new DataView(memory.buffer);
            const path = readString(path_ptr, path_len);

            const result = fs.openFile(dirfd, path, oflags);
            if (result.errno !== WASI_ERRNO.SUCCESS) {
                return result.errno;
            }

            view.setUint32(fd_ptr, result.fd, true);
            return WASI_ERRNO.SUCCESS;
        },

        // path_filestat_get - get file stats by path
        path_filestat_get(dirfd, flags, path_ptr, path_len, buf_ptr) {
            const view = new DataView(memory.buffer);
            const path = readString(path_ptr, path_len);

            const stat = fs.pathStat(dirfd, path);
            if (stat.errno !== WASI_ERRNO.SUCCESS) {
                return stat.errno;
            }

            view.setBigUint64(buf_ptr + 0, 0n, true); // dev
            view.setBigUint64(buf_ptr + 8, BigInt(stat.ino || 0), true); // ino
            view.setUint8(buf_ptr + 16, stat.filetype);
            view.setBigUint64(buf_ptr + 24, BigInt(stat.nlink), true);
            view.setBigUint64(buf_ptr + 32, BigInt(stat.size), true);
            view.setBigUint64(buf_ptr + 40, 0n, true); // atim
            view.setBigUint64(buf_ptr + 48, 0n, true); // mtim
            view.setBigUint64(buf_ptr + 56, 0n, true); // ctim
            return WASI_ERRNO.SUCCESS;
        },

        path_create_directory(dirfd, path_ptr, path_len) {
            return WASI_ERRNO.SUCCESS;
        },

        path_unlink_file(dirfd, path_ptr, path_len) {
            const path = readString(path_ptr, path_len);
            return fs.unlink(dirfd, path);
        },

        path_rename(old_dirfd, old_path_ptr, old_path_len, new_dirfd, new_path_ptr, new_path_len) {
            const oldPath = readString(old_path_ptr, old_path_len);
            const newPath = readString(new_path_ptr, new_path_len);
            return fs.rename(old_dirfd, oldPath, new_dirfd, newPath);
        },

        path_remove_directory(dirfd, path_ptr, path_len) {
            return WASI_ERRNO.SUCCESS;
        },

        path_symlink(old_path_ptr, old_path_len, dirfd, new_path_ptr, new_path_len) {
            return WASI_ERRNO.NOSYS;
        },

        path_link(old_fd, old_flags, old_path_ptr, old_path_len, new_fd, new_path_ptr, new_path_len) {
            return WASI_ERRNO.NOSYS;
        },

        path_readlink(dirfd, path_ptr, path_len, buf_ptr, buf_len, bufused_ptr) {
            return WASI_ERRNO.NOSYS;
        },

        path_filestat_set_times(dirfd, flags, path_ptr, path_len, atim, mtim, fst_flags) {
            return WASI_ERRNO.SUCCESS;
        },

        // proc_exit - exit process (noreturn per WASI spec)
        proc_exit(code) {
            flushStdio();
            throw new ExitStatus(code);
        },

        // clock_time_get - get current time
        clock_time_get(clock_id, precision, time_ptr) {
            const view = new DataView(memory.buffer);
            const now = BigInt(Math.floor(Date.now() * 1_000_000)); // nanoseconds
            view.setBigUint64(time_ptr, now, true);
            return WASI_ERRNO.SUCCESS;
        },

        clock_res_get(clock_id, resolution_ptr) {
            const view = new DataView(memory.buffer);
            view.setBigUint64(resolution_ptr, 1000000n, true); // 1ms in ns
            return WASI_ERRNO.SUCCESS;
        },

        // random_get - get random bytes
        random_get(buf_ptr, buf_len) {
            const bytes = new Uint8Array(memory.buffer, buf_ptr, buf_len);
            crypto.getRandomValues(bytes);
            return WASI_ERRNO.SUCCESS;
        },

        // poll_oneoff - polling (stub)
        poll_oneoff(in_ptr, out_ptr, nsubscriptions, nevents_ptr) {
            const view = new DataView(memory.buffer);
            view.setUint32(nevents_ptr, 0, true);
            return WASI_ERRNO.SUCCESS;
        },

        // sched_yield - yield to scheduler
        sched_yield() {
            return WASI_ERRNO.SUCCESS;
        },

        // Socket stubs
        sock_accept(fd, flags, result_fd_ptr) {
            return WASI_ERRNO.NOSYS;
        },

        sock_recv(fd, ri_data_ptr, ri_data_len, ri_flags, ro_datalen_ptr, ro_flags_ptr) {
            return WASI_ERRNO.NOSYS;
        },

        sock_send(fd, si_data_ptr, si_data_len, si_flags, so_datalen_ptr) {
            return WASI_ERRNO.NOSYS;
        },

        sock_shutdown(fd, how) {
            return WASI_ERRNO.NOSYS;
        },

        // Args support
        args_sizes_get(argc_ptr, argv_buf_size_ptr) {
            const view = new DataView(memory.buffer);
            const args = options.args || [];
            const bufSize = args.reduce((sum, arg) => sum + encoder.encode(arg).length + 1, 0);
            view.setUint32(argc_ptr, args.length, true);
            view.setUint32(argv_buf_size_ptr, bufSize, true);
            return WASI_ERRNO.SUCCESS;
        },

        args_get(argv_ptr, argv_buf_ptr) {
            const view = new DataView(memory.buffer);
            const args = options.args || [];
            let bufOffset = 0;

            for (let i = 0; i < args.length; i++) {
                // Write pointer to this arg
                view.setUint32(argv_ptr + i * 4, argv_buf_ptr + bufOffset, true);

                // Write the arg string (null-terminated)
                const encoded = encoder.encode(args[i]);
                new Uint8Array(memory.buffer, argv_buf_ptr + bufOffset, encoded.length).set(encoded);
                new Uint8Array(memory.buffer)[argv_buf_ptr + bufOffset + encoded.length] = 0;
                bufOffset += encoded.length + 1;
            }
            return WASI_ERRNO.SUCCESS;
        },

        environ_sizes_get(environ_count_ptr, environ_buf_size_ptr) {
            const view = new DataView(memory.buffer);
            view.setUint32(environ_count_ptr, 0, true);
            view.setUint32(environ_buf_size_ptr, 0, true);
            return WASI_ERRNO.SUCCESS;
        },

        environ_get(environ_ptr, environ_buf_ptr) {
            return WASI_ERRNO.SUCCESS;
        },
    };

    // Wrap all functions with logging
    const wasiImports = {};
    for (const [name, fn] of Object.entries(imports)) {
        wasiImports[name] = (...args) => {
            const result = fn(...args);
            log(name, ...args, '→', result);
            return result;
        };
    }

    // Set instance (WASI doesn't need the instance, but follows the pattern)
    const setInstance = (inst) => {};

    // Control function to enable/disable logging
    const setLog = (enabled) => { logEnabled = enabled; };

    return { imports: wasiImports, setInstance, setLog };
}

// suspend.js - Re-entrancy protection for JSPI suspend/resume
//
// Manages instance state to prevent callbacks from re-entering
// wasm while it is suspended. Two suspension modes:
//   - exclusive: queue (or drop) incoming events until resume
//   - ready: resolve a pending promise when the next event arrives

// Instance states
const RUNNING = 'running';
const SUSPENDED_EXCLUSIVE = 'suspended_exclusive';
const SUSPENDED_READY = 'suspended_ready';

// Known event properties to snapshot per event type.
// Primitives only — functions and object references are skipped.
const baseEventProps = ['type', 'timeStamp', 'bubbles', 'cancelable'];

const mouseProps = [
    'clientX', 'clientY', 'pageX', 'pageY', 'screenX', 'screenY',
    'offsetX', 'offsetY', 'movementX', 'movementY',
    'button', 'buttons',
    'altKey', 'ctrlKey', 'metaKey', 'shiftKey',
];

const pointerProps = [
    ...mouseProps,
    'pointerId', 'pointerType', 'pressure', 'width', 'height',
    'tiltX', 'tiltY', 'twist', 'isPrimary',
];

const keyProps = [
    'key', 'code', 'repeat',
    'altKey', 'ctrlKey', 'metaKey', 'shiftKey',
];

const wheelProps = [
    ...mouseProps,
    'deltaX', 'deltaY', 'deltaZ', 'deltaMode',
];

// Map constructor name → property list
const eventPropertyMap = {
    'PointerEvent': pointerProps,
    'MouseEvent': mouseProps,
    'KeyboardEvent': keyProps,
    'WheelEvent': wheelProps,
};

// Snapshot an argument value for queuing.
// Event objects are copied to plain objects; other values pass through.
function snapshotArg(arg) {
    if (typeof Event !== 'undefined' && arg instanceof Event) {
        const props = eventPropertyMap[arg.constructor.name] || [];
        const snap = {};
        for (const key of baseEventProps) {
            snap[key] = arg[key];
        }
        for (const key of props) {
            const v = arg[key];
            if (typeof v !== 'function' && typeof v !== 'object') {
                snap[key] = v;
            }
        }
        return snap;
    }
    return arg;
}

function snapshotArgs(args) {
    return args.map(snapshotArg);
}

class SuspendController {
    constructor() {
        this._state = RUNNING;
        this._queue = [];
        // For suspended_ready: resolve function to wake the waiter
        this._readyResolve = null;
        // Default policy for events arriving during exclusive suspension
        this._exclusivePolicy = 'queue'; // 'queue' | 'drop'
    }

    get state() { return this._state; }

    // Enter exclusive suspension (e.g. val::await).
    // Events will be queued or dropped per policy.
    enterExclusive() {
        this._state = SUSPENDED_EXCLUSIVE;
    }

    // Enter ready-for-events suspension.
    // Returns a Promise that resolves (with no value) when at least one event
    // has been queued. After resume, caller should drain the queue.
    enterReady() {
        this._state = SUSPENDED_READY;
        return new Promise(resolve => {
            if (this._queue.length > 0) {
                // Already have queued events — resolve immediately
                resolve();
            } else {
                this._readyResolve = resolve;
            }
        });
    }

    // Resume from any suspended state. Returns queued events (caller drains them).
    resume() {
        this._state = RUNNING;
        this._readyResolve = null;
        const queued = this._queue;
        this._queue = [];
        return queued;
    }

    // Set the policy for events during exclusive suspension.
    setExclusivePolicy(policy) {
        this._exclusivePolicy = policy;
    }

    // Gate a callback dispatch. Called from val.js/_val_function wrappers.
    //   dispatchFn: () => void — calls into wasm if we dispatch now
    //   entry: { callbackId, args, isFunctor } — for queuing
    //
    // Returns true if the event was dispatched immediately.
    gate(dispatchFn, entry) {
        switch (this._state) {
            case RUNNING:
                dispatchFn();
                return true;

            case SUSPENDED_EXCLUSIVE:
                if (this._exclusivePolicy === 'queue') {
                    this._queue.push({
                        ...entry,
                        args: snapshotArgs(entry.args),
                    });
                }
                // 'drop' policy: do nothing
                return false;

            case SUSPENDED_READY:
                // Always snapshot — Event objects are invalid after the
                // handler returns, and wasm won't resume until later.
                this._queue.push({
                    ...entry,
                    args: snapshotArgs(entry.args),
                });
                if (this._readyResolve) {
                    const resolve = this._readyResolve;
                    this._readyResolve = null;
                    resolve(); // wake up — queue has events to drain
                }
                return false;

            default:
                dispatchFn();
                return true;
        }
    }
}

// loader.js - NuScripten runtime and loader


// Check for JSPI support
const hasJSPI = typeof WebAssembly.Suspending !== 'undefined' &&
                typeof WebAssembly.promising !== 'undefined';

// Create runtime components for manual WebAssembly.instantiate
// Returns { imports, memory, setInstance, startInstance, getGLRuntime }
// Options: { args: ["prog", "arg1", ...], canvas, ... }
// Caller can add custom imports by modifying imports.env after this call
function createRuntimeComponents(options = {}) {

    const imports = {};

    // Suspend controller for re-entrancy protection
    const suspendController = options.suspendController || new SuspendController();

    // Create memory (caller can provide their own or set initial page count)
    const memory = options.memory || new WebAssembly.Memory({
        initial: options.memoryPages || 512,
        maximum: 65536
    });
    imports.env = { memory };

    // Wasi component
    const wasi = createWasiComponent(memory, options);
    imports.wasi_snapshot_preview1 = wasi.imports;

    // Val component (JS interop)
    // options.valBackend: 'table' selects the wasm externref table backend
    const val = options.valBackend === 'table'
        ? createValTableComponent(memory, suspendController)
        : createValComponent(memory, suspendController);
    imports.val = val.imports;

    // Extra components (optional, e.g. nuscripten-opengl)
    // Each entry is a factory: (memory, val, options) => { namespace, imports, setInstance }
    const extras = (options.extraComponents || []).map(factory => {
        const component = factory(memory, val, options);
        imports[component.namespace] = component.imports;
        return component;
    });

    // Merged exports: all exports with promising ones auto-wrapped (populated by setInstance)
    const nuexports = {};

    // Set the instance on all runtime components
    const setInstance = (inst) => {
        val.setInstance(inst);
        for (const extra of extras) extra.setInstance(inst);

        // Check for memory mismatch
        if (inst.exports.memory) {
            console.warn(
                'WASM module exports its own memory instead of importing it. ' +
                'Rebuild with -Wl,--import-memory'
            );
        }

        // Build nuexports: all exports, with promising ones wrapped
        const promising = new Set();
        if (hasJSPI) {
            for (const name of Object.keys(inst.exports)) {
                if (name.startsWith('_promising_marker:')) {
                    promising.add(name.slice('_promising_marker:'.length));
                }
            }
        }
        for (const [name, value] of Object.entries(inst.exports)) {
            if (name.startsWith('_promising_marker:')) continue;
            nuexports[name] = (promising.has(name) && typeof value === 'function')
                ? WebAssembly.promising(value)
                : value;
        }

        // Expose WASI log control on instance
        inst.setWasiLog = wasi.setLog; // FIXME clean up
    };

    // Start instance: call _start (with JSPI wrapping if available)
    // Catches ExitStatus with code 0 (normal exit); re-throws non-zero exits and other errors
    const startInstance = async (inst) => {
        try {
            if (inst.exports._start) {
                if (hasJSPI) {
                    const start = WebAssembly.promising(inst.exports._start);
                    await start();
                } else {
                    inst.exports._start();
                }
            }
        } catch (e) {
            if (e instanceof ExitStatus && e.code === 0) {
                return; // Normal exit
            }
            throw e;
        }
    };

    return { imports, memory, setInstance, startInstance, nuexports, suspendController };
}

// Playground class - compile, link, and run C/C++ in the browser
//
// Usage:
//   const pg = new Playground();
//   await pg.ready;
//   const result = await pg.run('c', source);


class Playground {
    constructor(options = {}) {
        this._clang = createLlvm(options);
        this._onStdout = options.onStdout || (() => {});
        this._onStderr = options.onStderr || (() => {});
        this._onStatus = options.onStatus || (() => {});
        this._versionPromise = this._fetchVersion();
    }

    // Resolves when the wasm module is compiled and ready
    get ready() { return this._clang.ready; }

    // Returns the clang version string (e.g. "clang version 23.0.0git")
    async getVersion() { return this._versionPromise; }

    async _fetchVersion() {
        try {
            await this._clang.ready;
            const result = await this._clang.run(['clang', '--version'], {});
            const full = (result.stdout[0] || '');
            const match = full.match(/clang version \S+/);
            return match ? match[0] : '';
        } catch (e) {
            return '';
        }
    }

    // Compile, link, and run source code.
    // lang: 'c' or 'cpp'
    // source: string of source code
    // Returns: { exitCode, stdout }
    async run(lang, source) {
        const isCpp = lang === 'cpp';
        const srcFile = isCpp ? 'main.cpp' : 'main.c';
        const compiler = isCpp ? 'clang++' : 'clang';

        // Compile
        const compileArgs = [compiler, '-c', srcFile, '-o', 'main.o',
            '--target=wasm32-wasip1', '-O2', '-I/usr/include'];
        if (isCpp) {
            compileArgs.push('-std=c++23', '-fno-exceptions',
                '-stdlib++-isystem', '/usr/include/wasm32-wasip1/c++/v1');
        }

        this._onStatus('Compiling...');
        this._onStdout('--- Compiling ---');
        this._onStdout('$ ' + compileArgs.join(' '));
        const compile = await this._clang.run(compileArgs, { [srcFile]: source }, { onStderr: this._onStderr });
        if (compile.exitCode !== 0 || !compile.files['main.o']) {
            this._onStatus('Compile failed', 'error');
            return { exitCode: compile.exitCode, stdout: '' };
        }
        this._onStdout(`main.o: ${compile.files['main.o'].length} bytes`);

        // Link
        const linkArgs = [
            'wasm-ld',
            '-O2',
            '-L/usr/lib/wasm32-wasip1',
            '-L/usr/lib/wasm32-unknown-wasip1',
            '/usr/lib/wasm32-wasip1/crt1.o', 'main.o',
            '-lc', '-lclang_rt.builtins',
            '--import-memory', '--allow-undefined',
            '-o', 'main.wasm',
        ];
        if (isCpp) {
            linkArgs.splice(linkArgs.indexOf('-lc'), 0, '-lc++', '-lc++abi');
        }

        this._onStatus('Linking...');
        this._onStdout('\n--- Linking ---');
        this._onStdout('$ ' + linkArgs.join(' '));
        const link = await this._clang.run(linkArgs, { 'main.o': compile.files['main.o'] }, { onStderr: this._onStderr });
        if (link.exitCode !== 0 || !link.files['main.wasm']) {
            this._onStatus('Link failed', 'error');
            return { exitCode: link.exitCode, stdout: '' };
        }
        this._onStdout(`main.wasm: ${link.files['main.wasm'].length} bytes`);

        // Run
        this._onStatus('Running...');
        this._onStdout('\n--- Running ---');
        const result = await this._runWasm(link.files['main.wasm']);
        if (result.stdout) this._onStdout(result.stdout);
        this._onStdout(`\nExit code: ${result.exitCode}`);
        this._onStatus('OK', 'success');

        return result;
    }

    async _runWasm(wasmBytes) {
        const stdoutLines = [];

        const memory = new WebAssembly.Memory({ initial: 256, maximum: 65536 });
        const { imports, setInstance, startInstance } = createRuntimeComponents({
            memory,
            skipGL: true,
            args: ['main.wasm'],
            stdout: (line) => stdoutLines.push(line),
            stderr: (line) => stdoutLines.push(line),
        });

        const module = await WebAssembly.compile(wasmBytes);
        const instance = await WebAssembly.instantiate(module, imports);
        setInstance(instance);

        let exitCode = 0;
        try {
            await startInstance(instance);
        } catch (e) {
            if (e instanceof ExitStatus) {
                exitCode = e.code;
            } else {
                throw e;
            }
        }

        return { stdout: stdoutLines.join('\n'), exitCode };
    }

    terminate() {
        this._clang.terminate();
    }
}

export { Playground };
