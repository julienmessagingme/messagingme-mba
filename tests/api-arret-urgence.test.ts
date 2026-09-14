import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import { cleApiDeTest } from './aide/cle-api';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';

/**
 * L'ARRÊT D'URGENCE D'UN ESPACE, sur la surface publique.
 *
 * 🔴 TRANCHÉ PAR JULIEN LE 2026-09-14 : étendre le verrou d'espace existant plutôt qu'en inventer un
 * second. Deux mesures ont décidé de la forme du travail :
 *
 *  1. `tenants.status = 'locked'` était LU dans `makeRequireAuth` (routes de SESSION), et nulle part dans
 *     `makeRequireApiKey` : il ne couvrait donc ni `/v1` ni `/mcp`. Un espace « suspendu » gardait son API ;
 *  2. il n'était ÉCRIT NULLE PART : aucune route, aucun script, aucun écran. Un crochet inerte, dont le
 *     commentaire d'origine disait lui-même qu'il attendait son heure.
 *
 * « Étendre le verrou » voulait donc dire DEUX gestes : le faire lire par la garde de clé, et créer le
 * moyen de le poser. Sans le second, la garde aurait été un interrupteur sans bouton.
 *
 * 🔴 ET LE VERROU N'ARRÊTE PAS LES CAMPAGNES DÉJÀ ENFILÉES (mesuré, écrit dans le runbook) : il ferme les
 * portes d'entrée, pas le travail en vol. Croire l'inverse le jour où on l'actionne, c'est regarder des
 * messages continuer de partir en pensant avoir coupé.
 */
class FauxCles implements ApiKeyLookup {
  constructor(private readonly brut: string, private readonly statut: string | undefined) {}
  async findActiveByHash(hash: string) {
    if (hash !== sha256Hex(this.brut)) return null;
    return { id: 'k1', tenantId: 't1', scopes: ['contacts:write'], ...(this.statut === undefined ? {} : { tenantStatus: this.statut }) };
  }
  async touchLastUsed() { /* sans objet ici */ }
}

const CLE = cleApiDeTest('espace_verrouille');
const entetes = { 'content-type': 'application/json', authorization: `Bearer ${CLE}` };

function monter(statut: string | undefined) {
  return buildServer({
    queue: new FakeQueue(),
    v1: {
      apiKeys: new FauxCles(CLE, statut),
      contacts: { upsertContacts: async () => [{ index: 0, status: 'created' as const, contactId: 'c0' }] },
      mcp: {} as never,
    },
  });
}

