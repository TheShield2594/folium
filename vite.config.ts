/// <reference types="vitest/config" />
import { existsSync } from 'node:fs';
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { powerApps } from '@microsoft/power-apps-vite';

// The Power Apps plugin wires the dev server into the Power Apps host. It needs the
// power.config.json that `pac code init` writes, so without it we run as a plain
// Vite app on demo data.
const plugins: PluginOption[] = [react()];
if (existsSync('power.config.json')) plugins.push(powerApps());

export default defineConfig({
  plugins,
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
  test: {
    environment: 'jsdom',
    globals: true,
    // e2e/ is Playwright (npm run test:a11y), against the built demo.
    exclude: ['**/node_modules/**', 'e2e/**'],
  },
});
