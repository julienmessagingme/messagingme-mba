import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';

/**
 * Les identifiants que Meta rend pour une consigne ou un message interactif de son agent font 106 caractères
 * (`pfbid…`, mesuré le 2026-10-08). Le routeur de Fastify refuse par défaut un paramètre d'URL de plus de 100
 * caractères, en 414 et SANS en-tête CORS : la console n'y voyait qu'un « Failed to fetch », et ni modifier ni
 * supprimer une consigne ou un message interactif n'arrivait jusqu'à la route.
 */
describe('un paramètre d’URL de la longueur d’un identifiant de Meta', () => {
  const ID_META = `pfbid03u6k5b${'a'.repeat(88)}qMbfhl`;

  it('🔴 atteint la route au lieu de rendre 414', async () => {
    expect(ID_META.length).toBe(106);
    const app = buildServer({ queue: new FakeQueue() });
    app.get('/essai-parametre/:id', async (req) => ({ longueur: (req.params as { id: string }).id.length }));
    const res = await app.inject({ method: 'GET', url: `/essai-parametre/${ID_META}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ longueur: 106 });
    await app.close();
  });

  it('garde une borne : un paramètre démesuré reste refusé', async () => {
    const app = buildServer({ queue: new FakeQueue() });
    app.get('/essai-parametre/:id', async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: `/essai-parametre/${'a'.repeat(600)}` });
    expect(res.statusCode).toBe(414);
    await app.close();
  });
});
