import { createServer, type Server } from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { IncomingMessage } from 'node:http';
import { hostname } from 'node:os';
import { Bonjour } from 'bonjour-service';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { MAX_MESSAGE_BYTES, VERSION, parseRequest, type Pairing, type Response } from './protocol.js';
import { isPrivateAddress, lanAddresses, remoteLock, RemoteIdentity } from './security.js';
import type { RemoteDomain } from './domain.js';

export type RemoteHost = { address: string; pairing: Pairing; close(): Promise<void> };
export async function startRemoteHost(options: { baseDir: string; address: string; port?: number; domain: RemoteDomain; advertise?: boolean; allowTestAddress?: boolean }): Promise<RemoteHost> {
  if (!isPrivateAddress(options.address) || (!options.allowTestAddress && !lanAddresses().includes(options.address))) throw new Error('Choose a private IPv4 address assigned to this computer.');
  const release = await remoteLock(options.baseDir);
  let server: Server | undefined;
  let bonjour: Bonjour | undefined;
  let sockets: WebSocketServer | undefined;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const identity = await RemoteIdentity.open(options.baseDir);
    const rates = new Map<string, { at: number; count: number }>();
    const allowed = (request: IncomingMessage): boolean => {
      const remote = request.socket.remoteAddress ?? '';
      if (!isPrivateAddress(remote)) return false;
      const now = Date.now();
      // Bounded map; no untrusted address or request contents are logged.
      for (const [key, value] of rates) if (now - value.at > 60000) rates.delete(key);
      const rate = rates.get(remote) ?? { at: now, count: 0 };
      rates.set(remote, rate);
      return ++rate.count <= 240;
    };
    server = createServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: false, sessionTimeout: 1 }, async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      if (!allowed(request)) { response.writeHead(403).end(); return; }
      if (request.method !== 'POST' || request.url !== '/pair') { response.writeHead(401).end(); return; }
      if (Number(request.headers['content-length']) > 4096) { response.writeHead(413).end(); return; }
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 4096) { response.writeHead(413).end(); request.destroy(); return; }
          chunks.push(chunk);
        }
        const parsed = z.object({ v: z.literal(VERSION), token: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1).max(80) }).strict().parse(JSON.parse(Buffer.concat(chunks).toString()));
        const device = await identity.enroll(request.socket as TLSSocket, parsed.token, parsed.name);
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ v: VERSION, deviceId: device.id }));
      } catch { response.writeHead(401).end(); }
    });
    server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxConnections = 16;
    sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false, handleProtocols: protocols => protocols.has('pace-remote-v1') ? 'pace-remote-v1' : false });
    const clients = new Map<WebSocket, { id: string; socket: TLSSocket; pending: number; alive: boolean }>();
    server.on('upgrade', (request, socket, head) => {
      const id = identity.authorized(request.socket as TLSSocket);
      if (!allowed(request) || !id || request.url !== '/remote' || request.headers['sec-websocket-protocol'] !== 'pace-remote-v1' || request.headers.origin) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
      }
      sockets!.handleUpgrade(request, socket, head, ws => {
        const client = { id, socket: request.socket as TLSSocket, pending: 0, alive: true };
        clients.set(ws, client);
        ws.on('error', () => {});
        ws.on('close', () => clients.delete(ws));
        ws.on('pong', () => { client.alive = true; });
        ws.on('message', async (message, binary) => {
          if (binary || ++client.pending > 8 || !allowed(request) || identity.authorized(client.socket) !== id) { ws.close(1008); return; }
          let requestId = '00000000-0000-4000-8000-000000000000';
          try {
            const request = parseRequest(JSON.parse(message.toString()));
            requestId = request.id;
            let data: unknown;
            if (request.method === 'devices.list') data = identity.list();
            else if (request.method === 'devices.revoke') {
              await identity.revoke(request.params.deviceId);
              // Invalidate all established connections, including TLS-resumed sessions.
              for (const [peer, info] of clients) if (info.id === request.params.deviceId) peer.close(1008, 'Device revoked');
              data = { revoked: true };
            } else data = await options.domain.handle(request, id);
            send(ws, { v: VERSION, id: requestId, ok: true, data });
          } catch (error) {
            const message = error instanceof z.ZodError || error instanceof SyntaxError ? 'Invalid request or protocol version' : error instanceof Error ? error.message : 'Operation failed';
            send(ws, { v: VERSION, id: requestId, ok: false, error: { code: error instanceof z.ZodError ? 'INVALID_REQUEST' : 'CONFLICT', message: message.slice(0, 500) } });
          } finally { client.pending--; }
        });
      });
    });
    function send(ws: WebSocket, value: Response | unknown): void {
      const data = JSON.stringify(value);
      if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES) {
        const response = value as Response;
        if ('id' in response) ws.send(JSON.stringify({ v: VERSION, id: response.id, ok: false, error: { code: 'LIMIT', message: 'Response exceeds 1 MiB; request a smaller page.' } }));
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > MAX_MESSAGE_BYTES * 2) ws.close(1013, 'Refresh snapshot after reconnect');
        else ws.send(data);
      }
    }
    unsubscribe = options.domain.subscribe(event => {
      for (const [ws, client] of clients) if (identity.authorized(client.socket) === client.id) send(ws, event);
    });
    heartbeat = setInterval(() => {
      for (const [ws, client] of clients) {
        if (!client.alive || identity.authorized(client.socket) !== client.id) { ws.terminate(); continue; }
        client.alive = false; ws.ping();
      }
    }, 20000);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(options.port ?? 8443, options.address, () => { server!.removeListener('error', reject); resolve(); });
    });
    const port = (server.address() as { port: number }).port;
    if (options.advertise !== false) {
      bonjour = new Bonjour(undefined, () => {});
      bonjour.publish({ name: `Pace ${hostname()}`, type: 'pace-remote', protocol: 'tcp', port, host: hostname(), txt: { v: String(VERSION) } });
    }
    let closed = false;
    return {
      address: `https://${options.address}:${port}`,
      pairing: { v: VERSION, address: `https://${options.address}:${port}`, fingerprint: identity.hostFingerprint, ...identity.newCode() },
      async close() {
        if (closed) return; closed = true;
        identity.invalidateCode(); unsubscribe?.(); if (heartbeat) clearInterval(heartbeat);
        bonjour?.unpublishAll(); bonjour?.destroy();
        for (const ws of clients.keys()) ws.terminate();
        sockets?.close();
        await options.domain.close();
        await new Promise<void>(resolve => server!.close(() => resolve()));
        await release();
      },
    };
  } catch (error) {
    unsubscribe?.(); if (heartbeat) clearInterval(heartbeat);
    bonjour?.destroy(); for (const ws of sockets?.clients ?? []) ws.terminate(); sockets?.close(); server?.close();
    await release(); throw error;
  }
}
