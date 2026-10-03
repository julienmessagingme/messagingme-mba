import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerOauth, type OauthRouteDeps } from '../src/http/oauth';
import { registerOauthConsentement, type OauthConsentementRouteDeps } from '../src/http/oauth-consentement';
import { DEMANDE_EXPIREE } from '../src/oauth/autoriser';
import { DROITS_OAUTH } from '../src/oauth/metadonnees';
import type { CompteurDebit } from '../src/db/debit';
import * as ecran from '../web/lib/oauth';

/**
 * LA CONSOLE ET L'OAUTH DE L'API, DES DEUX CÔTÉS (lot 2b du plan `2026-10-03-oauth-mcp.md`).
 *
 * `web/` n'importe jamais `src/` : le code d'une demande expirée et les chemins sont RECOPIÉS dans `web/lib/oauth.ts`.
 * Chaque dérive a un symptôme qu'aucun compilateur ne voit : un code renommé fait lire une demande expirée comme une
 * panne (« Réessayer » sur une demande morte) ; un chemin qui diverge rend un 404 au clic « Autoriser » ; un droit
 * ajouté au serveur serait accordé sans que la page de consentement l'annonce.
 */

// Le socle HTTP de la console est remplacé (`vi.mock` passe avant les imports) : ce test ne touche aucun réseau, il
// note ce que `request` reçoit. Le reste du module (`ApiError`, `BASE`) reste le vrai.
const appels = vi.hoisted((): Array<{ path: string; method: string }> => []);
vi.mock('../web/lib/http', async (original) => ({
  ...(await original<typeof import('../web/lib/http')>()),
  request: (path: string, init?: RequestInit) => {
    appels.push({ path, method: (init?.method ?? 'GET').toUpperCase() });
    return Promise.resolve({ autorisations: [] });
  },
}));

describe('ce que la page lit dans les réponses de l’API', () => {
  it('🔴 le code d’une demande expirée est celui que le serveur rend', () => {
    expect(ecran.CODE_DEMANDE_EXPIREE).toBe(DEMANDE_EXPIREE.code);
  });

  it('🔴 chaque droit que le serveur sait accorder, la page sait l’annoncer', () => {
    for (const droit of DROITS_OAUTH) {
      expect(Object.values(ecran.capacitesAnnoncees([droit])).some(Boolean), `la page n’annonce rien pour ${droit}`).toBe(true);
    }
  });
});

describe('🔴 chaque appel de la console vise une route que le serveur monte', () => {
  it('méthode et chemin, un par un', async () => {
    const TENANT = 'tenant-x';
    const ID = 'autorisation-y';
    appels.length = 0;
    await ecran.lireDemande('d');
    await ecran.continuerAvecGoogle('d', 'j');
    await ecran.autoriserParGoogle('d', 'c', TENANT);
    await ecran.autoriserParSession(TENANT, 'd');
    await ecran.listerAutorisations(TENANT);
    await ecran.revoquerAutorisation(TENANT, ID);
    const demandes = appels.map((a) => `${a.method} ${a.path.replace(TENANT, ':tenantId').replace(ID, ':id')}`);

    const app = Fastify({ logger: false });
    const montees = new Set<string>();
    app.addHook('onRoute', (r) => {
      for (const m of [r.method].flat()) montees.add(`${m} ${r.path}`);
    });
    // Rien n'est appelé : on ne fait que monter, pour lire les adresses.
    registerOauth(app, { appUrl: 'https://console.test' } as OauthRouteDeps, 'https://api.test', {} as CompteurDebit);
    registerOauthConsentement(app, {} as OauthConsentementRouteDeps, async () => {}, 'https://api.test');
    await app.ready();
    await app.close();

    expect(demandes).toHaveLength(6);
    expect(demandes.filter((d) => !montees.has(d))).toEqual([]);
  });
});
