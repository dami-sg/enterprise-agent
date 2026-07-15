/**
 * Renderer i18n hook: resolves AppSettings.language and returns a `t` lookup.
 * Non-React code (store toasts / session names) uses `shared/i18n` directly.
 */
import { resolveLang, t as translate, type Lang, type MessageKey } from '../../../shared/i18n.js';
import { useStore } from '@/store';

export type { Lang, MessageKey };

/** Subscribe to settings.language so UI re-renders on switch. */
export function useT(): (key: MessageKey, vars?: Record<string, string | number>) => string {
  const language = useStore((s) => s.settings.language);
  const lang = resolveLang(language, navigator.language);
  return (key, vars) => translate(lang, key, vars);
}

export function useLang(): Lang {
  const language = useStore((s) => s.settings.language);
  return resolveLang(language, navigator.language);
}
