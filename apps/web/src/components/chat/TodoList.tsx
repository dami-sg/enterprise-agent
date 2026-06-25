import { Check, Circle, ListChecks, Loader } from 'lucide-react';
import type { Todo, TodosData } from '../../api';
import { cn } from '../../lib/utils';

/**
 * The agent's live task list (agent §2.3). Streamed as `data-todos` and reconciled
 * in place, so it updates as the orchestrator checks items off mid-run.
 */
export function TodoList({ data }: { data: TodosData }): React.ReactElement | null {
  const todos = data.todos ?? [];
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === 'completed').length;

  return (
    <div className="rounded-xl border bg-muted/40 p-3.5 text-sm">
      <div className="mb-2 flex items-center gap-2 font-medium">
        <ListChecks className="size-4 text-muted-foreground" />
        <span>任务列表</span>
        <span className="ml-auto text-xs font-normal text-muted-foreground">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="space-y-1.5">
        {todos.map((t) => (
          <TodoRow key={t.id} todo={t} />
        ))}
      </ul>
    </div>
  );
}

function TodoRow({ todo }: { todo: Todo }): React.ReactElement {
  const icon =
    todo.status === 'completed' ? (
      <Check className="size-3.5 text-foreground" />
    ) : todo.status === 'in_progress' ? (
      <Loader className="size-3.5 animate-spin text-sky-500" />
    ) : (
      <Circle className="size-3.5 text-muted-foreground" />
    );
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span
        className={cn(
          todo.status === 'completed' && 'text-muted-foreground line-through',
          todo.status === 'in_progress' && 'font-medium',
        )}
      >
        {todo.content}
      </span>
    </li>
  );
}
