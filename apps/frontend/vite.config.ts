import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

// Only the local development server needs mkcert files. The build and CI must
// load this config without requiring developer-specific TLS certificates.
export default defineConfig(({ command }) => {
  const localHttps = command === 'serve' && !process.env.CI && !process.env.VITEST

  return {
    server: {
      host: 'localhost',
      port: 8443,
      strictPort: true,
      ...(localHttps
        ? {
            https: {
              key: readFileSync(
                new URL('../../infra/tls/localhost-key.pem', import.meta.url),
              ),
              cert: readFileSync(
                new URL('../../infra/tls/localhost.pem', import.meta.url),
              ),
            },
          }
        : {}),
      proxy: {
        '/api': 'http://127.0.0.1:3000',
      },
    },
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset()] }),
    ],
  }
})
