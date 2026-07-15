/**
 * Settings (desktop-app §3/§6): exactly two native sections — Connection and App —
 * plus the Gateway config link row that opens the panel window (auto-logged-in).
 */
import { useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import type { LanguageSetting, ProfileInput, ThemeSetting } from '../../../shared/ipc.js';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Checkbox, Label } from '@/components/ui/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '@/lib/i18n';
import { activeProfile, refreshProfiles, useStore } from '@/store';

export function Settings() {
  const isLocal = useStore((s) => s.profiles.find((p) => p.id === s.activeProfileId)?.mode === 'local');
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        <ProfilesCard />
        <AppCard />
        <GatewayConfigCard isLocal={isLocal} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function ProfilesCard() {
  const t = useT();
  const profiles = useStore((s) => s.profiles);
  const [editing, setEditing] = useState<Partial<ProfileInput & { token: string }> | null>(null);
  const [error, setError] = useState<string>();

  const save = async (): Promise<void> => {
    const e = editing;
    if (!e?.name || !e.mode) return;
    try {
      const saved = await window.ea.profiles.upsert({
        id: e.id ?? '',
        name: e.name,
        mode: e.mode,
        root: e.root || undefined,
        rpcPort: e.rpcPort || undefined,
        panelPort: e.panelPort || undefined,
        url: e.url || undefined,
      });
      if (e.mode === 'remote' && e.token) await window.ea.profiles.setToken(saved.id, e.token);
      setEditing(null);
      setError(undefined);
      await refreshProfiles();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('connTitle')}</CardTitle>
        <CardDescription>{t('connHint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {profiles.map((p) => (
          <div key={p.id} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">{p.name}</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {p.mode === 'local' ? (p.root ?? '~/.enterprise-agent') : p.url}
                {p.mode === 'remote' && (p.hasToken ? t('tokenSaved') : t('tokenMissing'))}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setEditing({ ...p, token: '' })}>
              {t('edit')}
            </Button>
            {profiles.length > 1 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void window.ea.profiles.remove(p.id).then(refreshProfiles)}
              >
                {t('remove')}
              </Button>
            )}
          </div>
        ))}
        <Button variant="outline" className="border-dashed" onClick={() => setEditing({ mode: 'remote', name: '' })}>
          {t('addConnection')}
        </Button>

        {editing && (
          <div className="space-y-2.5 rounded-md border bg-background/40 p-3">
            <Label>
              {t('name')}
              <Input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Label>
            <Label>
              {t('mode')}
              <Select
                value={editing.mode}
                onValueChange={(v) => setEditing({ ...editing, mode: v as 'local' | 'remote' })}
              >
                <SelectTrigger className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">{t('modeLocalOpt')}</SelectItem>
                  <SelectItem value="remote">{t('modeRemoteOpt')}</SelectItem>
                </SelectContent>
              </Select>
            </Label>
            {editing.mode === 'local' && (
              <>
                <Label>
                  {t('dataRoot')}
                  <Input
                    placeholder="~/.enterprise-agent"
                    value={editing.root ?? ''}
                    onChange={(e) => setEditing({ ...editing, root: e.target.value })}
                  />
                </Label>
                <div className="flex gap-2.5">
                  <Label className="flex-1">
                    {t('rpcPort')}
                    <Input
                      type="number"
                      placeholder="7320"
                      value={editing.rpcPort ?? ''}
                      onChange={(e) => setEditing({ ...editing, rpcPort: Number(e.target.value) || undefined })}
                    />
                  </Label>
                  <Label className="flex-1">
                    {t('panelPort')}
                    <Input
                      type="number"
                      placeholder="7317"
                      value={editing.panelPort ?? ''}
                      onChange={(e) => setEditing({ ...editing, panelPort: Number(e.target.value) || undefined })}
                    />
                  </Label>
                </div>
              </>
            )}
            {editing.mode === 'remote' && (
              <>
                <Label>
                  URL
                  <Input
                    placeholder="wss://host:7320/rpc"
                    value={editing.url ?? ''}
                    onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                  />
                </Label>
                <Label>
                  {t('accessKey')}
                  <Input
                    type="password"
                    placeholder={t('accessKeyPh')}
                    value={editing.token ?? ''}
                    onChange={(e) => setEditing({ ...editing, token: e.target.value })}
                  />
                </Label>
              </>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex gap-2">
              <Button onClick={() => void save()}>{t('save')}</Button>
              <Button variant="outline" onClick={() => setEditing(null)}>
                {t('cancel')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
function AppCard() {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.update);
  const info = useStore((s) => s.appInfo);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('appTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs">{t('themeLabel')}</span>
          <Select
            value={settings.theme}
            onValueChange={(v) =>
              void window.ea.settings
                .update({ theme: v as ThemeSetting })
                .then((next) => useStore.setState({ settings: next }))
            }
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t('themeSystem')}</SelectItem>
              <SelectItem value="light">{t('themeLight')}</SelectItem>
              <SelectItem value="dark">{t('themeDark')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs">{t('langLabel')}</span>
          <Select
            value={settings.language}
            onValueChange={(v) =>
              void window.ea.settings
                .update({ language: v as LanguageSetting })
                .then((next) => useStore.setState({ settings: next }))
            }
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t('langSystem')}</SelectItem>
              <SelectItem value="zh">{t('langZh')}</SelectItem>
              <SelectItem value="en">{t('langEn')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Label className="cursor-pointer text-foreground">
          <Checkbox
            checked={settings.stopGatewayOnQuit}
            onCheckedChange={(v) =>
              void window.ea.settings
                .update({ stopGatewayOnQuit: v === true })
                .then((next) => useStore.setState({ settings: next }))
            }
          />
          {t('stopOnQuit')}
        </Label>
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[11px] text-muted-foreground">
            {t('appMeta', {
              app: info?.appVersion ?? '?',
              electron: info?.electron ?? '?',
              gateway: info?.bundledGateway ?? '?',
            })}
          </span>
          <Button variant="outline" size="sm" onClick={() => void window.ea.app.checkUpdate()}>
            {update.phase === 'checking' && <Loader2 className="animate-spin" />}
            {t('checkUpdate')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
function GatewayConfigCard({ isLocal }: { isLocal: boolean }) {
  const t = useT();
  const [opening, setOpening] = useState(false);
  const [err, setErr] = useState<string>();
  const open = async (): Promise<void> => {
    setOpening(true);
    setErr(undefined);
    try {
      await window.ea.panel.open();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setOpening(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('gwConfigTitle')}</CardTitle>
        <CardDescription>{isLocal ? t('gwConfigLocal') : t('gwConfigRemote')}</CardDescription>
      </CardHeader>
      {isLocal && (
        <CardContent className="space-y-2">
          <Button onClick={() => void open()} disabled={opening}>
            {opening ? <Loader2 className="animate-spin" /> : <ExternalLink />}
            {t('openGwConfig')}
          </Button>
          {err && (
            <Alert variant="destructive">
              <AlertDescription>{t('openFailed', { error: err })}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export { activeProfile };
