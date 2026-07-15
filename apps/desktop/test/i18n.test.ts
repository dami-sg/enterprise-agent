/**
 * shared/i18n: resolveLang maps AppSettings.language to zh/en; t interpolates
 * `{var}` placeholders. Mirrors the gateway panel bilingual dictionary pattern.
 */
import { describe, expect, it } from 'vitest';
import { resolveLang, t } from '../src/shared/i18n.js';

describe('resolveLang', () => {
  it('honours explicit zh / en', () => {
    expect(resolveLang('zh', 'en-US')).toBe('zh');
    expect(resolveLang('en', 'zh-CN')).toBe('en');
  });

  it('follows OS locale when set to system', () => {
    expect(resolveLang('system', 'zh-CN')).toBe('zh');
    expect(resolveLang('system', 'zh-Hans-CN')).toBe('zh');
    expect(resolveLang('system', 'en-US')).toBe('en');
    expect(resolveLang('system', 'ja-JP')).toBe('en');
  });
});

describe('t', () => {
  it('looks up by language and interpolates vars', () => {
    expect(t('zh', 'tabChat')).toBe('会话');
    expect(t('en', 'tabChat')).toBe('Chat');
    expect(t('en', 'gwRunning', { pid: 42 })).toBe('Gateway running · PID 42');
    expect(t('zh', 'deleteSessionConfirm', { name: 'foo' })).toContain('foo');
  });
});
