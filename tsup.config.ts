import { defineConfig } from 'tsup'

const common = {
  format: 'cjs' as const,
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  splitting: false,
}

export default defineConfig([
  { ...common, entry: { index: 'src/main/index.ts' }, outDir: 'out/main' },
  { ...common, entry: { index: 'src/preload/index.ts' }, outDir: 'out/preload' },
])
