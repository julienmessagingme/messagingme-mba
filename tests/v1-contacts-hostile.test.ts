import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { ApiContactInput, ApiUpsertOutcome } from '../src/api/contacts-upsert';
import { cleApiDeTest } from './aide/cle-api';

/**
 * CE QU'UN CORPS HOSTILE OU MALADROIT PROVOQUE SUR `/v1/contacts`, ET CE QU'IL DOIT PROVOQUER.
 *
 * 🔴 LE CONSTAT LE PLUS SOLIDE DE L'AUDIT DU 2026-09-13, VÉRIFIÉ : la route contrôlait que `contacts`
 * était un tableau de 1 à 500 éléments, puis le CASTAIT en `ApiContactInput[]`. Le `as` est un mensonge au
 * compilateur : tout le contenu arrivait non vérifié dans un service écrit pour des objets bien formés.
 * Quatre gestes ordinaires d'un intégrateur, quatre dégâts, tous mesurés dans le code d'aujourd'hui :
 *
 *  - un `null` dans un lot de 500 : `item.phone` lève, le LOT ENTIER part en 500, dont Cloudflare remplace
 *    le corps par sa page. L'intégrateur ne sait ni ce qui a échoué, ni ce qui est passé ;
 *  - `fields` en CHAÎNE : `Object.entries('abc')` rend `[['0','a'],['1','b'],['2','c']]`, donc un champ
 *    personnalisé PAR CARACTÈRE est auto-créé dans l'espace du client. 200 caractères, 200 définitions ;
 *  - `fields` IMBRIQUÉ : `String({...})` rend `[object Object]`, stocké tel quel, donnée irrécupérable ;
 *  - un tableau de NUMÉROS au lieu d'objets : 200 avec « téléphone invalide » ligne par ligne, sans jamais
 *    dire que c'est la FORME qui est fausse.
 *
 * 🔴 CE QUI NE DOIT PAS CHANGER, ET QUI EST LE VRAI CONTRAT DU BATCH : un conteneur malformé rend 400,
 * mais un ÉLÉMENT malformé rend son erreur À SON INDEX pendant que les autres passent. Un lot de 500 dont
 * la ligne 37 est fausse doit écrire 499 contacts, pas zéro.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed() { /* sans objet ici */ }
}

const VALID = cleApiDeTest('valide');

