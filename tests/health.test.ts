import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';

describe('server baseline : /health (readiness) + /live (liveness)', () => {
  it('sans checkReadiness (tests DB-free) : GET /health = 200 ok:true (contrat conservé)', async () => {
    const app = buildServer({ queue: new FakeQueue() });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  it('GET /live = 200 ok:true, même quand la readiness rejette (la liveness ne touche jamais la DB)', async () => {
    const app = buildServer({ queue: new FakeQueue(), checkReadiness: async () => { throw new Error('DB KO'); } });
    const res = await app.inject({ method: 'GET', url: '/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  it('checkReadiness qui résout -> GET /health = 200 ok:true', async () => {
    const app = buildServer({ queue: new FakeQueue(), checkReadiness: async () => { /* DB ok */ } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  it('checkReadiness qui rejette -> GET /health = 503 et ok:false (PAS un 500 du setErrorHandler)', async () => {
    const app = buildServer({ queue: new FakeQueue(), checkReadiness: async () => { throw new Error('pool saturé'); } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().ok).toBe(false);
    await app.close();
  });
});
