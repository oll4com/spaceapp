import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import { CDP_SEND_TIMEOUT_MS, CdpClient } from '../src/browser-sessions.js';

describe('CdpClient.send', () => {
  it('rejects a command Chrome never answers instead of holding its pane forever (13/11 pane:PAmSde500V-P)', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    // The peer answers only Browser.getVersion, as a Chrome whose page hangs would.
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const { id, method } = JSON.parse(String(raw)) as { id: number; method: string };
      if (method === 'Browser.getVersion') socket.send(JSON.stringify({ id, result: { product: 'Chrome' } }));
    }));
    const { port } = server.address() as { port: number };
    const client = await CdpClient.connect(`ws://127.0.0.1:${port}`, 1_000, 50);
    try {
      expect(CDP_SEND_TIMEOUT_MS).toBeGreaterThan(30_000);
      await expect(client.send('Runtime.evaluate', { expression: '1' })).rejects.toThrow(/Runtime.evaluate timed out after 50ms/);
      await expect(client.send('Browser.getVersion')).resolves.toEqual({ product: 'Chrome' });
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
