const external = ['fs', 'path', 'url'];

export default [
  {
    input: 'src/llvm.js',
    output: {
      file: 'dist/llvm.js',
      format: 'es',
    },
  },
  {
    input: 'src/llvm-worker.js',
    output: {
      file: 'dist/llvm-worker.js',
      format: 'es',
    },
    external,
  },
  {
    input: 'playground/playground.js',
    output: {
      file: 'dist/playground.js',
      format: 'es',
    },
    external,
  },
];
