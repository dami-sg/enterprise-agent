import { MessagesSquare } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { fetchAuthConfig, googleMockLogin, telegramLogin, type AuthConfig } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';

/**
 * Login screen (web-app §3/§6). Offers whatever auth methods the backend
 * advertises via `/api/auth/config`: modern Telegram OIDC, the legacy Telegram
 * Login Widget, a dev-only Google email mock, and a raw session-token field for
 * local development. `onDone` re-fetches `me` to enter the app.
 */
export function LoginPage({ onDone }: { onDone: () => void }): React.ReactElement {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [email, setEmail] = useState('');
  const [tok, setTok] = useState('');
  const [showToken, setShowToken] = useState(false);
  const tgRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchAuthConfig()
      .then(setConfig)
      .catch(() => setConfig({ telegramClientId: null, telegramBot: null, googleMock: true }));
  }, []);

  // Modern Telegram OIDC: the operator embeds Telegram's OIDC library (per the
  // BotFather "Web Login" snippet); we call it and POST the returned id_token.
  function telegramOidc(): void {
    const TG = (
      window as unknown as { Telegram?: { Login?: { auth: (o: unknown, cb: (d: { id_token?: string }) => void) => void } } }
    ).Telegram?.Login;
    if (!TG || !config?.telegramClientId) {
      alert('Telegram 登录库未加载。请按 Telegram「Web Login」提供的代码片段在 index.html 引入 OIDC 库。');
      return;
    }
    TG.auth({ client_id: config.telegramClientId, request_access: ['write'] }, (d) => {
      if (d?.id_token) void telegramLogin(d.id_token).then(onDone).catch(() => {});
    });
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

  function googleLogin(e: FormEvent): void {
    e.preventDefault();
    if (!email.trim()) return;
    void googleMockLogin(email.trim()).then(onDone).catch(() => {});
  }
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
          {config?.telegramClientId && (
            <Button variant="outline" className="w-full" onClick={telegramOidc}>
              ✈ 用 Telegram 登录
            </Button>
          )}

          {config?.telegramBot && (
            <div>
              <Label>用 Telegram 登录（旧版 Widget）</Label>
              <div ref={tgRef} className="mt-2" />
            </div>
          )}

          {config?.googleMock && (
            <form className="flex flex-col gap-2" onSubmit={googleLogin}>
              <Label>用 Google 登录（开发 mock）</Label>
              <div className="flex gap-2">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                <Button type="submit">登录</Button>
              </div>
            </form>
          )}

          {/* Raw session-token login is a dev affordance (CLI-minted sessions); only
              surface it when the backend advertises dev auth, never on a public deploy. */}
          {config?.googleMock && (
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
