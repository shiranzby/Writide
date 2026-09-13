import { defineConfig } from '@playwright/test';
import isolated from './playwright.isolated.config';

// Public fixtures only. Personal real-document acceptance stays separate.
export default defineConfig({
  ...isolated,
  testMatch: ['workspace-startup-isolated.test.ts', 'webdav-loading-isolated.test.ts', 'image-cache-isolated.test.ts', 'document-reopen-isolated.test.ts', 'r66-navigation-isolated.test.ts', 'r67-upward-scroll-isolated.test.ts', 'r68-image-remount-isolated.test.ts', 'directory-reconnect-isolated.test.ts',
    'r60-acceptance-isolated.test.ts', 'r62-acceptance-isolated.test.ts', 'code-wrap-isolated.test.ts',
    'media-drag-layout-isolated.test.ts', 'directory-migration-isolated.test.ts', 'toolbar-layout-isolated.test.ts', 'webdav-document-move-isolated.test.ts'],
  retries: 0,
  use: { ...isolated.use, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
