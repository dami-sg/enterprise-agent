import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

const base =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none ' +
  'placeholder:text-muted-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(base, 'h-9', className)} {...props} />,
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(base, 'resize-none leading-relaxed', className)} {...props} />
  ),
);
Textarea.displayName = 'Textarea';
