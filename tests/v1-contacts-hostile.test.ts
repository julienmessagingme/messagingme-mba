// tests/v1-contacts-hostile.test.ts
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { ContactV1 } from '../src/api/contacts-v1';
import { contactsV1Muets } from './aide/contacts-v1';
import { cleApiDeTest } from './aide/cle-api';

/**
 * CE QU'UN CORPS HOSTILE OU MALADROIT PROVOQUE SUR `/v1/contacts`, ET CE QU'IL DOIT PROVOQUER.
 *
 * 🔴 LE CONSTAT DE L'AUDIT DU 2026-09-13 TIENT TOUJOURS : la route castait le lot sans le valider, et quatre
 * gestes ordinaires d'un intégrateur faisaient des dégâts (un `null` emportait le lot en 500, `fields` en
 * chaîne créait un champ par caractère, un objet imbriqué était stocké « [object Object] », un tableau de
 * numéros répondait « téléphone invalide » au lieu de dire que la FORME est fausse).
 *
 * 🔴 CE QUI NE DOIT PAS CHANGER, ET QUI EST LE CONTRAT DE `/v1/contacts/batch` : un conteneur malformé rend 400, mais un
 * ÉLÉMENT malformé rend son erreur À SON INDEX pendant que les autres passent.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed() { /* sans objet ici */ }
}

const VALID = cleApiDeTest('valide');