describe('un espace VERROUILLÉ n’a plus d’API', () => {
  it('🔴 `/v1` rend 403 avec un code lisible, pas 401 ni 500', async () => {
    // 403 et non 401 : la clé est bonne, c'est l'espace qui est suspendu. Un 401 enverrait l'intégrateur
    // régénérer une clé parfaitement valide, et le code `tenant_locked` est ce qui permet à son client de
    // distinguer les deux sans lire le message.
    const server = monter('locked');
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', headers: entetes, payload: { phone: '+33612345678' } });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('tenant_locked');
    await server.close();
  });

  it('🔴 `/mcp` aussi : les deux portes se ferment ensemble', async () => {
    // Elles partagent la même autorité, donc fermer l'une en laissant l'autre reviendrait à ne rien
    // fermer du tout. C'est le motif « une capacité câblée sur un consommateur sur deux ».
    const server = monter('locked');
    const res = await server.inject({ method: 'POST', url: '/mcp', headers: entetes, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('🔴 un espace ACTIF passe, et un espace dont le statut est inconnu aussi', async () => {
    /**
     * ⚠️ ON NE BLOQUE QUE SUR `locked` EXPLICITE, exactement comme la garde de session. Bloquer sur « tout
     * ce qui n'est pas active » fermerait l'API de tous les espaces le jour où un statut est ajouté, et
     * l'`undefined` (un faux de test, un serveur plus ancien) doit rester passant pour la même raison.
     *
     * 🔴 `trial` EST DANS CETTE LISTE PARCE QU'UNE MUTATION L'A EXIGÉ. Le cas d'origine n'exerçait que
     * `active` et `undefined` : remplacer la garde par « tout ce qui n'est pas active » le laissait donc
     * PASSER, alors que ce changement aurait coupé l'API de tous les espaces en essai. Un test qui ne
     * contient pas le cas qu'il annonce protège la phrase, pas le comportement.
     *
     * ⚠️ Les trois statuts viennent du CHECK de la migration 0026 : `trial`, `active`, `locked`.
     */
    for (const statut of ['active', 'trial', undefined]) {
      const server = monter(statut);
      const res = await server.inject({ method: 'POST', url: '/v1/contacts', headers: entetes, payload: { phone: '+33612345678' } });
      expect(res.statusCode, `statut « ${String(statut)} » aurait dû passer`).toBe(200);
      await server.close();
    }
  });
});

describe('le geste qui pose et retire le verrou', () => {
  const opsMuet = {
    getTenantOverview: async () => [],
    getGlobalDaily: async () => [],
    getQueueLoad: async () => [],
  };
  const UUID = '4169c753-311a-43bb-a334-d8a2cb7caf6f';

  function monterOps(over: Partial<{ verrouillerEspace: (t: string, v: boolean, note: string) => Promise<boolean> }> = {}) {
    const appels: Array<{ tenantId: string; verrouille: boolean; note: string }> = [];
    const server = buildServer({
      queue: new FakeQueue(),
      opsToken: 'jeton-ops',
      ops: {
        ...opsMuet,
        verrouillerEspace: over.verrouillerEspace ?? (async (tenantId, verrouille, note) => {
          appels.push({ tenantId, verrouille, note });
          return true;
        }),
      },
    });
    return { server, appels };
  }
  const ops = { 'content-type': 'application/json', 'x-ops-token': 'jeton-ops' };

  it('🔴 il pose le verrou, et il exige une NOTE', async () => {
    // La note est la même exigence que sur le rechargement de crédit : une écriture d'exploitation sans
    // trace de qui l'a faite et pourquoi ne se relit pas six mois plus tard.
    const { server, appels } = monterOps();
    const sansNote = await server.inject({ method: 'POST', url: `/ops/verrou/${UUID}`, headers: ops, payload: { verrouille: true } });
    expect(sansNote.statusCode).toBe(400);

    const res = await server.inject({ method: 'POST', url: `/ops/verrou/${UUID}`, headers: ops, payload: { verrouille: true, note: 'impayé de septembre' } });
    expect(res.statusCode).toBe(200);
    expect(appels).toEqual([{ tenantId: UUID, verrouille: true, note: 'impayé de septembre' }]);
    await server.close();
  });

  it('🔴 il le RETIRE aussi : un arrêt d’urgence qu’on ne peut pas lever est une panne', async () => {
    const { server, appels } = monterOps();
    await server.inject({ method: 'POST', url: `/ops/verrou/${UUID}`, headers: ops, payload: { verrouille: false, note: 'paiement reçu' } });
    expect(appels[0]).toMatchObject({ verrouille: false });
    await server.close();
  });

  it('🔴 sans le jeton d’exploitation, rien ne bouge', async () => {
    const { server, appels } = monterOps();
    const res = await server.inject({ method: 'POST', url: `/ops/verrou/${UUID}`, headers: { 'content-type': 'application/json' }, payload: { verrouille: true, note: 'tentative' } });
    expect(res.statusCode).toBe(401);
    expect(appels).toEqual([]);
    await server.close();
  });

  it('un espace inconnu rend 404, pas 500', async () => {
    // Le 500 serait remplacé par la page Cloudflare : l'exploitant ne saurait pas s'il a mal tapé
    // l'identifiant ou si le verrou a échoué.
    const { server } = monterOps({ verrouillerEspace: async () => false });
    const res = await server.inject({ method: 'POST', url: `/ops/verrou/${UUID}`, headers: ops, payload: { verrouille: true, note: 'espace fantôme' } });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('un identifiant qui n’est pas un UUID rend 404 sans toucher à la base', async () => {
    const { server, appels } = monterOps();
    const res = await server.inject({ method: 'POST', url: '/ops/verrou/pas-un-uuid', headers: ops, payload: { verrouille: true, note: 'saisie' } });
    expect(res.statusCode).toBe(404);
    expect(appels).toEqual([]);
    await server.close();
  });
});
