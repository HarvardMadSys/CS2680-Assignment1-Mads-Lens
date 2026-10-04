import { createServer, get, type Server } from 'node:http';
import { connect, createServer as createTcpServer, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadConfig } from '@/server/config';
import { type Db, openDb } from '@/server/db';
import * as repo from '@/server/db/repo';
import { checkLocalBoundary } from '@/server/net/localOnly';
import { Hub } from '@/server/ws/hub';

/**
 * The boundary as `server.ts` actually applies it: in front of the request handler and in front of
 * the upgrade, with the same decision for both. The pure rule is covered in `local-only.test.ts`;
 * this is about it really being there, on both entry points, in the shapes a browser produces.
 */

let server: Server;
let hub: Hub;
let db: Db;
let port: number;

beforeAll(async () => {
  ({ db } = openDb(':memory:'));
  repo.createLane(db, { id: 'lane', name: 'L', cwd: '/tmp', permission: 'allowlist', createdAt: 1 });
  hub = new Hub({ db, flushMs: 5 });
  const srv = createServer((req, res) => {
    const verdict = checkLocalBoundary(req.headers, {});
    if (!verdict.ok) {
      res.writeHead(verdict.status, { 'content-type': 'text/plain' });
      res.end(verdict.reason);
      return;
    }
    res.writeHead(200);
    res.end('served');
  });
  srv.on('upgrade', (req, socket, head) => {
    const verdict = checkLocalBoundary(req.headers, {});
    if (!verdict.ok) {
      socket.end(`HTTP/1.1 ${verdict.status} Forbidden\r\nConnection: close\r\n\r\n`);
      return;
    }
    if (new URL(req.url ?? '/', 'http://localhost').pathname === '/ws') hub.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  server = srv;
  port = addr.port;
});

afterAll(async () => {
  await hub.close();
  await new Promise<void>((r) => server.close(() => r()));
});

function request(headers: Record<string, string>, via = port): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port: via, path: '/', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

function upgrade(origin?: string, via = port): Promise<{ opened: boolean; error?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${via}/ws`, origin === undefined ? {} : { origin });
    ws.on('open', () => {
      ws.close();
      resolve({ opened: true });
    });
    ws.on('error', (err) => resolve({ opened: false, error: err.message }));
  });
}

describe('the local boundary at the real entry points', () => {
  it('serves the console to itself over HTTP', async () => {
    expect(await request({ origin: `http://127.0.0.1:${port}` })).toMatchObject({ status: 200 });
    // ordinary navigation and non-browser tools send no Origin
    expect(await request({})).toMatchObject({ status: 200 });
  });

  it("serves the console opened by this machine's IP address", async () => {
    // What a browser on another machine sends: the address it typed, as Host and as Origin.
    const host = `192.0.2.10:${port}`;
    expect(await request({ host, origin: `http://${host}` })).toMatchObject({ status: 200 });
    expect(await request({ host, origin: `http://192.0.2.11:${port}` })).toMatchObject({ status: 403 });
  });

  it('serves the console through a port forward to another port', async () => {
    // `ssh -L 3080:localhost:8000`, `docker run -p 3080:8000`: the bytes are relayed untouched, so
    // Host and Origin name the port the browser dialled, not the one this server listens on.
    const sockets = new Set<Socket>();
    const forward = createTcpServer((client) => {
      const upstream = connect(port, '127.0.0.1');
      sockets.add(client).add(upstream);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((r) => forward.listen(0, '127.0.0.1', () => r()));
    const addr = forward.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    const via = addr.port;
    try {
      expect(await request({ origin: `http://127.0.0.1:${via}` }, via)).toMatchObject({ status: 200 });
      expect(await upgrade(`http://127.0.0.1:${via}`, via)).toMatchObject({ opened: true });
      // a page served from the server's own port is another origin than the forwarded console
      expect(await upgrade(`http://127.0.0.1:${port}`, via)).toMatchObject({ opened: false });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => forward.close(() => r()));
    }
  });

  it('refuses a foreign page over HTTP', async () => {
    const res = await request({ origin: 'https://review.invalid' });
    expect(res.status).toBe(403);
    expect(res.body).toContain('review.invalid');
  });

  it('refuses a rebound Host over HTTP', async () => {
    // The browser believes this is same-origin, so nothing but the Host header can catch it.
    expect(await request({ host: `rebind.example:${port}` })).toMatchObject({ status: 421 });
  });

  /** The readiness review's reproduction: this exact upgrade was accepted before. */
  it('refuses a foreign page over the WebSocket', async () => {
    const foreign = await upgrade('https://review.invalid');
    expect(foreign.opened).toBe(false);
    expect(foreign.error).toMatch(/403/);
  });

  it('still opens the console own socket', async () => {
    expect(await upgrade(`http://127.0.0.1:${port}`)).toMatchObject({ opened: true });
    // and a local tool with no Origin at all
    expect(await upgrade()).toMatchObject({ opened: true });
  });
});

describe('binding', () => {
  it('listens on all interfaces by default, and anywhere HOST says', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv, '/app').host).toBe('0.0.0.0');
    for (const HOST of ['127.0.0.1', 'localhost', '::', '192.168.1.5'])
      expect(loadConfig({ HOST } as unknown as NodeJS.ProcessEnv, '/app').host).toBe(HOST);
  });

  it('reads extra allowed hostnames from SUBAGENTS_AS_A_TEAM_ALLOWED_HOSTS', () => {
    const env = {
      SUBAGENTS_AS_A_TEAM_ALLOWED_HOSTS: ' Console.LAN, mc.internal ,',
    } as unknown as NodeJS.ProcessEnv;
    expect(loadConfig(env, '/app').allowedHosts).toEqual(['console.lan', 'mc.internal']);
    expect(loadConfig({} as NodeJS.ProcessEnv, '/app').allowedHosts).toEqual([]);
    const any = { SUBAGENTS_AS_A_TEAM_ALLOWED_HOSTS: ' * ' } as unknown as NodeJS.ProcessEnv;
    expect(loadConfig(any, '/app').allowedHosts).toEqual(['*']);
  });
});
