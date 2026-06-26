import { useEffect, useState } from 'react';
import { fetchMe, fetchSessions, logout, type Me, type SessionSummary } from './api';
import { ChatView } from './ChatView';
import { LoginPage } from './components/LoginPage';
import { Sidebar } from './components/Sidebar';

interface ActiveThread {
  threadId: string;
  sessionId?: string;
}

function newThread(): ActiveThread {
  return { threadId: crypto.randomUUID() };
}

export function App(): React.ReactElement | null {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = loading
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [active, setActive] = useState<ActiveThread>(newThread);
  const [query, setQuery] = useState('');
  // Open by default on desktop, closed on mobile (it's an overlay drawer there).
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 768);

  function refreshMe(): void {
    fetchMe()
      .then(setMe)
      // `?demo` previews the UI without a running backend (see ChatView demo path).
      .catch(() => setMe(location.search.includes('demo') ? { accountId: 'demo@local', displayName: '演示用户' } : null));
  }
  function loadSessions(): void {
    fetchSessions().then(setSessions).catch(() => {});
  }

  // After a turn completes: refresh the list AND, for a brand-new thread that
  // just got persisted, adopt its sessionId so per-session controls (e.g. the
  // execution-mode selector) light up without needing a reopen from the sidebar.
  async function handleTurnDone(): Promise<void> {
    const list = await fetchSessions().catch(() => null);
    if (!list) return;
    setSessions(list);
    setActive((a) => (a.sessionId ? a : { ...a, sessionId: list.find((s) => s.threadId === a.threadId)?.sessionId }));
  }

  // After a delete: reload the list, and fall back to a fresh new-chat view when
  // the deleted session was the active one OR the list is now empty.
  async function handleDeleted(sessionId: string): Promise<void> {
    const remaining = await fetchSessions().catch(() => [] as SessionSummary[]);
    setSessions(remaining);
    if (active.sessionId === sessionId || remaining.length === 0) setActive(newThread());
  }

  useEffect(refreshMe, []);
  useEffect(() => {
    if (me) loadSessions();
  }, [me]);

  if (me === undefined) return null;
  if (me === null) return <LoginPage onDone={refreshMe} />;

  return (
    <div className="flex h-full w-full overflow-hidden">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        me={me}
        sessions={sessions}
        activeSessionId={active.sessionId}
        query={query}
        setQuery={setQuery}
        onNewChat={() => setActive(newThread())}
        onOpen={(s) => s.threadId && setActive({ threadId: s.threadId, sessionId: s.sessionId })}
        onRefresh={loadSessions}
        onDeleted={handleDeleted}
        onLogout={() => logout().then(() => setMe(null))}
      />

      <ChatView
        key={active.threadId}
        threadId={active.threadId}
        sessionId={active.sessionId}
        onTurnDone={handleTurnDone}
        onNewChat={() => setActive(newThread())}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
      />
    </div>
  );
}
