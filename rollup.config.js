const external = ['fs', 'path', 'url'];

export default [
  {
    input: 'src/clang.js',
    output: {
      file: 'dist/clang.js',
      format: 'es',
    },
  },
  {
    input: 'src/clang-worker.js',
    output: {
      file: 'dist/clang-worker.js',
      format: 'es',
    },
    external,
  },
];
