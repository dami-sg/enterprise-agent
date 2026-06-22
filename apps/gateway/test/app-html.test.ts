/**
 * Config-panel assembly smoke test (gateway §7). The page is composed from
 * per-section UI components; there's no browser test, so guard that the shell
 * stitches every component's markup + script into one well-formed document with
 * the element ids, handlers, and i18n keys the client code depends on.
 */
import { describe, it, expect } from 'vitest';
import { APP_HTML } from '../src/web/app-html.js';

describe('APP_HTML composition', () => {
  it('is a single HTML document with exactly one <script> and a boot line at the end', () => {
    expect(APP_HTML.startsWith('<!doctype html>')).toBe(true);
    expect(APP_HTML.trimEnd().endsWith('</html>')).toBe(true);
    expect(APP_HTML.split('<script>').length - 1).toBe(1);
    expect(APP_HTML.split('</script>').length - 1).toBe(1);
    const script = APP_HTML.slice(APP_HTML.indexOf('<script>'), APP_HTML.indexOf('</script>'));
    // Boot runs after every component registered its renderer/handlers.
    expect(script.lastIndexOf('applyLang();')).toBeGreaterThan(script.indexOf('RENDERERS'));
  });

  it('mounts every section card (the elements the client renders into)', () => {
    for (const id of ['status', 'gw-status', 'providers', 'channels', 'wx-qr', 'routes', 'toast', 'orch']) {
      expect(APP_HTML).toContain('id="' + id + '"');
    }
  });

  it('lays out the sidebar nav + five tabs', () => {
    for (const tab of ['status', 'models', 'channels', 'mcp', 'skills']) {
      expect(APP_HTML).toContain('data-tab-btn="' + tab + '"');
      expect(APP_HTML).toContain('data-tab="' + tab + '"');
    }
  });

  it('includes each component\'s handlers and the render registry', () => {
    for (const fn of [
      'function load(',
      'function showTab(',
      'RENDERERS.push(',
      'function addProvider(',
      'function saveChannel(',
      'function saveChannelPolicy(',
      'function weixinStart(',
      'function setVerbose(',
      'function applyPreset(',
      'function gwAction(',
      'function refreshGateway(',
      'function saveMcp(',
      'function mcpEdit(',
      'function onMcpTransport(',
      'function saveSkill(',
      'function uploadZip(',
      'function skillEdit(',
      'function skillToggle(',
    ]) {
      expect(APP_HTML).toContain(fn);
    }
  });

  it('carries the bilingual dictionary and the styles', () => {
    expect(APP_HTML).toContain("zh: {");
    expect(APP_HTML).toContain("en: {");
    expect(APP_HTML).toContain('Gateway 配置面板');
    expect(APP_HTML).toContain('.card {'); // styles injected
    expect(APP_HTML).not.toContain('${'); // every composed placeholder resolved
  });
});
