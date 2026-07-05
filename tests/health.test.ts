import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';

describe('server baseline', () => {
  it('GET /health renvoie ok', async () => {
    const app = buildServer({ queue: new FakeQueue() });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });
});
