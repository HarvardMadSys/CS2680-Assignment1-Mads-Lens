import { hostname, networkInterfaces } from 'node:os';
import type { NextConfig } from 'next';

/**
 * Hosts allowed to load Next's dev-only resources (`/_next/*`, the HMR socket) in `pnpm dev`.
 * Next allows only `localhost` by default, which breaks the page when it is opened as
 * `http://<machine-ip>:8000` from another machine. The server's own request boundary
 * (`src/server/net/localOnly.ts`) already requires same-origin requests; this lets Next agree.
 */
function devOrigins(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .flatMap((a) => (a && a.family === 'IPv4' ? [a.address] : []));
  const machine = hostname().toLowerCase();
  const extra = (process.env.SUBAGENTS_AS_A_TEAM_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase());
  const names = machine ? [machine, `${machine}.local`] : [];
  return [...new Set([...addresses, ...names, ...extra])].filter((h) => h.length > 0);
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['better-sqlite3', 'ws'],
  allowedDevOrigins: devOrigins(),
};

export default nextConfig;
