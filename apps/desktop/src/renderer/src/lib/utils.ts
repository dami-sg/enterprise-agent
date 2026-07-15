import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Compact JSON preview for tool inputs/outputs. */
export function previewJson(value: unknown, max = 4000): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(value);
  }
}
