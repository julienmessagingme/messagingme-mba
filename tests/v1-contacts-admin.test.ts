import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { sha256Hex } from '../src/lib/signature';
import { GardeUsageMemoire } from './aide/usage';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import { cleApiDeTest, aucunJetonOauth } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';
import type { UserFieldDef } from '../src/crm/types';
import { creerTravauxEnVol } from '../src/lib/en-vol';

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
const FICHE_T1_BIS = '3c2b1a09-8f7e-4d6c-9b5a-4e3d2c1b0a98';

function monter(o: { quota?: number | null; couteux?: number; retrait?: () => Promise<void> } = {}) {
  const champs = new Map<string, UserFieldDef[]>([['t1', [{ key: 'numero_commande', label: 'Numéro de commande', type: 'text' }]]]);
  const fiches = new Map<string, string>([[FICHE_T1, 't1'], [FICHE_T1_BIS, 't1'], [FICHE_T2, 't2']]);
  // Comme `purgeMany` : la fiche reste en base, marquée supprimée (`deleted_at`), et seule la lecture d'une fiche vivante
  // (`etatPourEnvoi`) l'écarte. La retirer de la table de ce faux cacherait un second DELETE.
  const effacees = new Set<string>();
  const enVol = creerTravauxEnVol();
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
    plafonds: { couteuxParMinute: o.couteux ?? 0, apiParMinute: 100_000, apiParHeure: 100_000 },
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
          etatPourEnvoi: async (t, id) => (fiches.get(id) === t && !effacees.has(id) ? { phoneE164: '+33600000001', bloque: false } : null),
          purgeMany: async (t, ids) => {
            traces.purges.push([...ids]);
            for (const id of ids) effacees.add(id);
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
        listeDeLAgent: { oublierChezMeta: async (t) => { traces.retraits.push(t); await o.retrait?.(); } },
        enVol,
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
  return { server, appel, traces, champs, effacees, usage, enVol };
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
  it('🔴 effacée : la purge de la console, l’audit dit « api », et le retrait chez Meta', async () => {
    const { appel, traces, effacees, enVol, server } = monter();
    const r = await appel('DELETE', `/v1/contacts/${FICHE_T1}`);
    expect([r.statusCode, r.json()]).toEqual([200, { deleted: true, conversations: 1, messages: 4 }]);
    expect(traces.purges).toEqual([[FICHE_T1]]);
    expect(effacees.has(FICHE_T1)).toBe(true);
    expect(traces.audit).toEqual([{ action: 'contact.purged', detail: { lot: 1, via: 'api', acces: 'k1' } }]);
    expect(await enVol.attendre(1000)).toBe(0);
    expect(traces.retraits).toEqual(['t1']);
    await server.close();
  });

  /**
   * 🔴 LA RÉPONSE N'ATTEND PAS META, comme la purge de la console (`tests/contacts-purge-audit.test.ts`). Vérifié dans
   * les deux sens : le retrait attendu dans `effacerContacts` avant de rendre, la réponse reste bloquée ; le retrait
   * lancé hors de `enVol`, l'arrêt de la copie ne l'attendrait plus.
   */
  it('🔴 la réponse n’attend pas le retrait chez Meta, qui reste suivi jusqu’à sa fin', async () => {
    let finir: () => void = () => {};
    const enCours = new Promise<void>((r) => { finir = r; });
    const { appel, enVol, server } = monter({ retrait: () => enCours });
    const reponse = appel('DELETE', `/v1/contacts/${FICHE_T1}`);
    const premier = await Promise.race([reponse.then(() => 'réponse' as const), new Promise<'bloquée'>((r) => { setTimeout(() => r('bloquée'), 2000); })]);
    expect(premier, 'la réponse attendait Meta').toBe('réponse');
    expect((await reponse).statusCode).toBe(200);
    expect(await enVol.attendre(0)).toBe(1);
    finir();
    expect(await enVol.attendre(1000)).toBe(0);
    await server.close();
  });

  it('🔴 une fiche déjà effacée est inconnue : le second DELETE rend 404 et n’entame plus la limite du jour', async () => {
    const { appel, traces, server } = monter({ quota: 10 });
    expect((await appel('DELETE', `/v1/contacts/${FICHE_T1}`)).statusCode).toBe(200);
    const deux = await appel('DELETE', `/v1/contacts/${FICHE_T1}`);
    expect([deux.statusCode, deux.json().code]).toEqual([404, 'unknown_contact']);
    expect(traces.purges).toEqual([[FICHE_T1]]);
    expect(traces.consommes).toEqual([1]);
    await server.close();
  });

  it('🔴 effacer passe sous le plafond des opérations lourdes de l’espace, et une fiche inconnue ne l’entame pas', async () => {
    const { appel, traces, effacees, server } = monter({ couteux: 1 });
    expect((await appel('DELETE', `/v1/contacts/${FICHE_T2}`)).statusCode).toBe(404);
    expect((await appel('DELETE', `/v1/contacts/${FICHE_T1}`)).statusCode).toBe(200);
    const trop = await appel('DELETE', `/v1/contacts/${FICHE_T1_BIS}`);
    expect([trop.statusCode, trop.json().code]).toEqual([429, 'rate_limited']);
    expect(Number(trop.headers['retry-after'])).toBeGreaterThan(0);
    expect(effacees.has(FICHE_T1_BIS)).toBe(false);
    expect(traces.consommes).toEqual([1]);
    await server.close();
  });

  it('🔴 la fiche d’un autre espace est inconnue : rien n’est effacé, et la limite du jour n’est pas entamée', async () => {
    const { appel, traces, effacees, server } = monter({ quota: 10 });
    const r = await appel('DELETE', `/v1/contacts/${FICHE_T2}`);
    expect([r.statusCode, r.json().code]).toEqual([404, 'unknown_contact']);
    expect(effacees.has(FICHE_T2)).toBe(false);
    expect(traces.purges).toEqual([]);
    expect(traces.consommes).toEqual([]);
    expect((await appel('DELETE', '/v1/contacts/pas-un-uuid')).statusCode).toBe(404);
    await server.close();
  });

  it('🔴 la limite du jour de l’offre : 402 avec son corps, rien d’effacé', async () => {
    const { appel, traces, effacees, server } = monter({ quota: 0 });
    const r = await appel('DELETE', `/v1/contacts/${FICHE_T1}`);
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ code: 'plan_limit_reached', max: 0 });
    expect(traces.purges).toEqual([]);
    expect(effacees.has(FICHE_T1)).toBe(false);
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
