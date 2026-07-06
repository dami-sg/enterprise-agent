import { MessagesSquare, Send } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { fetchAuthConfig, telegramLogin, type AuthConfig } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';

const TELEGRAM_LOGIN_SRC = 'https://oauth.telegram.org/js/telegram-login.js?5';

type TelegramLoginApi = {
  auth: (
    options: { client_id: number; scope?: Array<'profile' | 'phone' | 'write'>; lang?: string },
    cb: (data: { id_token?: string; error?: string }) => void,
  ) => void;
};

function getTelegramLogin(): TelegramLoginApi | undefined {
  return (window as unknown as { Telegram?: { Login?: TelegramLoginApi } }).Telegram?.Login;
}

function loadTelegramLogin(): Promise<TelegramLoginApi> {
  const existing = getTelegramLogin();
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const current = document.querySelector<HTMLScriptElement>(`script[src="${TELEGRAM_LOGIN_SRC}"]`);
    const script = current ?? document.createElement('script');
    script.async = true;
    script.src = TELEGRAM_LOGIN_SRC;
    script.addEventListener('load', () => {
      const login = getTelegramLogin();
      if (login) resolve(login);
      else reject(new Error('telegram login library unavailable'));
    });
    script.addEventListener('error', () => reject(new Error('telegram login library failed to load')));
    if (!current) document.head.appendChild(script);
  });
}

/**
 * Login screen (web-app §3/§6). Offers whatever auth methods the backend
 * advertises via `/api/auth/config`: modern Telegram OIDC, the legacy Telegram
 * Login Widget, and a raw session-token field for local development. `onDone`
 * re-fetches `me` to enter the app.
 */
export function LoginPage({ onDone }: { onDone: () => void }): React.ReactElement {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [tok, setTok] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [telegramBusy, setTelegramBusy] = useState(false);
  const tgRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchAuthConfig()
      .then(setConfig)
      .catch(() => setConfig({ telegramClientId: null, telegramBot: null, devSessionLogin: true }));
  }, []);

  // Modern Telegram OIDC: load Telegram's Web Login library, then POST the
  // returned id_token for server-side verification and session minting.
  async function telegramOidc(): Promise<void> {
    if (!config?.telegramClientId) {
      alert('Telegram 登录未配置。');
      return;
    }
    const clientId = Number(config.telegramClientId);
    if (!Number.isFinite(clientId) || clientId <= 0) {
      alert('Telegram 登录配置无效。');
      return;
    }
    setTelegramBusy(true);
    try {
      const TG = await loadTelegramLogin();
      TG.auth({ client_id: clientId, scope: ['profile', 'write'] }, (d) => {
        if (d?.id_token) void telegramLogin(d.id_token).then(onDone).catch(() => {});
        else if (d?.error) alert(`Telegram 登录失败：${d.error}`);
      });
    } catch {
      alert('Telegram 登录库加载失败，请稍后重试。');
    } finally {
      setTelegramBusy(false);
    }
  }

  // Mount the Telegram Login Widget (works on a configured public domain).
  useEffect(() => {
    if (!config?.telegramBot || !tgRef.current) return;
    (window as unknown as { onTelegramAuth?: (u: unknown) => void }).onTelegramAuth = (user) => {
      void fetch('/api/auth/telegram', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(user),
      }).then((r) => r.ok && onDone());
    };
    const s = document.createElement('script');
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.async = true;
    s.setAttribute('data-telegram-login', config.telegramBot);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-onauth', 'onTelegramAuth(user)');
    s.setAttribute('data-request-access', 'write');
    tgRef.current.appendChild(s);
    const node = tgRef.current;
    return () => node.replaceChildren();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.telegramBot]);

  function tokenLogin(e: FormEvent): void {
    e.preventDefault();
    if (!tok.trim()) return;
    // Add `Secure` over HTTPS so the session token isn't sent in cleartext if
    // this dev login is ever reached over a non-loopback https deploy.
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `ea_session=${tok.trim()}; path=/; SameSite=Lax${secure}`;
    onDone();
  }

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <MessagesSquare className="size-6" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">登录 Enterprise Agent</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">跨渠道记住你 —— Web、Telegram 同一个你。</p>
        </div>

        <div className="flex flex-col gap-5 rounded-2xl border bg-card p-6 shadow-sm">
          <Button variant="outline" className="w-full" onClick={() => void telegramOidc()} disabled={telegramBusy}>
            <Send className="size-4" />
            {telegramBusy ? '正在打开 Telegram...' : '用 Telegram 登录'}
          </Button>

          {config?.telegramBot && (
            <div>
              <Label>用 Telegram 登录（旧版 Widget）</Label>
              <div ref={tgRef} className="mt-2" />
            </div>
          )}

          {/* Raw session-token login is a dev affordance (CLI-minted sessions); only
              surface it when the backend advertises dev session login. */}
          {config?.devSessionLogin && (
            <div className="text-xs text-muted-foreground">
              <button className="underline-offset-2 hover:underline hover:text-foreground" onClick={() => setShowToken((v) => !v)}>
                {showToken ? '收起' : '用会话令牌登录（开发）'}
              </button>
              {showToken && (
                <form className="mt-2 flex gap-2" onSubmit={tokenLogin}>
                  <Input value={tok} onChange={(e) => setTok(e.target.value)} placeholder="ea_session 令牌" />
                  <Button type="submit" variant="outline">
                    登录
                  </Button>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{children}</div>;
}
