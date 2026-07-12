/**
 * SSRF egress guard (agent §4). Verifies the scheme allowlist, the private/
 * loopback/link-local/metadata IP blocking (literal + DNS-resolved), and that
 * `safeFetch` re-checks every redirect hop. DNS is stubbed via the test seam so
 * these are deterministic and offline.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { assertSafeUrl, safeFetch, SsrfError, setSsrfLookup } from '../src/util/ssrf.js';

const PUBLIC = '93.184.216.34';

afterEach(() => setSsrfLookup(undefined));

describe('assertSafeUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeUrl('ftp://example.com/x')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeUrl('gopher://example.com')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects loopback / link-local / private / metadata IP literals', async () => {
    const blocked = [
      'http://127.0.0.1/',
      'http://0.0.0.0/',
      'http://169.254.169.254/latest/meta-data/', // cloud metadata
      'http://10.0.0.5/',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
      'http://100.64.0.1/', // CGNAT
      'http://[::1]/',
      'http://[fe80::1]/', // link-local v6
      'http://[fc00::1]/', // unique-local v6
      'http://[::ffff:10.0.0.1]/', // v4-mapped private
    ];
    for (const u of blocked) {
      await expect(assertSafeUrl(u), u).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it('accepts a public IP literal', async () => {
    await expect(assertSafeUrl(`http://${PUBLIC}/`)).resolves.toBeUndefined();
  });

  it('blocks a hostname that resolves to a private address', async () => {
    setSsrfLookup(async () => [{ address: '10.1.2.3' }]);
    await expect(assertSafeUrl('https://internal.corp/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('allows a hostname that resolves to a public address', async () => {
    setSsrfLookup(async () => [{ address: PUBLIC }]);
    await expect(assertSafeUrl('https://example.com/')).resolves.toBeUndefined();
  });

  it('blocks when ANY resolved address is private (split-horizon / rebinding)', async () => {
    setSsrfLookup(async () => [{ address: PUBLIC }, { address: '169.254.169.254' }]);
    await expect(assertSafeUrl('https://sneaky.example/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects an unresolvable host', async () => {
    setSsrfLookup(async () => {
      throw new Error('ENOTFOUND');
    });
    await expect(assertSafeUrl('https://nope.invalid/')).rejects.toBeInstanceOf(SsrfError);
  });
});

describe('safeFetch redirect revalidation', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('blocks a redirect whose target is a private/metadata address', async () => {
    setSsrfLookup(async () => [{ address: PUBLIC }]);
    globalThis.fetch = (async () =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })) as typeof fetch;
    await expect(safeFetch('https://example.com/', {})).rejects.toBeInstanceOf(SsrfError);
  });

  it('follows a safe redirect and returns the final response', async () => {
    setSsrfLookup(async () => [{ address: PUBLIC }]);
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      return n === 1
        ? new Response(null, { status: 302, headers: { location: 'https://example.com/final' } })
        : new Response('ok', { status: 200 });
    }) as typeof fetch;
    const res = await safeFetch('https://example.com/', {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('throws on a redirect loop past the hop cap', async () => {
    setSsrfLookup(async () => [{ address: PUBLIC }]);
    globalThis.fetch = (async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.com/again' } })) as typeof fetch;
    await expect(safeFetch('https://example.com/', {})).rejects.toBeInstanceOf(SsrfError);
  });

  it('refuses a redirect to a host outside the egress allowlist (open-redirect exfil)', async () => {
    setSsrfLookup(async () => [{ address: PUBLIC }]); // evil.com resolves public → SSRF guard alone allows it
    const seen: string[] = [];
    globalThis.fetch = (async (u: string) => {
      seen.push(u);
      return u.includes('evil.com')
        ? new Response('exfil', { status: 200 })
        : new Response(null, { status: 302, headers: { location: 'https://evil.com/collect' } });
    }) as unknown as typeof fetch;

    const isHostAllowed = (h: string): boolean => h === 'api.corp.com';
    await expect(
      safeFetch('https://api.corp.com/redirect', { method: 'POST', body: 'secret' }, { isHostAllowed }),
    ).rejects.toBeInstanceOf(SsrfError);
    // The request never reached evil.com — it was refused before the second fetch.
    expect(seen).toEqual(['https://api.corp.com/redirect']);
  });

  it('allows a redirect that stays within the egress allowlist', async () => {
    setSsrfLookup(async () => [{ address: PUBLIC }]);
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      return n === 1
        ? new Response(null, { status: 302, headers: { location: 'https://api.corp.com/final' } })
        : new Response('ok', { status: 200 });
    }) as typeof fetch;
    const res = await safeFetch('https://api.corp.com/start', {}, { isHostAllowed: (h) => h === 'api.corp.com' });
    expect(res.status).toBe(200);
  });
});
