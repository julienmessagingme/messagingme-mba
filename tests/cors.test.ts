import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import type { ServerDeps } from '../src/server';
import { FakeQueue } from '../src/queue/fake';

/**
 * LE CORS DE L'API (préparation de la bascule Vercel, 2026-09-03).
 *
 * 🔴 Il n'existe QUE parce que le front part sur son propre nom. Tant que le navigateur appelle la même
 * origine que l'API, le CORS n'a aucun rôle, et poser ses en-têtes ouvrirait une porte pour rien.
 *
 * Les tests qui comptent ici sont ceux du REFUS. Un CORS trop large ne casse rien, ne lève aucune alerte, et
 * autorise n'importe quel site à faire faire des requêtes au navigateur d'un client connecté. C'est le genre
 * de réglage dont on ne découvre l'erreur que le jour où quelqu'un s'en sert.
 */
const base: ServerDeps = { queue: new FakeQueue(), verifyToken: 'v', appSecret: 's' };

describe('CORS : la liste blanche', () => {
  it('🔴 SANS origine configurée, AUCUN en-tête CORS n’est posé', () => {
    // Le défaut, et le comportement d'avant la bascule. Le front servi par le même hôte n'a besoin de rien :
    // une porte qu'on n'ouvre pas est une porte qu'on n'a pas à surveiller.
    const app = buildServer(base);
    return app.inject({ method: 'GET', url: '/live', headers: { origin: 'https://exemple.test' } })
      .then((res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        return app.close();
      });
  });

  it('une origine INSCRITE est autorisée', async () => {
    const app = buildServer({ ...base, corsOrigins: ['https://engageme.messagingme.app'] });
    const res = await app.inject({
      method: 'GET', url: '/live',
      headers: { origin: 'https://engageme.messagingme.app' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://engageme.messagingme.app');
    await app.close();
  });

  it('🔴 une origine NON inscrite n’est pas autorisée', async () => {
    // Le test qui porte la garantie. Sans lui, un CORS qui renverrait l'origine reçue quelle qu'elle soit
    // passerait le test précédent sans que personne ne s'en aperçoive.
    const app = buildServer({ ...base, corsOrigins: ['https://engageme.messagingme.app'] });
    const res = await app.inject({
      method: 'GET', url: '/live',
      headers: { origin: 'https://site-hostile.test' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('🔴 JAMAIS de credentials : la session voyage en Bearer, pas en cookie', async () => {
    // Le piège classique de cette migration. Il n'y a AUCUN CSRF possible aujourd'hui, précisément parce que
    // rien n'est en cookie. Activer les credentials en créerait un de toutes pièces, pour un besoin qui
    // n'existe pas.
    const app = buildServer({ ...base, corsOrigins: ['https://engageme.messagingme.app'] });
    const res = await app.inject({
      method: 'GET', url: '/live',
      headers: { origin: 'https://engageme.messagingme.app' },
    });
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    await app.close();
  });

  it('la requête préalable autorise les en-têtes que le front pose vraiment', async () => {
    // `authorization` porte la session, `x-ops-token` l'autorité d'exploitation. En oublier un rendrait tout
    // un écran muet depuis le nouveau front, avec une erreur de navigateur difficile à relier à sa cause.
    const app = buildServer({ ...base, corsOrigins: ['https://engageme.messagingme.app'] });
    const res = await app.inject({
      method: 'OPTIONS', url: '/live',
      headers: {
        origin: 'https://engageme.messagingme.app',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,x-ops-token',
      },
    });
    const autorises = String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    expect(autorises).toContain('authorization');
    expect(autorises).toContain('x-ops-token');
    expect(String(res.headers['access-control-allow-methods'] ?? '')).toContain('PATCH');
    await app.close();
  });
});

describe('CORS : les en-têtes de plafond doivent être LISIBLES par la console', () => {
  it('🔴 expose retry-after et x-ratelimit-*, sinon le front ne peut pas les lire', async () => {
    /**
     * Depuis la bascule, la console est sur `engageme.messagingme.app` et l'API sur `api.messagingme.app` :
     * les réponses sont CROSS-ORIGIN. Un navigateur ne laisse alors JavaScript lire qu'une petite liste
     * d'en-têtes sûrs, et `retry-after` n'en fait pas partie. Sans `exposedHeaders`, l'en-tête part bien sur
     * le réseau, il s'affiche dans l'onglet Réseau, et le code du front ne peut simplement pas le voir.
     *
     * Le symptôme serait donc « le plafond marche, mais la console ne sait jamais dire combien de temps
     * attendre » : le genre de défaut qu'on impute au front alors qu'il vient de l'API.
     */
    const app = buildServer({ ...base, corsOrigins: ['https://engageme.messagingme.app'] });
    const res = await app.inject({
      method: 'GET', url: '/live',
      headers: { origin: 'https://engageme.messagingme.app' },
    });
    const exposes = String(res.headers['access-control-expose-headers'] ?? '').toLowerCase();
    for (const h of ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
      expect(exposes).toContain(h);
    }
    await app.close();
  });
});
