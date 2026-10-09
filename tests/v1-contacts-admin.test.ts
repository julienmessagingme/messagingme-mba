import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { sha256Hex } from '../src/lib/signature';
import { GardeUsageMemoire } from './aide/usage';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import { cleApiDeTest, aucunJetonOauth } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';
import type { UserFieldDef } from '../src/crm/types';

/**
 * LES CONTACTS COMPLETS PAR L'API (lot 13, domaine 5, livraison A) : les champs personnalisés et la suppression RGPD,
 * sur les fonctions de la console (`creerChamp`, `effacerContacts`). Ici, ce que la route ajoute : les droits,
 * l'isolation (une fiche d'un autre espace est inconnue, sans consommer la limite), la limite du jour tout ou rien,
 * l'audit, et le retrait chez Meta APRÈS la réponse.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed(): Promise<void> {}
}

const ADMIN = cleApiDeTest('admin-contacts');
const LECTEUR = cleApiDeTest('lecteur-contacts');
const ECRIVAIN = cleApiDeTest('ecrivain-contacts');
const FICHE_T1 = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';
const FICHE_T2 = '7a3d9c10-2e4b-4f6a-b8c1-0d9e8f7a6b5c';

function monter(o: { quota?: number | null } = {}) {
  const champs = new Map<string, UserFieldDef[]>([['t1', [{ key: 'numero_commande', label: 'Numéro de commande', type: 'text' }]]]);
  const fiches = new Map<string, string>([[FICHE_T1, 't1'], [FICHE_T2, 't2']]);
  const traces = { purges: [] as string[][], retraits: [] as string[], consommes: [] as number[], audit: [] as Array<{ action: string; detail: unknown }> };
  let restant = o.quota === undefined ? null : o.quota;
  const usage = new GardeUsageMemoire();
  const keys = new FakeApiKeys()
    .add(ADMIN, { id: 'k1', tenantId: 't1', scopes: ['contacts:admin', 'contacts:read'] })
    .add(LECTEUR, { id: 'k2', tenantId: 't1', scopes: ['contacts:read'] })
    .add(ECRIVAIN, { id: 'k3', tenantId: 't1', scopes: ['contacts:write', 'contacts:read', 'sends:create', 'webhooks:write'] });
  const server = buildServer({
    queue: new FakeQueue(),
    usage,
    v1: {
      apiKeys: keys, oauth: aucunJetonOauth, contacts: contactsV1Muets(),
      contactsAdmin: {
        champs: {
          list: async (t) => champs.get(t) ?? [],
          create: async (t, def) => {
            const l = champs.get(t) ?? [];
            if (l.some((c) => c.key === def.key)) return 'exists';
            champs.set(t, [...l, def]);
            return 'created';
          },
        },
        contacts: {
          contactIdsForTarget: async (t, cible) => ('ids' in cible ? cible.ids.filter((id) => fiches.get(id) === t) : []),
          purgeMany: async (t, ids) => {
            traces.purges.push([...ids]);
            for (const id of ids) fiches.delete(id);
            return { purges: ids.length, conversations: 1, messages: 4, analyses: 1, listeAgent: [{ tenantId: t, waId: '33600000001' }] as never };
          },
        },
        suppressionsDuJour: {
          consommer: async (_t, n) => {
            traces.consommes.push(n);
            if (restant === null) return { ok: true };
            if (restant < n) return { ok: false, max: o.quota! };
            restant -= n;
            return { ok: true };
          },
        },
        listeDeLAgent: { oublierChezMeta: async (t) => { traces.retraits.push(t); } },
        enVol: { suivre: (p) => p },
        audit: async (_t, acteur, action, _c, detail) => {
          // Comme `audit_log.actor_user_id` (uuid) : un acteur qui n'est pas un compte fait échouer l'écriture.
          if (acteur.userId !== null && !/^[0-9a-f-]{36}$/.test(acteur.userId)) throw new Error('22P02 : uuid invalide');
          traces.audit.push({ action, detail });
        },
      },
    },
  });
  const appel = (methode: 'GET' | 'POST' | 'DELETE', url: string, cle = ADMIN, payload?: unknown) => server.inject({
    method: methode, url, headers: { authorization: `Bearer ${cle}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { server, appel, traces, champs, fiches, usage };
}

describe('les champs personnalisés par l’API', () => {
  it('la liste se lit avec contacts:read : les clés à utiliser dans fields', async () => {
    const { appel, server } = monter();
    const r = await appel('GET', '/v1/fields', LECTEUR);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ data: [{ key: 'numero_commande', label: 'Numéro de commande', type: 'text' }] });
    await server.close();
  });

  it('🔴 créer exige contacts:admin ; la clé vient du libellé ; une clé existante ou un champ de base est refusé', async () => {
    const { appel, server } = monter();
    expect((await appel('POST', '/v1/fields', ECRIVAIN, { label: 'Ville', type: 'text' })).statusCode).toBe(403);
    const cree = await appel('POST', '/v1/fields', ADMIN, { label: 'Date de naissance', type: 'date' });
    expect([cree.statusCode, cree.json()]).toEqual([201, { key: 'date_de_naissance', label: 'Date de naissance', type: 'date' }]);
    const deux = await appel('POST', '/v1/fields', ADMIN, { label: 'Date de naissance', type: 'date' });
    expect([deux.statusCode, deux.json().code]).toEqual([409, 'field_exists']);
    expect((await appel('POST', '/v1/fields', ADMIN, { label: 'Téléphone', type: 'text' })).statusCode).toBe(409);
    expect((await appel('POST', '/v1/fields', ADMIN, { label: 'Ville', type: 'couleur' })).json()).toMatchObject({ code: 'invalid_body' });
    await server.close();
  });
});

describe('la suppression RGPD par l’API', () => {
  it('🔴 effacée : la purge de la console, l’audit dit « api », et le retrait chez Meta part après la réponse', async () => {
    const { appel, traces, fiches, server } = monter();
    const r = await appel('DELETE', `/v1/contacts/${FICHE_T1}`);
    expect([r.statusCode, r.json()]).toEqual([200, { deleted: true, conversations: 1, messages: 4 }]);
    expect(traces.purges).toEqual([[FICHE_T1]]);
    expect(fiches.has(FICHE_T1)).toBe(false);
    expect(traces.audit).toEqual([{ action: 'contact.purged', detail: { lot: 1, via: 'api', acces: 'k1' } }]);
    expect(traces.retraits).toEqual(['t1']);
    expect((await appel('DELETE', `/v1/contacts/${FICHE_T1}`)).json()).toMatchObject({ code: 'unknown_contact' });
    await server.close();
  });

  it('🔴 la fiche d’un autre espace est inconnue : rien n’est effacé, et la limite du jour n’est pas entamée', async () => {
    const { appel, traces, fiches, server } = monter({ quota: 10 });
    const r = await appel('DELETE', `/v1/contacts/${FICHE_T2}`);
    expect([r.statusCode, r.json().code]).toEqual([404, 'unknown_contact']);
    expect(fiches.has(FICHE_T2)).toBe(true);
    expect(traces.purges).toEqual([]);
    expect(traces.consommes).toEqual([]);
    expect((await appel('DELETE', '/v1/contacts/pas-un-uuid')).statusCode).toBe(404);
    await server.close();
  });

  it('🔴 la limite du jour de l’offre : 402 avec son corps, rien d’effacé', async () => {
    const { appel, traces, fiches, server } = monter({ quota: 0 });
    const r = await appel('DELETE', `/v1/contacts/${FICHE_T1}`);
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ code: 'plan_limit_reached', max: 0 });
    expect(traces.purges).toEqual([]);
    expect(fiches.has(FICHE_T1)).toBe(true);
    await server.close();
  });

  it('🔴 effacer exige contacts:admin, même pour une clé qui écrit les fiches', async () => {
    const { appel, traces, server } = monter();
    expect((await appel('DELETE', `/v1/contacts/${FICHE_T1}`, ECRIVAIN)).statusCode).toBe(403);
    expect((await appel('DELETE', `/v1/contacts/${FICHE_T1}`, LECTEUR)).statusCode).toBe(403);
    expect(traces.purges).toEqual([]);
    await server.close();
  });
});
