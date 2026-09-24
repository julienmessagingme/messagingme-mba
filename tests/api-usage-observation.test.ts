import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import { GardeUsageMemoire } from '../src/api/usage-guard.memoire';
import { cleApiDeTest } from './aide/cle-api';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { V1SendsRouteDeps } from '../src/http/v1-sends';
import type { DepsMcp } from '../src/mcp/outils';
import { contactsV1Muets } from './aide/contacts-v1';

/**
 * L'OBSERVATION DE L'USAGE : ce que les routes publiques comptent, et ce qu'elles ne refusent PAS.
 *
 * 🔴 AUCUN APPEL N'EST REFUSÉ AUJOURD'HUI, ET C'EST LE PREMIER CAS DE CE FICHIER. Aucun seuil n'est
 * inventé par ce chantier : on compte, on expose, on regarde, Julien tranche ensuite. Un seuil deviné qui
 * mord est une panne qu'on s'inflige, et ce cas-ci est ce qui empêche d'en livrer un par accident.
 *
 * 🔴 ET IL N'Y AVAIT RIEN AVANT, MESURÉ : la seule trace d'usage de l'API publique était un
 * `api_keys.last_used_at` ÉCRASÉ à chaque appel. Aucun compteur nulle part, donc aucune façon de répondre
 * à « qui consomme quoi » ni « ce seuil mordrait-il sur un vrai client ? ».
 *
 * ⚠️ LES ROUTES SONT EXERCÉES POUR DE VRAI, pas inventoriées par `grep`. Un inventaire prouve qu'une
 * liste est complète, jamais que les verdicts sont justes : c'est la leçon du chantier 6, où un test
 * d'inventaire affirmait qu'un chemin d'envoi était bloqué alors qu'il ne l'était pas.
 */
class FauxCles implements ApiKeyLookup {
  private readonly parHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  ajouter(brut: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.parHash.set(sha256Hex(brut), rec); return this; }
  async findActiveByHash(hash: string) { return this.parHash.get(hash) ?? null; }
  async touchLastUsed() { /* sans objet ici */ }
}

const CLE = cleApiDeTest('usage');

/**
 * Un double d'envoi RÉDUIT À CE QUE LE COMPTAGE TRAVERSE. Les cibles ne se résolvent pas et aucun envoi
 * n'est créé : ce qui est éprouvé ici est le COMPTEUR, pas le moteur d'envoi (qui a son propre fichier).
 */
const sendsMuets: Omit<V1SendsRouteDeps, 'usage'> = {
  resolveScenario: async () => ({ ok: false, reason: 'not_found' }),
  resolveNode: async () => ({ ok: false, reason: 'not_found' }),
  lireModele: async () => ({ statut: 'absent' }),
  getWindowOpenByWaIds: async () => new Map(),
  getTenantPhoneNumberId: async () => 'pn-1',
  phoneNumberBelongsToTenant: async () => true,
  resoudreFiche: async () => ({ ok: false, code: 'unknown_contact' }),
  appliquerConsentement: async () => 'inchange',
  listContactsPourEnvoi: async () => [],
  createSend: async () => ({ campaignId: 'camp1', recipientCount: 0 }),
  enqueue: async () => { /* rien */ },
  idempotencyClaim: async () => ({ claimed: true as const }),
  idempotencyComplete: async () => { /* rien */ },
  idempotencyRelease: async () => { /* rien */ },
  lireEnvoi: async () => null,
};

function monter() {
  const usage = new GardeUsageMemoire();
  const cles = new FauxCles().ajouter(CLE, { id: 'k1', tenantId: 't1', scopes: ['contacts:write', 'contacts:read', 'sends:create'] });
  const server = buildServer({
    queue: new FakeQueue(),
    usage,
    v1: {
      apiKeys: cles,
      contacts: contactsV1Muets(),
      sends: sendsMuets,
      mcp: {} as DepsMcp,
    },
  });
  return { server, usage };
}

const entetes = { 'content-type': 'application/json', authorization: `Bearer ${CLE}` };

/**
 * ⚠️ `/ops` NE SE MONTE QUE SI ON LE CÂBLE, et c'est une propriété du produit, pas un détail de test : une
 * instance qui n'a pas explicitement fourni ces dépendances n'expose pas la surface d'exploitation. Ces
 * trois doubles vides suffisent à la monter ; `/ops/usage`, lui, ne lit que les compteurs.
 */
const opsMuet = {
  getTenantOverview: async () => [],
  getGlobalDaily: async () => [],
  getQueueLoad: async () => [],
};

