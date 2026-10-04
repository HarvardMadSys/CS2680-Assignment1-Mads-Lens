import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { checkLocalBoundary, isLoopbackHostname, isServableHostname } from '@/server/net/localOnly';

const boundary = {};
const check = (headers: { host?: string; origin?: string }) => checkLocalBoundary(headers, boundary);

describe('isLoopbackHostname', () => {
  it('accepts the machine own names for itself', () => {
    for (const name of ['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.2', '[::1]', '[::ffff:127.0.0.1]'])
      expect(isLoopbackHostname(name)).toBe(true);
  });

  it('refuses every name whose meaning someone else controls', () => {
    // The point of the rule: what a hostname resolves to is the attacker's choice, not ours.
    for (const name of ['example.com', 'localhost.evil.com', '127.0.0.1.nip.io', '0.0.0.0', '10.0.0.1', ''])
      expect(isLoopbackHostname(name)).toBe(false);
  });
});

describe('isServableHostname', () => {
  it('accepts names that address this machine directly', () => {
    for (const name of ['localhost', '127.0.0.1', '192.168.1.5', '10.0.0.1', '0.0.0.0', '[::1]', '[fe80::1]'])
      expect(isServableHostname(name)).toBe(true);
    expect(isServableHostname(hostname())).toBe(true);
  });

  it('accepts other names only when they are listed', () => {
    for (const name of [
      'example.com',
      'localhost.evil.com',
      '127.0.0.1.nip.io',
      '999.1.1.1',
      '[not-ipv6]',
      '',
    ])
      expect(isServableHostname(name)).toBe(false);
    expect(isServableHostname('console.lan', ['console.lan'])).toBe(true);
    expect(isServableHostname('Console.LAN', ['console.lan'])).toBe(true);
  });

  it('accepts any well-formed name when the list is `*`', () => {
    for (const name of [
      'console.example.org',
      'Mission.Example.ORG',
      'example.com.',
      'devbox',
      'rebind.example',
    ])
      expect(isServableHostname(name, ['*'])).toBe(true);
    expect(isServableHostname('mc.example.org', ['console.lan', '*'])).toBe(true);
    for (const name of ['', 'a/b', 'user@evil.com', 'a..b', '[not-ipv6]', 'two words'])
      expect(isServableHostname(name, ['*'])).toBe(false);
  });
});