function app() {
  const cap = { calls: [] as Array<{ tenant: string; items: ApiContactInput[] }> };
  const keys = new FakeApiKeys().add(VALID, { id: 'k1', tenantId: 't1', scopes: ['contacts:write'] });
  /**
   * ⚠️ CE FAUX N'IMITE PAS LE SERVICE, IL LE REMPLACE, et c'est voulu : ce qu'on éprouve ici est la
   * VALIDATION, c'est-à-dire ce que la route laisse passer. Le faux rend « created » pour tout ce qu'il
   * reçoit, donc tout élément hostile qui l'atteindrait produirait un succès, et le test rougirait.
   */
  const upsertContacts = async (tenant: string, items: ApiContactInput[]): Promise<ApiUpsertOutcome[]> => {
    cap.calls.push({ tenant, items });
    return items.map((_, i) => ({ index: i, status: 'created' as const, contactId: `c${i}` }));
  };
  return { server: buildServer({ queue: new FakeQueue(), v1: { apiKeys: keys, contacts: { upsertContacts } } }), cap };
}
const auth = { headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID}` } };

type Resultat = { results: ApiUpsertOutcome[]; created: number; updated: number; errors: number };
const envoyer = async (contacts: unknown[]) => {
  const { server, cap } = app();
  const res = await server.inject({ method: 'POST', url: '/v1/contacts/batch', ...auth, payload: { contacts } });
  const corps = res.statusCode === 200 ? res.json<Resultat>() : null;
  await server.close();
  return { code: res.statusCode, corps, recus: cap.calls[0]?.items ?? [] };
};

describe('POST /v1/contacts/batch : les formes hostiles', () => {
  it('🔴 un `null` au milieu du lot n’emporte plus le lot entier', async () => {
    // Le geste : une ligne vide dans un CSV transformé en JSON. Avant, `item.phone` levait sur `null` et
    // les 499 autres contacts étaient perdus, en 500, sans corps lisible.
    const { code, corps, recus } = await envoyer([{ phone: '+33611' }, null, { phone: '+33622' }]);
    expect(code).toBe(200);
    expect(corps!.errors).toBe(1);
    expect(corps!.created).toBe(2);
    expect(corps!.results.find((r) => r.index === 1)).toMatchObject({ status: 'error' });
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

  it('🔴 un élément qui est une CHAÎNE dit que la FORME est fausse, pas que le téléphone manque', async () => {
    // C'est l'erreur la plus fréquente d'un premier appel : envoyer des numéros au lieu d'objets. Avant,
    // l'API répondait 200 avec « téléphone invalide » sur chaque ligne, ce qui envoie chercher le défaut
    // dans les numéros, qui sont pourtant justes.
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

  it('une liste d’étiquettes démesurée est refusée (relevé en revue)', async () => {
    // Le service coupait déjà à 50, mais APRÈS avoir reçu la liste : un tableau de 100 000 entrées
    // traversait la validation entière pour finir tronqué.
    const { corps, recus } = await envoyer([{ phone: '+33611', tags: Array.from({ length: 5000 }, (_, i) => `t${i}`) }]);
    expect(corps!.errors).toBe(1);
    expect(recus).toHaveLength(0);
  });

  it('⚠️ mais une liste un peu bavarde passe : on refuse le démesuré, pas le verbeux', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', tags: Array.from({ length: 60 }, (_, i) => `t${i}`) }]);
    expect(corps!.errors).toBe(0);
    expect(recus).toHaveLength(1);
  });

  it('⚠️ une clé démesurée ne revient pas EN ENTIER dans la réponse (relevé en revue)', async () => {
    // Sans la coupe du chemin, la clé envoyée revenait telle quelle, multipliée par le nombre de lignes
    // fautives : une amplification de réponse, exactement ce que ce lot ferme ailleurs.
    const { corps } = await envoyer([{ phone: '+33611', fields: { ['k'.repeat(5000)]: 'v' } }]);
    expect(corps!.results[0]!.reason!.length).toBeLessThan(200);
  });

  it('un `optInSource` démesuré est refusé : il justifie un consentement, il ne se tronque pas', async () => {
    const { corps, recus } = await envoyer([{ phone: '+33611', optIn: true, optInSource: 'x'.repeat(5000) }]);
    expect(corps!.errors).toBe(1);
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
    // 🔴 L'INDEX RENDU EST CELUI DU CORPS ENVOYÉ, pas celui de la liste filtrée. Sans ce cas, une
    // renumérotation ferait pointer l'erreur de la ligne 3 sur la ligne 1, et l'intégrateur corrigerait
    // une ligne parfaitement valide.
    expect(recus.map((i) => i.phone)).toEqual(['+33611', '+33633', '+33644']);
  });
});

describe('POST /v1/contacts/batch : ce qui doit continuer de passer', () => {
  /**
   * ⚠️ LE TÉMOIN DANS L'AUTRE SENS, ET IL EST AUSSI IMPORTANT QUE LES CAS HOSTILES. Une validation trop
   * serrée casse des intégrations en production pour un gain nul, et c'est le défaut le plus facile à
   * commettre en écrivant un schéma. Les valeurs ici sont celles que les espaces RÉELS portent
   * aujourd'hui (mesuré le 2026-09-14 : 10 définitions en tout, clé la plus longue 11 caractères,
   * 6 champs au maximum sur un contact, `opt_in_source` au plus 12 caractères).
   */
  it('un lot normal traverse INCHANGÉ', async () => {
    const { code, corps, recus } = await envoyer([
      { phone: '+33612345678', name: 'Marc', fields: { prenom: 'Marc', ville: 'Lyon' }, tags: ['vip'], optIn: true, optInSource: 'formulaire' },
      { phone: '+33698765432' },
    ]);
    expect(code).toBe(200);
    expect(corps!).toMatchObject({ created: 2, errors: 0 });
    expect(recus).toHaveLength(2);
    expect(recus[0]).toMatchObject({
      phone: '+33612345678', name: 'Marc', fields: { prenom: 'Marc', ville: 'Lyon' }, tags: ['vip'], optIn: true, optInSource: 'formulaire',
    });
  });

  it('⚠️ une valeur de champ NUMÉRIQUE ou BOOLÉENNE reste acceptée, convertie en texte', async () => {
    // Le service faisait déjà `String(rawVal)` : refuser ces deux types casserait des intégrations qui
    // envoient `{age: 42}`, pour aucun gain. Ce qu'on refuse, c'est ce qui n'a pas de texte SENSÉ : un
    // objet, un tableau, `null`.
    const { corps, recus } = await envoyer([{ phone: '+33611', fields: { age: 42, vip: true } }]);
    expect(corps!.errors).toBe(0);
    expect(recus[0]!.fields).toEqual({ age: '42', vip: 'true' });
  });

  it('une clé inconnue dans le corps est ignorée, pas refusée', async () => {
    // Un intégrateur qui envoie un champ de trop (souvent un reliquat de son propre modèle) ne doit pas
    // être bloqué : la clé est simplement écartée avant d'atteindre le service.
    const { corps, recus } = await envoyer([{ phone: '+33611', internalId: 'abc', extra: { x: 1 } }]);
    expect(corps!.errors).toBe(0);
    expect(recus[0]).not.toHaveProperty('internalId');
  });
});

describe('POST /v1/contacts (unitaire) : la même garde', () => {
  /**
   * 🔴 LA MÊME VALIDATION DES DEUX CÔTÉS. La route unitaire ne contrôlait QUE la présence de `phone`,
   * puis castait elle aussi : `fields` en chaîne y créait donc un champ par caractère, exactement comme
   * dans le batch. Fermer une porte en laissant l'autre ouverte est le motif « une capacité câblée sur un
   * consommateur sur deux », que ce dépôt a déjà payé plusieurs fois.
   */
  it('🔴 `fields` en chaîne rend 400, comme dans le batch', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth, payload: { phone: '+33611', fields: 'prenom=Marc' } });
    expect(res.statusCode).toBe(400);
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
