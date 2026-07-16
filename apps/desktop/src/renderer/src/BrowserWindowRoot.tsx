/**
 * Root for the STANDALONE browser popup window (loaded at `#browser`). It renders
 * only the browser chrome full-window; the tab WebContentsViews + activity overlay
 * are composited over it by the main process. A minimal bridge feeds tab state and
 * settings (for i18n) — the heavy app bridges (gateway/rpc/sessions) stay in the
 * main window.
 */
import { useEffect } from 'react';
import { Browser } from '@/components/Browser';
import { useLang } from '@/lib/i18n';
import { initBrowserWindowBridge } from '@/store';

export function BrowserWindowRoot() {
  const lang = useLang();
  useEffect(() => initBrowserWindowBridge(), []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return (
    <div className="flex h-full flex-col">
      <Browser />
    </div>
  );
}