describe('l’usage de l’API publique est COMPTÉ', () => {
  it('🔴 chaque route publique compte, sous son opération', async () => {
    const { server, usage } = monter();
    const FICHE = '00000000-0000-4000-8000-000000000001';

    await server.inject({ method: 'POST', url: '/v1/contacts', headers: entetes, payload: { phone: '+33612345678' } });
    await server.inject({ method: 'POST', url: '/v1/contacts/batch', headers: entetes, payload: { contacts: [{ phone: '+33612345678' }, { phone: '+33698765432' }] } });
    // Les routes de fiche : une lecture, une recherche (le double ne trouve rien, la route compte quand même),
    // une modification.
    await server.inject({ method: 'GET', url: `/v1/contacts/${FICHE}`, headers: entetes });
    await server.inject({ method: 'POST', url: '/v1/contacts/search', headers: entetes, payload: { phone: '+33612345678' } });
    await server.inject({ method: 'PATCH', url: `/v1/contacts/${FICHE}`, headers: entetes, payload: { name: 'Camille' } });
    await server.inject({
      method: 'POST', url: '/v1/sends',
      headers: { ...entetes, 'idempotency-key': 'idem-1' },
      payload: { category: 'utility', target: { scenario: 'inconnu' }, recipients: [{ phone: '+33612345678' }, { phone: '+33698765432' }, { phone: '+33755667788' }] },
    });
    await server.inject({ method: 'GET', url: '/v1/sends/send-inconnu', headers: entetes });
    await server.inject({ method: 'POST', url: '/mcp', headers: entetes, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    await server.inject({ method: 'GET', url: '/mcp', headers: entetes });

    const parOperation = Object.fromEntries(usage.compteurs().map((c) => [c.operation, c]));
    expect(Object.keys(parOperation).sort()).toEqual(
      ['contacts.batch', 'contacts.read', 'contacts.upsert', 'mcp.call', 'mcp.refus', 'sends.create', 'sends.read'],
    );
    // 🔴 LE TRAVAIL, PAS L'APPEL : un lot de 2 contacts coûte 2, un envoi de 3 destinataires coûte 3.
    expect(parOperation['contacts.batch']).toMatchObject({ appels: 1, unites: 2 });
    expect(parOperation['sends.create']).toMatchObject({ appels: 1, unites: 3 });
    // `POST /v1/contacts` et `PATCH` : deux écritures d'UNE fiche, sous la même opération.
    expect(parOperation['contacts.upsert']).toMatchObject({ appels: 2, unites: 2 });
    // `GET` et `search` : deux lectures, une unité chacune.
    expect(parOperation['contacts.read']).toMatchObject({ appels: 2, unites: 2 });
    await server.close();
  });

  it('🔴 en observation, RIEN n’est refusé : aucun appel ne rend 429', async () => {
    const { server, usage } = monter();
    const codes: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const res = await server.inject({
        method: 'POST', url: '/v1/contacts/batch', headers: entetes,
        payload: { contacts: Array.from({ length: 500 }, () => ({ phone: '+33612345678' })) },
      });
      codes.push(res.statusCode);
    }
    // 15 000 contacts acceptés en trente appels : c'est précisément ce que le plafond de débit ne voit pas.
    expect(codes.every((c) => c === 200)).toBe(true);
    expect(usage.compteurs().find((c) => c.operation === 'contacts.batch')).toMatchObject({ unites: 15_000, refusees: 0 });
    await server.close();
  });

  it('⚠️ `GET /mcp` compte AUSSI, alors qu’il ne fait que refuser', async () => {
    // L'audit l'avait manquée : elle rend 405, donc elle paraît gratuite. Elle traverse pourtant le
    // préhandler de clé d'API, donc un lookup, et une boucle dessus serait invisible de tout compteur.
    const { server, usage } = monter();
    const res = await server.inject({ method: 'GET', url: '/mcp', headers: entetes });
    expect(res.statusCode).toBe(405);
    expect(usage.compteurs().find((c) => c.operation === 'mcp.refus')).toMatchObject({ appels: 1 });
    await server.close();
  });

  it('🔴 un appel NON AUTHENTIFIÉ ne compte pas : on ne mesure pas ce qu’on a refusé à la porte', async () => {
    // Sinon les compteurs mélangeraient l'usage d'un client et le bruit d'un robot, et le jour où un
    // seuil sera posé, il mordrait sur le mauvais.
    const { server, usage } = monter();
    await server.inject({ method: 'POST', url: '/v1/contacts', headers: { 'content-type': 'application/json' }, payload: { phone: '+33612345678' } });
    expect(usage.compteurs()).toHaveLength(0);
    await server.close();
  });

  /**
   * 🔴 LE BATCH COMPTE CE QUE L'APPELANT DEMANDE, MÊME QUAND TOUT EST INVALIDE, et l'écart avec la route
   * unitaire est VOULU (relevé en revue, qui l'a d'abord pris pour une incohérence). Valider un objet est
   * négligeable ; valider 500 lignes est un travail réel, que l'appelant a bel et bien fait faire. Sans
   * ce cas, une boucle de lots malformés resterait invisible des compteurs, c'est-à-dire exactement le
   * comportement qu'on surveille.
   */
  it('🔴 un lot ENTIÈREMENT invalide compte quand même : la validation de 500 lignes est du travail', async () => {
    const { server, usage } = monter();
    const res = await server.inject({
      method: 'POST', url: '/v1/contacts/batch', headers: entetes,
      payload: { contacts: Array.from({ length: 200 }, () => null) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ errors: number }>().errors).toBe(200);
    expect(usage.compteurs().find((c) => c.operation === 'contacts.batch')).toMatchObject({ appels: 1, unites: 200 });
    await server.close();
  });

  it('⚠️ un corps REFUSÉ par la validation ne compte pas comme du travail accepté', async () => {
    // La validation passe avant le comptage sur la route unitaire : un corps malformé n'a pas coûté
    // d'écriture, et le compter gonflerait artificiellement l'usage d'un client maladroit.
    const { server, usage } = monter();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', headers: entetes, payload: { phone: '+33612345678', fields: 'cassé' } });
    expect(res.statusCode).toBe(400);
    expect(usage.compteurs()).toHaveLength(0);
    await server.close();
  });
});

describe('le stockage se remplace sans toucher aux routes', () => {
  /**
   * 🔴 C'EST LA PROPRIÉTÉ QUI PRÉPARE LE MULTI-REPLICA, ET ELLE SE PROUVE PLUTÔT QU'ELLE NE SE PROMET. Le
   * jour où les compteurs devront être partagés entre deux process, on remplacera le STOCKAGE et rien
   * d'autre. Si une route connaissait `GardeUsageMemoire` plutôt que le contrat, ce jour-là demanderait de
   * rouvrir chaque route, c'est-à-dire exactement ce que l'injection existe pour éviter.
   *
   * ⚠️ CE DOUBLE N'EST PAS UNE CLASSE DU DÉPÔT : il est écrit ici, à la main, et il suffit. C'est la preuve.
   */
  it('🔴 un double maison suffit à toutes les routes : aucune ne connaît l’implémentation', async () => {
    const vues: string[] = [];
    const double = { demander: (d: { operation: string }) => { vues.push(d.operation); return { accepte: true }; }, compteurs: () => [], entrerLourde: () => () => {}, noterRefus: () => {} };
    const cles = new FauxCles().ajouter(CLE, { id: 'k1', tenantId: 't1', scopes: ['contacts:write', 'sends:create'] });
    const server = buildServer({
      queue: new FakeQueue(),
      usage: double,
      v1: {
        apiKeys: cles,
        contacts: contactsV1Muets(),
        sends: sendsMuets,
        mcp: {} as DepsMcp,
      },
    });
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', headers: entetes, payload: { phone: '+33612345678' } });
    expect(res.statusCode).toBe(200);
    await server.inject({ method: 'GET', url: '/mcp', headers: entetes });
    expect(vues).toEqual(['contacts.upsert', 'mcp.refus']);
    await server.close();
  });

  it('🔴 un garde qui REFUSE fait rendre 429 aux routes, pas 500', async () => {
    // Le jour où un seuil existera, c'est ce chemin qui servira. Un 5xx serait remplacé par la page
    // Cloudflare et l'intégrateur ne saurait même pas ce qu'on lui reproche.
    const refusant = { demander: () => ({ accepte: false, raison: 'quota d’essai atteint' }), compteurs: () => [], entrerLourde: () => () => {}, noterRefus: () => {} };
    const cles = new FauxCles().ajouter(CLE, { id: 'k1', tenantId: 't1', scopes: ['contacts:write'] });
    const server = buildServer({
      queue: new FakeQueue(),
      usage: refusant,
      v1: { apiKeys: cles, contacts: contactsV1Muets() },
    });
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', headers: entetes, payload: { phone: '+33612345678' } });
    expect(res.statusCode).toBe(429);
    expect(res.json<{ error: string }>().error).toMatch(/quota/i);
    await server.close();
  });
});

describe('ce que /ops montre de l’usage', () => {
  it('🔴 les compteurs sont lisibles depuis /ops, avec le jeton', async () => {
    const usage = new GardeUsageMemoire();
    const cles = new FauxCles().ajouter(CLE, { id: 'k1', tenantId: 't1', scopes: ['contacts:write'] });
    const server = buildServer({
      queue: new FakeQueue(),
      usage,
      opsToken: 'jeton-ops',
      ops: opsMuet,
      v1: { apiKeys: cles, contacts: contactsV1Muets() },
    });
    await server.inject({ method: 'POST', url: '/v1/contacts', headers: entetes, payload: { phone: '+33612345678' } });

    const res = await server.inject({ method: 'GET', url: '/ops/usage', headers: { 'x-ops-token': 'jeton-ops' } });
    expect(res.statusCode).toBe(200);
    const corps = res.json<{ compteurs: Array<{ tenantId: string; cleId: string; operation: string; unites: number }> }>();
    expect(corps.compteurs[0]).toMatchObject({ tenantId: 't1', cleId: 'k1', operation: 'contacts.upsert', unites: 1 });
    await server.close();
  });

  it('🔴 sans le jeton, /ops/usage ne dit rien', async () => {
    const server = buildServer({ queue: new FakeQueue(), opsToken: 'jeton-ops', ops: opsMuet });
    expect((await server.inject({ method: 'GET', url: '/ops/usage' })).statusCode).toBe(401);
    await server.close();
  });

  it('⚠️ aucune clé ni empreinte ne sort par /ops', async () => {
    // Ces lignes sont faites pour être regardées, souvent copiées dans un message : un secret, même
    // haché, n'y a pas sa place.
    const usage = new GardeUsageMemoire();
    const cles = new FauxCles().ajouter(CLE, { id: 'k1', tenantId: 't1', scopes: ['contacts:write'] });
    const server = buildServer({
      queue: new FakeQueue(), usage, opsToken: 'jeton-ops', ops: opsMuet,
      v1: { apiKeys: cles, contacts: contactsV1Muets() },
    });
    await server.inject({ method: 'POST', url: '/v1/contacts', headers: entetes, payload: { phone: '+33612345678' } });
    const res = await server.inject({ method: 'GET', url: '/ops/usage', headers: { 'x-ops-token': 'jeton-ops' } });
    expect(res.body).not.toMatch(/mba_/);
    expect(res.body).not.toMatch(/[0-9a-f]{64}/);
    await server.close();
  });
});

describe('le plafond des opérations LOURDES en vol', () => {
  /**
   * 🔴 CE QUE CE PLAFOND REMPLACE : une attente de huit secondes suivie d'une erreur d'acquisition de
   * connexion. Le pool sert 8 connexions pour TOUT le process API, et un lot de contacts en demande
   * jusqu'à 4 : dix lots simultanés mettent quarante acquisitions en file derrière huit places, pendant
   * que l'Inbox et le worker se disputent les mêmes emplacements. Un 429 avec `Retry-After` est une
   * réponse ; une attente qui finit en erreur n'en est pas une.
   */
  function monterLent(max = 2) {
    const usage = new GardeUsageMemoire(120, 0, () => Date.now(), max);
    const cles = new FauxCles().ajouter(CLE, { id: 'k1', tenantId: 't1', scopes: ['contacts:write', 'sends:create'] });
    let debloquer: () => void = () => {};
    const enVol = new Promise<void>((r) => { debloquer = r; });
    const server = buildServer({
      queue: new FakeQueue(),
      usage,
      v1: {
        apiKeys: cles,
        contacts: contactsV1Muets({
          ecrireFiches: async (_t, items) => {
            await enVol;
            return items.map((_, i) => ({ index: i, status: 'created' as const, contactId: `c${i}` }));
          },
        }),
        sends: sendsMuets,
      },
    });
    return { server, debloquer: () => debloquer() };
  }

  const lot = (server: ReturnType<typeof monterLent>['server']) => server.inject({
    method: 'POST', url: '/v1/contacts/batch', headers: entetes, payload: { contacts: [{ phone: '+33612345678' }] },
  });

  it('🔴 au-delà du plafond, un 429 CONTRÔLÉ avec Retry-After, jamais une attente sans fin', async () => {
    const { server, debloquer } = monterLent(2);
    const enCours = [lot(server), lot(server)];
    // Laisse les deux premiers entrer dans le handler (donc prendre leur place) avant d'en lancer un troisième.
    await new Promise((r) => setImmediate(r));
    const refuse = await lot(server);

    expect(refuse.statusCode).toBe(429);
    expect(refuse.headers['retry-after']).toBeDefined();
    expect(refuse.json<{ error: string }>().error).toMatch(/opérations lourdes/i);

    debloquer();
    const finis = await Promise.all(enCours);
    expect(finis.map((r) => r.statusCode)).toEqual([200, 200]);
    await server.close();
  });

  it('🔴 la place est RENDUE quand la réponse part : sans quoi le plafond se referme tout seul', async () => {
    /**
     * 🔴 LE CAS ANTI-FUITE, ET C'EST LE PLUS IMPORTANT DES DEUX. Une place qui ne revient pas ne se voit
     * pas tout de suite : elle rétrécit le plafond jusqu'à ce que plus aucune requête lourde ne passe, et
     * le redémarrage efface la preuve. Ici, quatre lots SÉQUENTIELS sur un plafond de 1 doivent tous
     * passer.
     */
    const { server, debloquer } = monterLent(1);
    debloquer();
    for (let i = 0; i < 4; i += 1) {
      const res = await lot(server);
      expect(res.statusCode, `le lot ${i + 1} aurait dû passer : la place du précédent n’a pas été rendue`).toBe(200);
    }
    await server.close();
  });

  /**
   * 🔴 LE CAS QUE L'ESSAI RÉEL A EXIGÉ (2026-09-14). En production, dix lots simultanés ont donné cinq
   * 429 et `refusees` à ZÉRO : le comptage avait lieu AVANT la prise de place, donc un lot refusé était
   * enregistré comme accepté, avec tout son travail. Les compteurs annonçaient 5 005 unités dont 2 500
   * n'avaient jamais été travaillées, et la saturation ne laissait aucune trace chez nous.
   */
  it('🔴 un lot refusé faute de place est COMPTÉ COMME REFUSÉ, et son travail n’est pas compté', async () => {
    const usage = new GardeUsageMemoire(120, 0, () => Date.now(), 1);
    const cles = new FauxCles().ajouter(CLE, { id: 'k1', tenantId: 't1', scopes: ['contacts:write'] });
    let debloquer: () => void = () => {};
    const enVol = new Promise<void>((r) => { debloquer = r; });
    const server = buildServer({
      queue: new FakeQueue(),
      usage,
      v1: {
        apiKeys: cles,
        contacts: contactsV1Muets({
          ecrireFiches: async (_t, items) => {
            await enVol;
            return items.map((_, i) => ({ index: i, status: 'created' as const, contactId: `c${i}` }));
          },
        }),
      },
    });
    const gros = { contacts: Array.from({ length: 10 }, () => ({ phone: '+33612345678' })) };
    const enCours = server.inject({ method: 'POST', url: '/v1/contacts/batch', headers: entetes, payload: gros });
    await new Promise((r) => setImmediate(r));
    const refuse = await server.inject({ method: 'POST', url: '/v1/contacts/batch', headers: entetes, payload: gros });
    expect(refuse.statusCode).toBe(429);

    const ligne = usage.compteurs().find((c) => c.operation === 'contacts.batch')!;
    expect(ligne.refusees, 'le refus de place doit se voir').toBe(1);
    // 🔴 ET SON TRAVAIL N'EST PAS COMPTÉ : un appel refusé n'a rien fait. Sans cette assertion, la
    // correction pourrait se contenter d'incrémenter `refusees` en laissant les unités gonflées.
    expect(ligne.unites, 'un appel refusé n’a pas travaillé').toBe(10);
    expect(ligne.appels).toBe(1);

    debloquer();
    await enCours;
    await server.close();
  });

  it('🔴 une LECTURE passe pendant que les places lourdes sont prises', async () => {
    // Soumettre les lectures au même plafond ferait tomber une consultation pendant qu'un lot écrit :
    // une protection du pool transformée en panne d'écran.
    const { server, debloquer } = monterLent(1);
    const enCours = lot(server);
    await new Promise((r) => setImmediate(r));
    const lecture = await server.inject({ method: 'GET', url: '/v1/sends/inconnu', headers: entetes });
    expect(lecture.statusCode).toBe(404); // refusé par le métier, PAS par le plafond
    debloquer();
    await enCours;
    await server.close();
  });
});
