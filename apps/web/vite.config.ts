import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'
import { readFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { deploymentEdition } from '../../packages/trpc/src/deployment'

// plugin-react-swc resolves the hoisted vite copy, whose Plugin type differs from this workspace's vite.
const reactPlugin = react() as unknown as PluginOption

const onprem = deploymentEdition(process.env.VITE_DEPLOYMENT_EDITION) === 'onprem'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8787'
const vendorChunks: Record<string, string[]> = {
  'vendor-router': ['react-router-dom'],
  'vendor-i18n': ['i18next', 'react-i18next'],
  'vendor-ui': ['lucide-react'],
  'vendor-charts': ['recharts'],
  'vendor-dnd': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
  'vendor-query': ['@tanstack/react-query', '@trpc/client', '@trpc/tanstack-react-query'],
  'vendor-radix': ['@radix-ui/react-checkbox', '@radix-ui/react-select', '@radix-ui/react-slot'],
}

// https://vite.dev/config/
export default defineConfig({
  publicDir: onprem ? false : 'public',
  plugins: [reactPlugin, ...(onprem ? [{
    name: 'videoq-onprem-assets',
    transformIndexHtml: {
      order: 'pre' as const,
      handler: () => readFileSync(path.resolve(__dirname, 'index.onprem.html'), 'utf8'),
    },
    writeBundle(options: { dir?: string }) {
      const output = options.dir || path.resolve(__dirname, 'dist')
      mkdirSync(path.join(output, 'licenses'), { recursive: true })
      for (const file of ['favicon.ico', 'apple-touch-icon.png', 'logo192.png', 'logo512.png', 'licenses/mediabunny.txt']) {
        copyFileSync(path.resolve(__dirname, 'public', file), path.join(output, file))
      }
      writeFileSync(path.join(output, 'robots.txt'), 'User-agent: *\nDisallow: /\n')
      writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ name: 'VideoQ', short_name: 'VideoQ',
        start_url: '/', display: 'standalone', icons: [{ src: '/logo192.png', sizes: '192x192', type: 'image/png' }] }))
    },
  }] : [])],
  resolve: {
    alias: [
      ...(onprem ? ['LandingPage', 'TryPage', 'PricingPage', 'LegalPage', 'SignupPage', 'SignupCheckEmailPage',
        'SignupCompletePage', 'ForgotPasswordPage', 'VerifyEmailPage', 'EmailChangeConfirmPage', 'GuideIndexPage', 'GuidePage'].map(page => ({
        find: new RegExp(`^@/pages/${page}$`), replacement: path.resolve(__dirname, 'src/pages/UnavailablePage.tsx'),
      })) : []),
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
  server: {
    // CLI `--host 0.0.0.0` (compose) overrides; default stays loopback for host-only Vite.
    host: process.env.VITE_DEV_HOST || '127.0.0.1',
    port: 3000,
    proxy: {
      // Local Hono (wrangler). Client should use VITE_API_URL=/api so cookies stay same-origin.
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      // Health endpoints live at the API origin root rather than below /api.
      '/health': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      '/ready': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id) {
          return Object.entries(vendorChunks).find(([, packages]) =>
            packages.some((dependency) => id.includes(`/node_modules/${dependency}/`)),
          )?.[0]
        },
      },
    },
  },
})
