const SUGGESTIONS: { title: string; subtitle: string; prompt: string }[] = [
  { title: '解释一段代码', subtitle: '说明它的作用与边界情况', prompt: '解释这段代码的作用，并指出可能的边界情况。' },
  { title: '写一个正则表达式', subtitle: '匹配邮箱并附测试用例', prompt: '帮我写一个匹配邮箱的正则表达式，并给出几个测试用例。' },
  { title: '总结要点', subtitle: '把长文压缩成清单', prompt: '帮我把下面这段文字总结成要点清单：' },
  { title: '排查报错', subtitle: '给出原因与修复步骤', prompt: '这个报错怎么修？请给出可能的原因和修复步骤。' },
];

/** Animated greeting + suggested-action cards, shown when the thread is empty. */
export function Greeting({ onPick }: { onPick: (prompt: string) => void }): React.ReactElement {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-8">
      <div className="fade-up mb-8">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">你好 👋</h1>
        <p className="mt-1 text-3xl font-semibold tracking-tight text-muted-foreground sm:text-4xl">
          今天能帮你做点什么？
        </p>
        <p className="mt-4 text-sm text-muted-foreground">它会跨渠道记住你 —— Web、Telegram 同一个你（用 /memories 管理）。</p>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {SUGGESTIONS.map((s, i) => (
          <button
            key={s.title}
            onClick={() => onPick(s.prompt)}
            style={{ animationDelay: `${i * 60}ms` }}
            className="fade-up group rounded-xl border bg-card px-4 py-3.5 text-left transition-colors hover:bg-accent"
          >
            <div className="text-sm font-medium">{s.title}</div>
            <div className="mt-0.5 text-sm text-muted-foreground">{s.subtitle}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