describe('the request boundary', () => {
  it('serves a request from the console itself', () => {
    expect(check({ host: '127.0.0.1:8000', origin: 'http://127.0.0.1:8000' })).toEqual({ ok: true });
    expect(check({ host: 'localhost:8000', origin: 'http://localhost:8000' })).toEqual({ ok: true });
  });

  it('serves the console opened from another machine by IP address', () => {
    expect(check({ host: '192.168.1.5:8000', origin: 'http://192.168.1.5:8000' })).toEqual({ ok: true });
    expect(check({ host: '[fe80::1]:8000', origin: 'http://[fe80::1]:8000' })).toEqual({ ok: true });
    expect(check({ host: `${hostname()}:8000`, origin: `http://${hostname()}:8000` })).toEqual({ ok: true });
    expect(checkLocalBoundary({ host: 'console.lan:8000' }, { allowedHosts: ['console.lan'] })).toEqual({
      ok: true,
    });
  });

  it('serves the console through a port forward or proxy on another port', () => {
    // `ssh -L 3080:localhost:8000`, `docker run -p 3080:8000`: the browser dialled 3080, so Host
    // and Origin both name 3080, whatever port this server listens on.
    expect(check({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })).toEqual({ ok: true });
    expect(check({ host: 'localhost:9000' })).toEqual({ ok: true });
    // a proxy on the scheme's default port, which the browser leaves out of both headers
    expect(check({ host: 'localhost', origin: 'http://localhost' })).toEqual({ ok: true });
    expect(check({ host: '[::1]' })).toEqual({ ok: true });
  });

  it('serves any hostname when SUBAGENTS_AS_A_TEAM_ALLOWED_HOSTS is `*`, still only to its own pages', () => {
    const open = { allowedHosts: ['*'] };
    const own = { host: 'console.example.org:8000', origin: 'http://console.example.org:8000' };
    expect(checkLocalBoundary(own, open)).toEqual({ ok: true });
    expect(checkLocalBoundary({ host: 'mc.example.org' }, open)).toEqual({ ok: true });
    // `*` lifts the Host rule only: a page from anywhere else is still not this console
    for (const origin of ['http://evil.example', 'http://console.example.org:3080', 'null']) {
      const verdict = checkLocalBoundary({ host: own.host, origin }, open);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.status).toBe(403);
    }
    expect(checkLocalBoundary({ host: 'a/b:8000' }, open).ok).toBe(false);
  });

  it('still refuses a page on another local port', () => {
    // Not checking Host's port must not let a different local app's page drive the console: the
    // page's origin and the authority it is asking still have to agree, port included.
    for (const [host, origin] of [
      ['127.0.0.1:8000', 'http://127.0.0.1:3080'],
      ['127.0.0.1:3080', 'http://127.0.0.1:8000'],
      ['localhost', 'http://localhost:8000'],
    ]) {
      const verdict = check({ host, origin });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.status).toBe(403);
    }
  });

  it('refuses a page served from a different authority than the one it is asking', () => {
    for (const [host, origin] of [
      ['192.168.1.5:8000', 'http://192.168.1.6:8000'],
      ['192.168.1.5:8000', 'http://127.0.0.1:8000'],
      ['127.0.0.1:8000', 'http://192.168.1.5:8000'],
    ]) {
      const verdict = check({ host, origin });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.status).toBe(403);
    }
  });

  it('serves ordinary navigation and local tools, which send no Origin at all', () => {
    // A top-level GET in a browser, `curl`, an editor integration: the header is not a credential
    // and its absence is not a claim about anyone.
    expect(check({ host: '127.0.0.1:8000' })).toEqual({ ok: true });
  });

  /**
   * The readiness review's reproduction: a page on the open internet opening a WebSocket to the
   * operator's console. Loopback is not a boundary against a browser — the browser is already
   * inside it.
   */
  it('refuses a page that is not this console', () => {
    for (const origin of [
      'https://review.invalid',
      'http://evil.example',
      'http://127.0.0.1:4000',
      'https://127.0.0.1:8000',
      'http://localhost.evil.com:8000',
    ]) {
      const verdict = check({ host: '127.0.0.1:8000', origin });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.status).toBe(403);
    }
  });

  it('refuses an origin that names nobody, or nothing parseable', () => {
    // `null` is what a sandboxed iframe, a `file://` document, or a redirected cross-origin
    // request presents. It is not this console.
    for (const origin of ['null', 'not a url', '://', '']) {
      const verdict = check({ host: '127.0.0.1:8000', origin });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.status).toBe(403);
    }
  });

  /**
   * DNS rebinding: the attacker's own hostname, pointed at 127.0.0.1. The browser believes it is
   * same-origin and sends no cross-origin hints at all, so the Host header is the only place this
   * can be caught.
   */
  it('refuses a Host this server does not answer to', () => {
    for (const host of [
      'rebind.example:8000',
      'rebind.example:3080',
      'evil.com',
      'localhost.evil.com:8000',
    ]) {
      const verdict = check({ host });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.status).toBe(421);
    }
  });

  it('refuses a missing or malformed Host rather than guessing', () => {
    for (const headers of [
      {},
      { host: '' },
      { host: '[::1:8000' },
      { host: 'a:b:c' },
      { host: 'localhost:http' },
      { host: '127.0.0.1:65536' },
      { host: '[::1]:-1' },
    ])
      expect(check(headers).ok).toBe(false);
    // a repeated Host header is a smuggling shape, not an ambiguity to resolve
    expect(checkLocalBoundary({ host: ['127.0.0.1:8000', 'evil.com'] }, boundary).ok).toBe(false);
  });

  it('says why, in words that name the header', () => {
    const rebound = check({ host: 'rebind.example:8000' });
    expect(rebound.ok).toBe(false);
    if (!rebound.ok) expect(rebound.reason).toContain('loopback');
    const foreign = check({ host: '127.0.0.1:8000', origin: 'https://review.invalid' });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.reason).toContain('review.invalid');
  });
});