function app() {
  const cap = { calls: [] as Array<{ tenant: string; items: ContactV1[] }> };
  const keys = new FakeApiKeys().add(VALID, { id: 'k1', tenantId: 't1', scopes: ['contacts:write'] });
  // ⚠️ CE FAUX REMPLACE LE SERVICE : il rend « created » pour tout ce qu'il reçoit, donc tout élément hostile
  // qui l'atteindrait produirait un succès, et le test rougirait.
  const contacts = contactsV1Muets({
    ecrireFiches: async (tenant, items) => { cap.calls.push({ tenant, items }); return items.map((_, i) => ({ index: i, status: 'created' as const, contactId: `c${i}` })); },
  });
  return { server: buildServer({ queue: new FakeQueue(), v1: { apiKeys: keys, contacts } }), cap };
}
const auth = { headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID}` } };

type Resultat = { results: Array<{ index: number; status: string; code?: string; reason?: string }>; created: number; updated: number; errors: number };
const envoyer = async (contacts: unknown[]) => {
  const { server, cap } = app();
  const res = await server.inject({ method: 'POST', url: '/v1/contacts/batch', ...auth, payload: { contacts } });
  const corps = res.statusCode === 200 ? res.json<Resultat>() : null;
  await server.close();
  return { code: res.statusCode, corps, recus: cap.calls[0]?.items ?? [] };
};

describe('POST /v1/contacts/batch : les formes hostiles', () => {
  it('🔴 un `null` au milieu du lot n’emporte plus le lot entier', async () => {
    // Le geste : une ligne vide dans un CSV transformé en JSON.
    const { code, corps, recus } = await envoyer([{ phone: '+33611' }, null, { phone: '+33622' }]);
    expect(code).toBe(200);
    expect(corps!.errors).toBe(1);
    expect(corps!.created).toBe(2);
    expect(corps!.results.find((r) => r.index === 1)).toMatchObject({ status: 'error', code: 'invalid_body' });
    // ⚠️ ET LE SERVICE NE VOIT JAMAIS LE `null` : c'est ce qui distingue une validation d'un try/catch.
    expect(recus).toHaveLength(2);
    expect(recus.every((i) => typeof i === 'object' && i !== null)).toBe(true);
  });

  it('🔴 `fields` en CHAÎNE est refusé : plus un champ personnalisé par caractère', async () => {
    const { code, corps, recus } = await envoyer([{ phone: '+33611', fields: 'prenom=Marc' }]);
    expect(code).toBe(200);
    expect(corps!.errors).toBe(1);
    expect(corps!.results[0]!.reason).toMatch(/fields/i);
    // 🔴 LE CŒUR DU CAS : rien n'atteint le service, donc aucune définition n'est créée dans l'espace.
    expect(recus).toHaveLength(0);
  });

  it('🔴 une valeur de `fields` imbriquée est refusée, au lieu d’être stockée « [object Object] »', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', fields: { adresse: { rue: 'x' } } }]);
    expect(corps!.errors).toBe(1);
    expect(corps!.results[0]!.reason).toMatch(/adresse/);
    expect(recus).toHaveLength(0);
  });

  it('🔴 un élément qui est une CHAÎNE dit que la FORME est fausse', async () => {
    // L'erreur la plus fréquente d'un premier appel : envoyer des numéros au lieu d'objets.
    const { corps, recus } = await envoyer(['+33612345678', 42, true]);
    expect(corps!.errors).toBe(3);
    for (const r of corps!.results) expect(r.reason).toMatch(/objet/i);
    expect(recus).toHaveLength(0);
  });

  it('une clé de champ démesurée est refusée', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', fields: { ['k'.repeat(500)]: 'v' } }]);
    expect(corps!.errors).toBe(1);
    expect(recus).toHaveLength(0);
  });

  it('un contact qui porte cent champs est refusé', async () => {
    const fields = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`champ_${i}`, 'v']));
    const { corps, recus } = await envoyer([{ phone: '+33611', fields }]);
    expect(corps!.errors).toBe(1);
    expect(recus).toHaveLength(0);
  });

  it('une liste d’étiquettes démesurée est refusée', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', tags: Array.from({ length: 5000 }, (_, i) => `t${i}`) }]);
    expect(corps!.errors).toBe(1);
    expect(recus).toHaveLength(0);
  });

  it('⚠️ mais une liste un peu bavarde passe : on refuse le démesuré, pas le verbeux', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', tags: Array.from({ length: 60 }, (_, i) => `t${i}`) }]);
    expect(corps!.errors).toBe(0);
    expect(recus).toHaveLength(1);
  });

  it('⚠️ une clé démesurée ne revient pas EN ENTIER dans la réponse', async () => {
    // Sans la coupe du chemin, la clé envoyée revenait telle quelle, multipliée par le nombre de lignes
    // fautives : une amplification de réponse.
    const { corps } = await envoyer([{ phone: '+33611', fields: { ['k'.repeat(5000)]: 'v' } }]);
    expect(corps!.results[0]!.reason!.length).toBeLessThan(200);
  });

  it('un `consentSource` démesuré est refusé : il justifie un consentement, il ne se tronque pas', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', consent: 'opted_in', consentSource: 'x'.repeat(5000) }]);
    expect(corps!.errors).toBe(1);
    expect(recus).toHaveLength(0);
  });

  it('🔴 l’ancienne clé `optIn` est REFUSÉE en nommant `consent`, plus jamais ignorée en silence', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', optIn: true }]);
    expect(corps!.errors).toBe(1);
    expect(corps!.results[0]!.reason).toMatch(/consent/);
    expect(recus).toHaveLength(0);
  });

  it('un identifiant externe de plus de 512 caractères, ou un `contactId` qui n’est pas un UUID, est refusé', async () => {
    const { corps, recus } = await envoyer([{ externalId: 'x'.repeat(513) }, { contactId: 'c1' }]);
    expect(corps!.errors).toBe(2);
    expect(recus).toHaveLength(0);
  });

  it('🔴 mélange de valides et d’invalides : chaque erreur À SON INDEX, les autres passent', async () => {
    const { code, corps, recus } = await envoyer([
      { phone: '+33611' },
      { phone: '+33622', fields: 'cassé' },
      { phone: '+33633' },
      null,
      { phone: '+33644' },
    ]);
    expect(code).toBe(200);
    expect(corps!.results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(corps!.results.map((r) => r.status)).toEqual(['created', 'error', 'created', 'error', 'created']);
    expect(corps!).toMatchObject({ created: 3, errors: 2, updated: 0 });
    // 🔴 L'INDEX RENDU EST CELUI DU CORPS ENVOYÉ, pas celui de la liste filtrée : sans ce cas, une
    // renumérotation ferait pointer l'erreur de la ligne 3 sur la ligne 1.
    expect(recus.map((i) => i.phone)).toEqual(['+33611', '+33633', '+33644']);
  });
});

describe('POST /v1/contacts/batch : ce qui doit continuer de passer', () => {
  /**
   * ⚠️ LE TÉMOIN DANS L'AUTRE SENS, ET IL EST AUSSI IMPORTANT QUE LES CAS HOSTILES : une validation trop
   * serrée casse des intégrations en production pour un gain nul.
   */
  it('un lot normal traverse INCHANGÉ', async () => {
    const { code, corps, recus } = await envoyer([
      { phone: '+33612345678', externalId: 'crm-7781', name: 'Marc', fields: { prenom: 'Marc', ville: 'Lyon' }, tags: ['vip'], consent: 'opted_in', consentSource: 'formulaire' },
      { phone: '+33698765432' },
    ]);
    expect(code).toBe(200);
    expect(corps!).toMatchObject({ created: 2, errors: 0 });
    expect(recus).toHaveLength(2);
    expect(recus[0]).toMatchObject({
      phone: '+33612345678', externalId: 'crm-7781', name: 'Marc', fields: { prenom: 'Marc', ville: 'Lyon' }, tags: ['vip'], consent: 'opted_in', consentSource: 'formulaire',
    });
  });

  it('⚠️ une valeur de champ NUMÉRIQUE ou BOOLÉENNE reste acceptée, convertie en texte', async () => {
    // Refuser ces deux types casserait des intégrations qui envoient `{age: 42}`, pour aucun gain. Ce qu'on
    // refuse, c'est ce qui n'a pas de texte SENSÉ : un objet, un tableau, `null`.
    const { corps, recus } = await envoyer([{ phone: '+33611', fields: { age: 42, vip: true } }]);
    expect(corps!.errors).toBe(0);
    expect(recus[0]!.fields).toEqual({ age: '42', vip: 'true' });
  });

  it('une clé inconnue dans le corps est ignorée, pas refusée', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', internalId: 'abc', extra: { x: 1 } }]);
    expect(corps!.errors).toBe(0);
    expect(recus[0]).not.toHaveProperty('internalId');
  });

  it('une clé vide (variable absente d’un profil) vaut absence, pas erreur', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', externalId: '', bsuid: '  ' }]);
    expect(corps!.errors).toBe(0);
    // ⚠️ `toBeUndefined`, pas `not.toHaveProperty` : zod 4 GARDE la clé, avec la valeur `undefined`, quand un
    // `preprocess` a rendu `undefined` (mesuré sur zod 4.4.3).
    expect(recus[0]!.externalId).toBeUndefined();
    expect(recus[0]!.bsuid).toBeUndefined();
  });

  it('🔴 un consentement vide (même cause) vaut absence : l’élément passe, et le service ne reçoit AUCUN consentement', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', consent: '', consentSource: ' ' }]);
    expect(corps!.errors).toBe(0);
    expect(recus).toHaveLength(1);
    expect(recus[0]!.consent).toBeUndefined();
    expect(recus[0]!.consentSource).toBeUndefined();
  });
});

describe('POST /v1/contacts (unitaire) : la même garde', () => {
  /**
   * 🔴 LA MÊME VALIDATION DES DEUX CÔTÉS : fermer une porte en laissant l'autre ouverte est le motif « une
   * capacité câblée sur un consommateur sur deux », que ce dépôt a déjà payé plusieurs fois.
   */
  it('🔴 `fields` en chaîne rend 400 `invalid_body`, comme dans le lot (`/v1/contacts/batch`)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth, payload: { phone: '+33611', fields: 'prenom=Marc' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(res.json<{ error: string }>().error).toMatch(/fields/i);
    expect(cap.calls).toHaveLength(0);
    await server.close();
  });

  it('un contact normal passe toujours', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth, payload: { phone: '+33612345678', fields: { prenom: 'Marc' } } });
    expect(res.statusCode).toBe(200);
    expect(cap.calls[0]!.items[0]).toMatchObject({ phone: '+33612345678', fields: { prenom: 'Marc' } });
    await server.close();
  });
});
