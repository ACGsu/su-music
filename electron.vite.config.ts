import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: resolve('src/main/index.ts'), formats: ['cjs'] },
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } }
    }
  },
  preload: {
    build: {
      externalizeDeps: false,
      isolatedEntries: true,
      outDir: 'out/preload',
      lib: { entry: resolve('src/preload/index.ts'), formats: ['cjs'] },
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [vue()],
    server: {
      host: '127.0.0.1', port: 5173, strictPort: true,
      headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: su-music://app; connect-src 'self' ws://127.0.0.1:5173; media-src su-music://media; object-src 'none'; frame-src 'none'; base-uri 'none'" }
    },
    build: { outDir: resolve('out/renderer') }
  }
})
