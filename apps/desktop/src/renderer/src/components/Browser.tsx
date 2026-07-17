/**
 * Embedded browser tab (desktop-app §browser). Renders only the CHROME — tab
 * strip, address bar, back/fwd/reload/new — plus a placeholder div. The web
 * content is a native WebContentsView the main process paints over that div, so
 * this component measures the placeholder and reports its bounds, and shows/hides
 * the native view on mount/unmount (switching to Chat/Settings unmounts it).
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  browserBack,
  browserCloseTab,
  browserForward,
  browserHide,
  browserNavigate,
  browserNewTab,
  browserReload,
  browserSelectTab,
  browserSetBounds,
  browserShow,
  useStore,
} from '@/store';

export function Browser() {
  const state = useStore((s) => s.browser);
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  const placeholder = useRef<HTMLDivElement>(null);
  const [addr, setAddr] = useState('');

  // Keep the address bar in sync with the active tab.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sync only when the active tab's id/url changes
  useEffect(() => {
    setAddr(active?.url ?? '');
  }, [active?.id, active?.url]);

  // Show the native view while mounted; track the placeholder's bounds. The
  // activity overlay is driven from the MAIN window's store (it owns the activity
  // log), so there's nothing to push from here.
  useEffect(() => {
    browserShow();
    const el = placeholder.current;
    if (!el) return;
    const push = (): void => {
      const r = el.getBoundingClientRect();
      browserSetBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
    };
    push();
    const ro = new ResizeObserver(push);
    ro.observe(el);
    window.addEventListener('resize', push);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', push);
      browserHide();
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Tab strip doubles as the frameless window's title bar: drag region with
          the macOS traffic lights inset into the reserved ml-[70px] gap. */}
      <div className="flex items-center gap-1 px-2 pt-1.5 [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]">
        <div className="ml-[70px]" />
        {state.tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'group flex h-7 max-w-52 items-center rounded-lg text-xs',
              tab.id === state.activeTabId ? 'bg-muted' : 'hover:bg-accent',
            )}
          >
            <button
              type="button"
              onClick={() => browserSelectTab(tab.id)}
              className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5"
            >
              <Globe className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{tab.loading ? '加载中…' : tab.title}</span>
            </button>
            <button
              type="button"
              aria-label="close tab"
              onClick={() => browserCloseTab(tab.id)}
              className="mr-1 shrink-0 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <Button variant="ghost" size="icon" title="New tab" onClick={() => browserNewTab()}>
          <Plus />
        </Button>
      </div>

      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <Button variant="ghost" size="icon" disabled={!active?.canGoBack} onClick={browserBack}>
          <ArrowLeft />
        </Button>
        <Button variant="ghost" size="icon" disabled={!active?.canGoForward} onClick={browserForward}>
          <ArrowRight />
        </Button>
        <Button variant="ghost" size="icon" onClick={browserReload}>
          <RotateCw />
        </Button>
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') browserNavigate(addr.trim());
          }}
          placeholder="输入网址并回车…"
          className="h-7 flex-1 rounded-full bg-muted px-3.5 text-xs outline-none focus:bg-muted/80"
        />
      </div>

      {/* The native WebContentsView is composited over this region; the activity
          overlay is a second native view stacked on top of it (see store). */}
      <div ref={placeholder} className="min-h-0 flex-1 bg-background" />
    </div>
  );
}
