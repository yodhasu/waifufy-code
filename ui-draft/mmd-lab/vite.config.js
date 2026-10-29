// The MMD lab's dev server. babylon-mmd stays out of pre-bundling: it finds its WebAssembly (Bullet physics) next
// to its own modules through `new URL(…, import.meta.url)`, which bundling would break. Babylon's core stays out
// with it: pre-bundled for our imports but not for babylon-mmd's, there would be two copies of Babylon, and the
// shaders babylon-mmd registers in one (textureAlphaChecker…) would be missing in the one that renders.
import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: { exclude: ['babylon-mmd', '@babylonjs/core'] },
  server: { host: '127.0.0.1', port: 47130, strictPort: true },
})
