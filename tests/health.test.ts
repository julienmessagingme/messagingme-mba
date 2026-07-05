import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';

describe('server baseline', () => {
  it('GET /health renvoie ok', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  it('GET /webhooks/meta répond au handshake avec le challenge', async () => {
    const app = buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=x&hub.challenge=42',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('42');
    await app.close();
  });

  it('POST /webhooks/meta ACK immédiat', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'POST', url: '/webhooks/meta', payload: {} });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
