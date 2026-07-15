import type { DesktopApi } from './index.js';

declare global {
  interface Window {
    ea: DesktopApi;
  }
}

export {};
