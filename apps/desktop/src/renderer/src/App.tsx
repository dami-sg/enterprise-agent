/**
 * App shell (desktop-app §10): header = profile Select + gateway/RPC status
 * badges + tab switch; banner strip (Alerts); body = Chat | Settings.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Download, Loader2, MessageSquare, RotateCw, ScrollText, Settings2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Chat } from '@/components/Chat';
import { Settings } from '@/components/Settings';
import { useLang, useT } from '@/lib/i18n';
import { initBridges, refreshProfiles, useStore } from '@/store';

export function App() {
  const [tab, setTab] = useState<'chat' | 'settings'>('chat');
  const lang = useLang();
  useEffect(() => initBridges(), []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return (
    <div className="flex h-full flex-col">
      <Header tab={tab} onTab={setTab} />
      <Banners />
      <main className="flex min-h-0 flex-1 flex-col">{tab === 'chat' ? <Chat /> : <Settings />}</main>
    </div>
  );
}

function Header({ tab, onTab }: { tab: 'chat' | 'settings'; onTab: (t: 'chat' | 'settings') => void }) {
  const t = useT();
  const profiles = useStore((s) => s.profiles);
  const activeId = useStore((s) => s.activeProfileId);
  return (
    <header className="flex items-center gap-2.5 bg-background px-3 py-2 [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]">
      <div className="ml-[70px]" />
      <Select
        value={activeId ?? ''}
        onValueChange={(id) => void window.ea.profiles.setActive(id).then(refreshProfiles)}
      >
        <SelectTrigger className="w-36 border-0 bg-transparent shadow-none hover:bg-accent [-webkit-app-region:no-drag]">
          <SelectValue placeholder={t('selectProfile')} />
        </SelectTrigger>
        <SelectContent>
          {profiles.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}（{p.mode === 'local' ? t('modeLocal') : t('modeRemote')}）
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <GatewayBadge />
      <RpcBadge />
      <div className="flex-1" />
      <nav className="flex gap-1">
        <Button variant={tab === 'chat' ? 'secondary' : 'ghost'} size="icon" title={t('tabChat')} onClick={() => onTab('chat')}>
          <MessageSquare />
        </Button>
        <Button variant={tab === 'settings' ? 'secondary' : 'ghost'} size="icon" title={t('tabSettings')} onClick={() => onTab('settings')}>
          <Settings2 />
        </Button>
      </nav>
    </header>
  );
}

function GatewayBadge() {
  const t = useT();
  const gw = useStore((s) => s.gw);
  const isLocal = useStore((s) => s.profiles.find((p) => p.id === s.activeProfileId)?.mode === 'local');
  if (!isLocal || !gw) return null;
  if (gw.restarting)
    return (
      <Badge variant="warning">
        <Loader2 className="animate-spin" /> {t('gwRestarting')}
      </Badge>
    );
  // Nominal (running) is the common case — keep the header clean and surface a
  // badge only when something needs attention (stopped/crashed/restarting).
  if (gw.state === 'running') return null;
  if (gw.state === 'error') return <Badge variant="destructive">{t('gwCrashed')}</Badge>;
  return <Badge variant="outline">{t('gwStopped')}</Badge>;
}

function RpcBadge() {
  const t = useT();
  const rpc = useStore((s) => s.rpc);
  switch (rpc.phase) {
    case 'connected':
      return null; // clean header when connected; issues still show below

    case 'connecting':
    case 'reconnecting':
      return (
        <Badge variant="warning">
          <Loader2 className="animate-spin" /> {rpc.phase === 'connecting' ? t('rpcConnecting') : t('rpcReconnecting')}
        </Badge>
      );
    case 'gateway-restarting':
      return (
        <Badge variant="warning">
          <Loader2 className="animate-spin" /> {t('rpcWaitGateway')}
        </Badge>
      );
    case 'error':
      return (
        <Badge variant="destructive">
          {t('rpcFailed')}
          {rpc.errorCode === -32002 ? t('rpcBadKey') : ''}
        </Badge>
      );
    default:
      return <Badge variant="outline">{t('rpcIdle')}</Badge>;
  }
}

function Banners() {
  const t = useT();
  const gw = useStore((s) => s.gw);
  const rpc = useStore((s) => s.rpc);
  const update = useStore((s) => s.update);
  const info = useStore((s) => s.appInfo);
  const isLocal = useStore((s) => s.profiles.find((p) => p.id === s.activeProfileId)?.mode === 'local');
  const restart = (): void => void window.ea.gateway.restart();

  return (
    <div className="empty:hidden flex flex-col gap-1 px-3 py-1 empty:p-0">
      {isLocal && gw?.stale && (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertDescription className="flex-1">{t('configStale')}</AlertDescription>
          <Button size="sm" variant="outline" onClick={restart}>
            <RotateCw /> {t('restartNow')}
          </Button>
        </Alert>
      )}
      {isLocal && gw?.versionMismatch && (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertDescription className="flex-1">
            {t('versionMismatch', { running: gw.version ?? t('unknown'), bundled: gw.bundledVersion ?? '?' })}
          </AlertDescription>
          <Button size="sm" variant="outline" onClick={restart}>
            <RotateCw /> {t('restartGateway')}
          </Button>
        </Alert>
      )}
      {isLocal && gw?.state === 'error' && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription className="flex-1">
            {gw.autoRestart === 'fused' ? t('gwCrashFused') : t('gwCrashRetry')}
            {gw.detail && <pre className="mt-1 max-h-24 overflow-auto text-[10px]">{gw.detail}</pre>}
          </AlertDescription>
          <Button size="sm" variant="outline" onClick={restart}>
            {t('manualRestart')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void window.ea.gateway.openLogs()}>
            <ScrollText /> {t('openLogs')}
          </Button>
        </Alert>
      )}
      {rpc.phase === 'error' && rpc.errorCode === -32002 && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{t('badAccessKey')}</AlertDescription>
        </Alert>
      )}
      {update.phase === 'downloaded' && (
        <Alert variant="success">
          <Download />
          <AlertDescription className="flex-1">{t('updateDownloaded', { version: update.version ?? '' })}</AlertDescription>
          <Button size="sm" variant="outline" onClick={() => void window.ea.app.installUpdate()}>
            {t('restartToUpdate')}
          </Button>
        </Alert>
      )}
      {isLocal && info && !info.bundledGateway && (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertDescription>{t('noBundledGateway')}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
