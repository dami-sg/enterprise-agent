import { LogOut, MessagesSquare, Moon, Pencil, Search, SquarePen, Sun, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { deleteSession, renameSession, type Me, type SessionSummary } from '../api';
import { useTheme } from '../lib/theme';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function Sidebar({
  open,
  onClose,
  me,
  sessions,
  activeSessionId,
  query,
  setQuery,
  onNewChat,
  onOpen,
  onRefresh,
  onDeleted,
  onLogout,
}: {
  open: boolean;
  onClose: () => void;
  me: Me;
  sessions: SessionSummary[];
  activeSessionId?: string;
  query: string;
  setQuery: (v: string) => void;
  onNewChat: () => void;
  onOpen: (s: SessionSummary) => void;
  onRefresh: () => void;
  onDeleted: (sessionId: string) => void;
  onLogout: () => void;
}): React.ReactElement {
  const { theme, toggle } = useTheme();
  const q = query.trim().toLowerCase();
  const shown = q ? sessions.filter((s) => (s.name || '').toLowerCase().includes(q)) : sessions;

  // On mobile the sidebar is an overlay drawer — selecting/creating closes it.
  function closeIfMobile(): void {
    if (window.matchMedia('(max-width: 767px)').matches) onClose();
  }

  return (
    <>
      {/* Mobile backdrop (md+: never shown — the rail is in-flow). */}
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-40 bg-black/50 transition-opacity duration-200 md:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <aside
        className={cn(
          'z-50 flex h-full shrink-0 flex-col overflow-hidden border-r bg-sidebar text-sidebar-foreground',
          // Mobile: fixed overlay drawer that slides in from the left.
          'fixed inset-y-0 left-0 w-72 shadow-xl transition-transform duration-200 ease-in-out',
          open ? 'translate-x-0' : '-translate-x-full',
          // Desktop: in-flow rail that collapses by width (no transform, no shadow).
          'md:static md:translate-x-0 md:shadow-none md:transition-[width]',
          open ? 'md:w-72' : 'md:w-0',
        )}
      >
      {/* Fixed inner width so content doesn't reflow while the rail animates. */}
      <div className="flex h-full w-72 flex-col">
        <div className="flex h-12 items-center gap-2 px-3">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <MessagesSquare className="size-4" />
          </div>
          <span className="flex-1 truncate text-sm font-semibold">Enterprise Agent</span>
          <Button
            variant="ghost"
            size="iconSm"
            onClick={() => {
              onNewChat();
              closeIfMobile();
            }}
            title="新建会话"
            className="text-muted-foreground"
          >
            <SquarePen className="size-[18px]" />
          </Button>
        </div>

        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索会话…"
              className="h-9 bg-sidebar-accent pl-8"
            />
          </div>
        </div>

        <div className="px-4 pb-1 pt-1 text-xs font-medium text-muted-foreground">会话</div>
        <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
          {sessions.length === 0 ? (
            <EmptyHint text="还没有会话，点 ✎ 开始" />
          ) : shown.length === 0 ? (
            <EmptyHint text="无匹配会话" />
          ) : (
            shown.map((s) => (
              <SessionRow
                key={s.sessionId}
                session={s}
                active={activeSessionId === s.sessionId}
                onOpen={() => {
                  onOpen(s);
                  closeIfMobile();
                }}
                onRenamed={onRefresh}
                onDeleted={() => onDeleted(s.sessionId)}
              />
            ))
          )}
        </div>

        <div className="flex items-center gap-2 border-t p-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-medium uppercase">
            {(me.displayName || me.accountId || '?').slice(0, 1)}
          </div>
          <span className="min-w-0 flex-1 truncate text-sm" title={me.accountId}>
            {me.displayName || me.accountId}
          </span>
          <Button variant="ghost" size="iconSm" onClick={toggle} title={theme === 'dark' ? '切换到亮色' : '切换到暗色'} className="text-muted-foreground">
            {theme === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
          </Button>
          <Button variant="ghost" size="iconSm" onClick={onLogout} title="退出登录" className="text-muted-foreground">
            <LogOut className="size-[18px]" />
          </Button>
        </div>
      </div>
      </aside>
    </>
  );
}

function EmptyHint({ text }: { text: string }): React.ReactElement {
  return <div className="px-2 py-3 text-sm text-muted-foreground">{text}</div>;
}

function SessionRow({
  session,
  active,
  onOpen,
  onRenamed,
  onDeleted,
}: {
  session: SessionSummary;
  active: boolean;
  onOpen: () => void;
  onRenamed: () => void;
  onDeleted: () => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(session.name);

  async function commit(e: FormEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    const next = name.trim();
    setEditing(false);
    if (next && next !== session.name) {
      await renameSession(session.sessionId, next).catch(() => {});
      onRenamed();
    }
  }

  async function remove(e: React.MouseEvent): Promise<void> {
    e.stopPropagation();
    if (!confirm(`删除会话「${session.name || '未命名'}」?`)) return;
    await deleteSession(session.sessionId).catch(() => {});
    onDeleted();
  }

  if (editing) {
    return (
      <form className="px-0.5" onSubmit={commit}>
        <Input
          autoFocus
          className="h-8 px-2 text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
        />
      </form>
    );
  }

  return (
    <div
      className={cn(
        'group flex cursor-pointer items-center gap-1 rounded-md px-2 py-2 text-sm transition-colors hover:bg-sidebar-accent',
        active && 'bg-sidebar-accent font-medium',
      )}
      title={session.sessionId}
      onClick={onOpen}
    >
      <span className="flex-1 truncate">{session.name || '(未命名)'}</span>
      <span className="hidden shrink-0 gap-0.5 group-hover:inline-flex">
        <button
          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
          title="重命名"
          onClick={(e) => {
            e.stopPropagation();
            setName(session.name);
            setEditing(true);
          }}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-destructive"
          title="删除"
          onClick={remove}
        >
          <Trash2 className="size-3.5" />
        </button>
      </span>
    </div>
  );
}
