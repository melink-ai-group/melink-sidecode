import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/webview/**/*.dom.test.tsx'],
    setupFiles: ['./src/webview/domSetup.ts'],
    watch: false,
    clearMocks: true,
    restoreMocks: true,
    css: false
  }
});
