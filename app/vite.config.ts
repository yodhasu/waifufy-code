import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  // 1420 is the waifufy overlay's dev port.
  server: { port: 1430, strictPort: true, fs: { allow: ['..'] } },
  build: { target: 'es2022', outDir: 'dist' },
})
