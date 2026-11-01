import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  // babylon-mmd finds its WebAssembly (Bullet physics) next to its own modules through `new URL(…, import.meta.url)`,
  // which pre-bundling breaks; Babylon's core stays out with it, or babylon-mmd would register its shaders in a
  // second copy of Babylon (ui-draft/mmd-lab does the same).
  optimizeDeps: { exclude: ['babylon-mmd', '@babylonjs/core'] },
  // 1420 is the waifufy overlay's dev port.
  server: { port: 1430, strictPort: true, fs: { allow: ['..'] } },
  build: { target: 'es2022', outDir: 'dist' },
  // TAURI_ENV_PLATFORM ('android' for the phone app) is replaced at build time, so code a phone never uses (the pose
  // studio) is left out of its bundle.
  envPrefix: ['VITE_', 'TAURI_ENV_'],
})
