// tests/api-doc-endpoints.test.ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { ENDPOINTS, GROUPES_ENDPOINTS, cleEndpoint } from '../web/lib/api-doc-endpoints';
import { ANCRES_DEPLACEES, PAGES_DOC } from '../web/lib/doc-api-pages';
import { modulesDeRoutes } from '../src/server';
import { GardeUsageMemoire } from '../src/api/usage-guard.memoire';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import { gardesOuvertes } from './gardes';
import { cleApiDeTest } from './aide/cle-api';

/**
 * L'INDEX DES ENDPOINTS DE LA DOC EST L'API QUE LE SERVEUR MONTE (lot 2 de la refonte de la doc, 2026-09-25).
 *
 * 🔴 LA LISTE VIENT DU REGISTRE DU SERVEUR (`modulesDeRoutes`, entrée `v1`), montée pour de vrai dans Fastify :
 * ce que ce fichier compare, ce sont les routes enregistrées, pas un texte. Une route `/v1` ajoutée au serveur
 * sans la doc, ou documentée sans exister, le fait tomber. Et chaque droit annoncé est celui que la route exige :
 * une clé qui porte tous les AUTRES droits reçoit 403 `missing_scope`, une clé qui ne porte QUE celui-là passe la
 * garde (la suite, dépendances vides, peut échouer autrement : seul le verdict de la garde est lu).
 */

class FaussesCles implements ApiKeyLookup {
  private readonly parEmpreinte = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  ajouter(brute: string, rec: { id: string; tenantId: string; scopes: string[] }): this {
    this.parEmpreinte.set(sha256Hex(brute), rec);
    return this;
  }
  async findActiveByHash(hash: string) { return this.parEmpreinte.get(hash) ?? null; }
  async touchLastUsed(): Promise<void> {}
}

const DROITS = [...new Set(ENDPOINTS.map((e) => e.droit))];
const cleSans = (droit: string): string => cleApiDeTest(`doc_sans_${droit.replace(':', '_')}`);
const cleSeul = (droit: string): string => cleApiDeTest(`doc_seul_${droit.replace(':', '_')}`);
const UUID = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';

/** Le module `v1` du registre, monté seul, avec des services vides : seules ses routes et ses gardes comptent. */
async function monterV1() {
  const cles = new FaussesCles();
  for (const d of DROITS) {
    cles.ajouter(cleSans(d), { id: `sans-${d}`, tenantId: `t-sans-${d}`, scopes: DROITS.filter((x) => x !== d) });
    cles.ajouter(cleSeul(d), { id: `seul-${d}`, tenantId: `t-seul-${d}`, scopes: [d] });
  }
  const deps = { v1: { apiKeys: cles, contacts: {}, sends: {}, catalogues: {}, messages: {}, messagesRcs: {} } };
  const v1 = modulesDeRoutes(deps as never, new GardeUsageMemoire()).find((m) => m.nom === 'v1');
  if (!v1) throw new Error('le registre n’a plus d’entrée v1');
  const app = Fastify({ logger: false });
  const routes: string[] = [];
  app.addHook('onRoute', (r) => {
    for (const methode of [r.method].flat()) {
      if (methode !== 'HEAD' && r.url.startsWith('/v1/')) routes.push(`${methode} ${r.url.replace(/:(\w+)/g, '{$1}')}`);
    }
  });
  v1.monte(app, gardesOuvertes);
  await app.ready();
  return { app, routes };
}

describe('🔴 l’index des endpoints est l’API que le serveur monte', () => {
  it('douze entrées, sans doublon, chacune dans un groupe, avec son texte dans les deux langues', () => {
    expect(ENDPOINTS).toHaveLength(12);
    expect(new Set(ENDPOINTS.map(cleEndpoint)).size).toBe(ENDPOINTS.length);
    for (const e of ENDPOINTS) {
      expect(GROUPES_ENDPOINTS.map((g) => g.cle), cleEndpoint(e)).toContain(e.groupe);
      for (const texte of e.resume) expect(texte.trim(), cleEndpoint(e)).not.toBe('');
    }
  });

  it('chaque lien vise une ancre déclarée de sa page, et deux endpoints ne partagent pas une ancre', () => {
    for (const e of ENDPOINTS) {
      const page = PAGES_DOC.find((p) => p.cle === e.lien.page);
      expect(page, cleEndpoint(e)).toBeDefined();
      expect(page!.ancres as readonly string[], cleEndpoint(e)).toContain(e.lien.ancre);
    }
    expect(new Set(ENDPOINTS.map((e) => `${e.lien.page}#${e.lien.ancre}`)).size).toBe(ENDPOINTS.length);
  });

  it('une ancre déplacée n’existe plus sur sa page de départ (sinon le renvoi détournerait une ancre vivante)', () => {
    for (const [depart, table] of Object.entries(ANCRES_DEPLACEES)) {
      const vivantes = PAGES_DOC.find((p) => p.cle === depart)!.ancres as readonly string[];
      for (const ancre of Object.keys(table ?? {})) expect(vivantes, `${depart}#${ancre}`).not.toContain(ancre);
    }
  });

  it('🔴 méthodes et chemins : exactement les routes /v1 montées, dans les deux sens', async () => {
    const { app, routes } = await monterV1();
    expect(routes.length, 'garde de la garde : le module v1 doit monter des routes').toBeGreaterThan(0);
    expect([...new Set(routes)].sort()).toEqual(ENDPOINTS.map(cleEndpoint).sort());
    await app.close();
  });

  it.each(ENDPOINTS.map((e) => ({ cle: cleEndpoint(e), e })))('🔴 $cle : le droit annoncé est celui que la route exige', async ({ e }) => {
    const { app } = await monterV1();
    const url = e.chemin.replace(/\{\w+\}/g, UUID);
    const appel = (cle: string) => app.inject({
      method: e.methode, url, headers: { authorization: `Bearer ${cle}`, 'content-type': 'application/json' },
      ...(e.methode === 'GET' ? {} : { payload: '{}' }),
    });
    const sans = await appel(cleSans(e.droit));
    expect(sans.statusCode).toBe(403);
    expect(sans.json()).toMatchObject({ code: 'missing_scope' });
    const seul = await appel(cleSeul(e.droit));
    expect(seul.statusCode, `${cleEndpoint(e)} refuse une clé qui porte ${e.droit}`).not.toBe(403);
    expect(seul.statusCode).not.toBe(401);
    await app.close();
  });
});
