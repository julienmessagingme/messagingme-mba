import { beforeAll, describe, expect, it } from 'vitest';
import type { EmailIdentity, UserAuthStore } from '../src/auth/store';
import { signSession } from '../src/auth/token';
import { refus } from '../src/lib/issue';
import type { PublicationMba } from '../src/mba/orchestration-publication';
import type { Geste } from '../src/mba/publication';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';

/** Adaptateur HTTP de la publication : autorité, portée et traduction fidèle des issues métier. */
const TENANT = 't1';
const SECRET = 'test-secret';
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const GESTE: Geste = { type: 'connecteur_creer', nom: 'EngageMe' };

let adminTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: TENANT, role: 'admin' }, SECRET);
});
const h = () => ({ headers: { authorization: `Bearer ${adminTok}` } });

function monter(over: Partial<PublicationMba> = {}) {
  const apercus: string[] = [];
  const publications: Array<{ tenantId: string; acteurId: string | null }> = [];
  const publication: PublicationMba = {
    apercevoir: async (tenantId) => {
      apercus.push(tenantId);
      return { ok: true, valeur: { gestes: [GESTE], phoneNumberId: 'pn1' } };
    },
    publier: async (tenantId, acteurId) => {
      publications.push({ tenantId, acteurId });
      return { ok: true, valeur: { faits: [GESTE] } };
    },
    ...over,
  };
  const app = buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    mbaPublication: publication,
  });
  return { app, apercus, publications };
}

describe('les routes de publication Meta', () => {
  it('refusent GET et POST sans jeton avant d’appeler la façade', async () => {
    const f = monter();
    for (const method of ['GET', 'POST'] as const) {
      const res = await f.app.inject({ method, url: `/tenants/${TENANT}/mba-publication` });
      expect(res.statusCode).toBe(401);
    }
    expect(f.apercus).toEqual([]);
    expect(f.publications).toEqual([]);
  });

  it('GET transmet l’espace et rend l’aperçu', async () => {
    const f = monter();
    const res = await f.app.inject({ method: 'GET', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ gestes: [GESTE], phoneNumberId: 'pn1' });
    expect(f.apercus).toEqual([TENANT]);
  });

  it('POST transmet l’espace et l’administrateur puis rend les gestes faits', async () => {
    const f = monter();
    const res = await f.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ faits: [GESTE] });
    expect(f.publications).toEqual([{ tenantId: TENANT, acteurId: 'u1' }]);
  });

  it('traduit les refus explicables en 409 avec leurs détails', async () => {
    const f = monter({
      apercevoir: async () => refus(409, 'adresse publique absente'),
      publier: async () => refus(409, 'publication interrompue', { faits: [GESTE] }),
    });
    const get = await f.app.inject({ method: 'GET', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(get.statusCode).toBe(409);
    expect(get.json()).toEqual({ error: 'adresse publique absente' });
    const post = await f.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(post.statusCode).toBe(409);
    expect(post.json()).toEqual({ error: 'publication interrompue', faits: [GESTE] });
  });
});
