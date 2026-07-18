/**
 * Root for the STANDALONE artifact-preview popup window (loaded at `#artifact`).
 * Frameless like the browser window; renders the preview full-window as plain
 * renderer DOM (react-markdown / iframe / image) with a preview⇄source toggle.
 * The main app window fetches the bytes over RPC and streams them here through
 * main — this window is presentational (only a settings bridge for i18n/theme).
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ArtifactBody, ArtifactSource, artifactTypes, hasSource } from '@/components/artifact-view';
import { artifactIcon, fmtBytes } from '@/components/Trace';
import { useLang, useT } from '@/lib/i18n';
import { initArtifactWindowBridge } from '@/store';
import { cn } from '@/lib/utils';
import type { ArtifactWindowState } from '../../shared/ipc.js';

type Mode = 'preview' | 'source';

export function ArtifactWindowRoot() {
  const t = useT();
  const lang = useLang();
  const [state, setState] = useState<ArtifactWindowState>({ status: 'empty' });
  const [mode, setMode] = useState<Mode>('preview');

  useEffect(() => initArtifactWindowBridge(), []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // Replay the current state on mount, then follow pushes from main.
  useEffect(() => {
    void window.ea.artifact.getState().then(setState);
    return window.ea.artifact.onState(setState);
  }, []);

  // A new artifact always opens in preview mode. Reset during render on id change
  // — React's recommended alternative to an effect for state derived from props.
  const artifactId = state.artifact?.id;
  const [lastId, setLastId] = useState(artifactId);
  if (artifactId !== lastId) {
    setLastId(artifactId);
    setMode('preview');
  }

  // Esc closes the popup (like the old modal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void window.ea.artifact.close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const { artifact, base64, truncated, absPath, status } = state;
  const types = artifact ? artifactTypes(artifact) : undefined;
  const showToggle = types ? hasSource(types) : false;
  const effectiveMode: Mode = showToggle ? mode : 'preview';

  return (
    <div className="flex h-full flex-col bg-card text-card-foreground">
      {/* Header doubles as the frameless window's title bar: drag region with the
          macOS traffic lights inset into the reserved ml-[70px] gap. */}
      <header className="flex items-center gap-2 border-b px-2 py-1.5 [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]">
        <div className="ml-[70px]" />
        {artifact && artifactIcon(artifact.kind, 'size-4 shrink-0 text-primary')}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{artifact?.name ?? t('artifactPreviewTitle')}</div>
          {artifact && (
            <div className="truncate text-[11px] text-muted-foreground">
              {artifact.path} · {fmtBytes(artifact.size)}
            </div>
          )}
        </div>
        {showToggle && <ModeToggle mode={effectiveMode} onChange={setMode} previewLabel={t('previewTab')} sourceLabel={t('sourceTab')} />}
        {absPath && (
          <Button size="sm" variant="ghost" onClick={() => void window.ea.dialog.openPath(absPath)}>
            {t('artifactOpen')}
          </Button>
        )}
        <Button size="icon" variant="ghost" onClick={() => void window.ea.artifact.close()}>
          <X />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {status === 'loading' && <div className="p-4 text-xs text-muted-foreground">{t('loading')}</div>}
        {status === 'error' && (
          <div className="p-4 text-xs text-destructive">
            {types && !types.previewable ? t('artifactNoPreview') : t('artifactUnavailable')}
          </div>
        )}
        {status === 'ready' &&
          artifact &&
          types &&
          base64 !== undefined &&
          (effectiveMode === 'source' ? (
            <ArtifactSource base64={base64} truncated={!!truncated} />
          ) : (
            <ArtifactBody artifact={artifact} types={types} base64={base64} truncated={!!truncated} />
          ))}
      </div>
    </div>
  );
}

/** Two-state segmented control for preview ⇄ source. */
function ModeToggle({
  mode,
  onChange,
  previewLabel,
  sourceLabel,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  previewLabel: string;
  sourceLabel: string;
}) {
  const btn = (m: Mode, label: string): React.ReactElement => (
    <button
      type="button"
      onClick={() => onChange(m)}
      className={cn(
        'rounded px-2 py-0.5 text-xs font-medium transition-colors',
        mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5">
      {btn('preview', previewLabel)}
      {btn('source', sourceLabel)}
    </div>
  );
}
