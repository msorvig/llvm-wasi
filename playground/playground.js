// Playground class - compile, link, and run C/C++ in the browser
//
// Usage:
//   const pg = new Playground();
//   await pg.ready;
//   const result = await pg.run('c', source);

import { createLlvm } from '../src/llvm.js';
import { createRuntimeComponents, ExitStatus } from '../nuscripten-core/runtime/loader.js';

export class Playground {
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
