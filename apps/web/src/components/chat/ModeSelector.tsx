import { cn } from '../../lib/utils';
import { EXECUTION_MODES, type ExecutionMode } from '../../api';

/** Short labels + hover hints for each execution mode (agent §3.8). */
const MODE_LABEL: Record<ExecutionMode, string> = {
  ask: '询问',
  plan: '计划',
  auto: '自动',
  full: 'Full',
};

const MODE_HINT: Record<ExecutionMode, string> = {
  ask: '每个高危操作都询问（默认）',
  plan: '只读探索 → 提案计划 → 批准后执行',
  auto: 'AI 分类器逐条裁决，危险或不确定才询问',
  full: '⚡ 边界关闭：仅 提权 与 高危删除 询问，其余全部直接执行',
};

/**
 * Execution-mode picker for the active session (agent §3.8). A native <select>
 * so it stays accessible and keyboard-friendly. `full` is rendered in a warning
 * color because it is a broad safety relaxation.
 */
export function ModeSelector({
  mode,
  disabled,
  onChange,
}: {
  mode: ExecutionMode;
  disabled?: boolean;
  onChange: (mode: ExecutionMode) => void;
}): React.ReactElement {
  return (
    <select
      value={mode}
      disabled={disabled}
      title={MODE_HINT[mode]}
      onChange={(e) => onChange(e.target.value as ExecutionMode)}
      className={cn(
        'h-7 rounded-md border bg-background px-2 text-xs outline-none',
        'cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:ring-1 focus-visible:ring-ring',
        mode === 'full' ? 'border-destructive/50 text-destructive font-medium' : 'text-muted-foreground',
      )}
    >
      {EXECUTION_MODES.map((m) => (
        <option key={m} value={m}>
          {m === 'full' ? '⚡ ' : ''}
          {MODE_LABEL[m]}
        </option>
      ))}
    </select>
  );
}
