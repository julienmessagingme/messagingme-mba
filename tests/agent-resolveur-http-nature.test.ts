import { describe, it, expect } from 'vitest';
import { creerResolveurHttp } from '../src/agent/resolvers/http';
import { connecteurSimule, resolveursSimulation } from '../src/agent/resolvers/simulation';
import { executeTool, type EntreeResolveur, type ToolExecutorDeps } from '../src/agent/executor';
import { JOURNAL_MUET } from '../src/agent/journal-muet';
import type { OutilDefini } from '../src/agent/catalog';
import type { SourceAppel } from '../src/agent/sources';
import type { RequeteConnecteur } from '../src/agent/requetes';
import { SANS_MCP } from './outils-mcp';
import { AUCUN_GESTE, GESTE_MUET } from './gestes';

/**
 * CE QUE L'AGENT FAIT DE LA RÉPONSE : POUSSER OU INTÉGRER (migration 0150).
 *
 * 🔴 CE FICHIER GARDE LE POINT EXACT DU CHANGEMENT, et il est volontairement à part de
 * `tests/agent-resolver-http.test.ts` : là-bas, l'outil et la requête déclarent les MÊMES champs, pour que
 * les cas historiques continuent d'exercer ce qu'ils exerçaient. Ici ils DIVERGENT, parce que c'est
 * uniquement quand ils divergent que l'on voit lequel des deux le résolveur lit.
 *
 * 🔴 CE QUE ÇA RÉPARE. Un appel de connecteur était supposé RENDRE quelque chose : sans champ déclaré, le
 * résolveur refusait. La moitié des appels qu'un client veut brancher ne rendent pourtant rien d'utile
 * (poser une étiquette, créer une fiche). Julien, 2026-09-15, bloqué sur `POST /subscriber/add-tag`.
 */

const SOURCE: SourceAppel = {
  id: 'src1', kind: 'http', baseUrl: 'https://api.client.fr/v1',
  authKind: 'none', authHeaderName: null, authSecret: null, status: 'active',
};

/** La requête déclare TROIS champs : c'est le DÉFAUT de l'appel, partagé par tous les agents. */
const REQUETE: RequeteConnecteur = {
  id: 'rq1', tenantId: 't1', sourceId: 'src1', label: 'Poser une étiquette',
  methode: 'POST', chemin: '/subscriber/add-tag',
  parametres: [], entetes: [], corps: { mode: 'aucun' }, variables: [],
  outputPaths: ['statut', 'email', 'interne'],
  valeursTest: {}, outils: 1, updatedAt: '2026-09-15T00:00:00.000Z',
};

const OUTIL = (over: Partial<OutilDefini> = {}): OutilDefini => ({
  ...SANS_MCP, ...AUCUN_GESTE(),
  id: 'to1', tenantId: 't1', origin: 'http', sourceId: 'src1', requestId: 'rq1', nePasUtiliser: '',
  name: 'poser_etiquette', description: 'pose une étiquette', params: [], binding: {},
  nature: 'integre', outputPaths: ['statut'],
  risk: 'write', timeoutMs: 5_000, maxBytes: 16_384, autonome: false,
  ...over,
});

/** La réponse du système du client : un succès BAVARD, celui qui rend la question intéressante. */
const CORPS = JSON.stringify({ statut: 'ok', email: 'client@exemple.test', interne: 'CRM-9182' });

function harnais(
  outil: OutilDefini,
  reponse: { status: number; body: string } = { status: 200, body: CORPS },
  requete: RequeteConnecteur = REQUETE,
) {
  const epreuves: Array<{ ok: boolean }> = [];
  let appels = 0;
  const fetchImpl = (async () => {
    appels += 1;
    return new Response(reponse.body, { status: reponse.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const resolveur = creerResolveurHttp({
    sources: {
      pourAppel: async () => SOURCE,
      marquerEpreuve: async (_t, _i, ok) => { epreuves.push({ ok }); },
    },
    requetes: { parId: async () => requete },
    fiche: { ficheDuContact: async () => null },
    inbox: { derniereSaisieDuContact: async () => null },
    fuseau: async () => 'Europe/Paris',
    now: () => new Date('2026-09-15T09:00:00.000Z'),
    fetchImpl,
    verifierResolution: async () => ({ ok: true }),
  });
  const entree: EntreeResolveur = {
    outil,
    args: {},
    ctx: {
      tenantId: 't1', agentId: 'ag1', sessionId: 's1', runId: 'r1', workflowId: 'wf1', waId: '33600',
      contact: null, contactInconnu: 'tous' as const, appelsRestants: 5, budgetRestantMicroEur: 10_000,
      deadline: Date.now() + 30_000,
    },
    signal: AbortSignal.timeout(10_000),
  };
  /** Combien de requêtes sont VRAIMENT parties vers le système du client. */
  return { resolveur, entree, epreuves, appels: () => appels };
}

describe('un outil qui INTÈGRE', () => {
  it('🔴 lit les champs de L OUTIL, pas ceux de l APPEL', async () => {
    // C'est tout le chantier. L'appel en déclare trois, cet agent n'en lit qu'un. Tant que la liste vivait
    // sur l'appel, restreindre pour un agent restreignait pour tous, et l'élargir élargissait pour tous.
    const { resolveur, entree } = harnais(OUTIL());
    const r = await resolveur(entree);
    expect(r.contenu).toEqual({ statut: 'ok' });
    // 🔴 Les deux champs que l'APPEL déclare et que cet agent n'a PAS choisis ne traversent pas.
    expect(JSON.stringify(r.contenu)).not.toContain('client@exemple.test');
    expect(JSON.stringify(r.contenu)).not.toContain('CRM-9182');
  });

  it('🔴 sans aucun champ, il ne divulgue RIEN plutôt que tout', async () => {
    // Une déclaration incomplète reste un refus : c'est la décision D-L2-2, et elle ne bouge pas.
    const { resolveur, entree } = harnais(OUTIL({ outputPaths: [] }));
    expect((await resolveur(entree)).ok).toBe(false);
  });
});

describe('un outil qui POUSSE', () => {
  it('🔴 rend le VERDICT et RIEN du corps, même quand le système est bavard', async () => {
    /**
     * 🔴 C'EST UNE GARANTIE, PAS UNE ÉCONOMIE. La réponse d'un POST de succès porte très souvent la
     * ressource entière qu'on vient de modifier : la fiche du client, son e-mail, ses identifiants internes.
     * Un agent qui n'a rien à en faire n'a aucune raison de l'envoyer au fournisseur du modèle.
     */
    const { resolveur, entree } = harnais(OUTIL({ nature: 'pousse', outputPaths: [] }));
    const r = await resolveur(entree);
    expect(r.contenu).toEqual({ ok: true, statut: 200 });
    expect(JSON.stringify(r.contenu)).not.toContain('client@exemple.test');
    expect(JSON.stringify(r.contenu)).not.toContain('CRM-9182');
  });

  it('🔴 il N EST PAS refusé faute de champ, et c est le cas qui était impossible à brancher', async () => {
    // Avant 0150, cet appel rendait « ce connecteur ne déclare aucun champ à lire » à chaque tour.
    const { resolveur, entree } = harnais(OUTIL({ nature: 'pousse', outputPaths: [] }));
    expect((await resolveur(entree)).ok).not.toBe(false);
  });

  it('🔴 un échec reste un échec lisible, avec son statut', async () => {
    // L'agent doit pouvoir dire « je n'ai pas réussi » plutôt qu'annoncer un succès qui n'a pas eu lieu.
    const { resolveur, entree } = harnais(OUTIL({ nature: 'pousse', outputPaths: [] }), { status: 422, body: '{"error":"tag inconnu"}' });
    const r = await resolveur(entree);
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(422);
    /**
     * ⚠️ ET LE CORPS DE L ERREUR DU CLIENT NE TRAVERSE PAS, délibérément. Le plan de ce lot prévoyait de le
     * renvoyer ; l'étape 8 du résolveur s'y refuse depuis toujours (« une trace de 500 porte des chemins
     * internes, parfois des identifiants »), et ce refus l'emporte : élargir ce qui fuit vers le fournisseur
     * du modèle mérite sa propre décision, pas un effet de bord d'un lot sur les connecteurs.
     */
    expect(JSON.stringify(r.contenu)).not.toContain('tag inconnu');
  });

  it('⚠️ et la source reste notée SAINE : le système a répondu, il a juste répondu non', async () => {
    const h = harnais(OUTIL({ nature: 'pousse', outputPaths: [] }));
    await h.resolveur(h.entree);
    expect(h.epreuves).toEqual([{ ok: true }]);
  });
});

describe('le bac à sable, qui promettait ce qu’il ne faisait pas', () => {
  /**
   * 🔴 IL MENTAIT DEPUIS LE 2026-09-02, ET SON COMMENTAIRE L'AFFIRMAIT. `connecteurSimule` boucle sur
   * `outil.outputPaths`, une colonne que `ajouterConnecteur` remplissait délibérément de vide : il rendait
   * donc `{}` pour TOUT outil de connecteur, alors qu'il promet « le client voit exactement ce que l'agent
   * recevra ». Le lot 1 remplit la colonne, ce test empêche la promesse de redevenir fausse.
   */
  /** ⚠️ Le simulé enveloppe les champs sous `champs`, à côté d'une note : on lit donc CE niveau-là, pas la
   *  racine. Lire la racine ferait passer ce test pour la mauvaise raison. */
  const champsSimules = (o: OutilDefini): string[] =>
    Object.keys(((connecteurSimule(o).contenu ?? {}) as { champs?: Record<string, unknown> }).champs ?? {});

  it('🔴 il montre les champs que l’outil déclare', () => {
    expect(champsSimules(OUTIL({ outputPaths: ['statut', 'livraison.date'] }))).toEqual(['statut', 'livraison.date']);
  });

  it('⚠️ un outil vide y rend zéro champ, et c’est le symptôme qu’on a réparé', () => {
    // Gardé à l'envers : si un jour `ajouterConnecteur` cessait d'écrire la colonne, le test ci-dessus
    // tomberait, et celui-ci dirait pourquoi.
    expect(champsSimules(OUTIL({ outputPaths: [] }))).toEqual([]);
  });
});

/**
 * DE BOUT EN BOUT : LA SORTIE RÉELLE DU RÉSOLVEUR TRAVERSE L'EXÉCUTEUR, comme dans un tour (2026-10-05).
 *
 * 🔴 LES TESTS CI-DESSUS INTERROGENT LE RÉSOLVEUR SEUL, et c'est ce qui a laissé passer le défaut. Le résolveur
 * rend des clés À PLAT qui portent le chemin entier (`tarifs.integrale`) ; l'exécuteur refiltrait ensuite par
 * `outputPaths` en DESCENDANT dans l'objet, cherchait `contenu.tarifs`, qui n'existe pas, et jetait le champ.
 * Tout champ imbriqué coché par un client disparaissait avant le modèle, sans erreur. Le même refiltre vidait
 * l'enveloppe d'échec (le modèle recevait `{}`) et celle du bac à sable (ni champs, ni note, ni « simulé »).
 */
const executer = (outil: OutilDefini, resolveurs: ToolExecutorDeps['resolveurs']) => executeTool(
  { name: outil.name, argumentsJson: '{}' },
  {
    tenantId: 't1', agentId: 'ag1', sessionId: 's1', runId: 'r1', workflowId: 'wf1', waId: '33600',
    contact: null, contactInconnu: 'tous', appelsRestants: 5, budgetRestantMicroEur: 10_000,
    deadline: Date.now() + 30_000,
  },
  {
    catalogue: { byName: async () => outil, listActifs: async () => [outil] },
    journal: JOURNAL_MUET, resolveurs, sessions: { compterAppel: async () => {} }, executerGeste: GESTE_MUET,
  },
);
/** Un devis : des tarifs et une date IMBRIQUÉS, à côté d'un identifiant interne que personne ne coche. */
const DEVIS = JSON.stringify({
  statut: 'ok', tarifs: { integrale: 42.5, essentielle: 19.9 }, livraison: { date: '2026-10-06' }, interne: 'CRM-9182',
});
/** Le bac à sable tel que la console le câble, autour du résolveur de production d'un harnais. */
const bacASable = (h: ReturnType<typeof harnais>, requete: RequeteConnecteur) => resolveursSimulation({
  connaissance: { chercher: async () => [] },
  connecteurs: { requetes: { parId: async () => requete }, reel: h.resolveur },
});

describe('de bout en bout : la sortie du résolveur traverse l’exécuteur', () => {
  it('🔴 un champ IMBRIQUÉ coché par le client atteint le modèle', async () => {
    // `tarifs.absent` : un chemin déclaré que la réponse ne porte pas est omis, jamais rendu à `undefined`.
    const outil = OUTIL({ outputPaths: ['statut', 'tarifs.integrale', 'livraison.date', 'tarifs.absent'] });
    const r = await executer(outil, { http: harnais(outil, { status: 200, body: DEVIS }).resolveur });
    expect(r.status).toBe('ok');
    expect(r.contenu).toEqual({ statut: 'ok', 'tarifs.integrale': 42.5, 'livraison.date': '2026-10-06' });
    expect(Object.keys(r.contenu as object)).not.toContain('tarifs.absent');
    // Le filtre tient toujours, il est dans le résolveur : ce que l'outil ne déclare pas ne traverse pas.
    expect(JSON.stringify(r.contenu)).not.toContain('CRM-9182');
  });

  it('🔴 un ÉCHEC du système du client arrive au modèle avec son message sûr, pas en `{}`', async () => {
    const outil = OUTIL({ outputPaths: ['statut'] });
    const r = await executer(outil, { http: harnais(outil, { status: 503, body: '{"trace":"/srv/app/devis.js"}' }).resolveur });
    expect(r.status).toBe('erreur_outil');
    expect(r.contenu).toEqual({ erreur: expect.stringContaining('pas répondu') });
    expect(JSON.stringify(r.contenu)).not.toContain('/srv/app');
  });

  it('🔴 au bac à sable, le modèle reçoit les champs déclarés ET la note, et l’écran voit « simulé »', async () => {
    const outil = OUTIL({ outputPaths: ['tarifs.integrale', 'livraison.date'] });
    const h = harnais(outil);
    const r = await executer(outil, bacASable(h, REQUETE));
    const c = r.contenu as { simule?: unknown; champs?: Record<string, unknown>; note?: unknown };
    expect(c.simule).toBe(true);
    expect(Object.keys(c.champs ?? {})).toEqual(['tarifs.integrale', 'livraison.date']);
    expect(String(c.note)).toContain('Test hors ligne');
    expect(h.appels()).toBe(0);
  });
});

/**
 * LE BAC À SABLE APPELLE POUR DE VRAI UN CONNECTEUR QUI LIT (décision de Julien, 2026-10-05).
 *
 * 🔴 C'était le seul moyen d'éprouver un devis sans conversation WhatsApp réelle : simulé, le modèle reçoit
 * « exemple(tarifs.integrale) ». « Qui lit » se juge sur QUATRE faits, et chacun a son cas ci-dessous : la requête
 * est un GET (ce qui part sur le réseau), l'outil INTÈGRE la réponse (la seule déclaration du client : « il pousse »
 * dit qu'il agit), son risque est resté `read` (dérivé de la méthode, il ne l'est plus si la requête a changé de
 * méthode après coup), et aucune variable ne vient du contact (il n'y en a pas au bac à sable : l'appel partirait
 * avec `null` ou `bac-a-sable`, une valeur inventée).
 */
describe('le bac à sable appelle pour de vrai un connecteur qui lit', () => {
  const GET: RequeteConnecteur = { ...REQUETE, label: 'Tarif', methode: 'GET', chemin: '/api/tarif' };

  it('🔴 un GET qui intègre part POUR DE VRAI, filtré comme en production', async () => {
    // Une valeur fixe et l'heure ne viennent pas du contact : elles ne retiennent pas l'appel.
    const requete: RequeteConnecteur = {
      ...GET,
      variables: [
        { nom: 'canal', type: 'string', origine: { type: 'fixe', valeur: 'whatsapp' } },
        { nom: 'quand', type: 'string', origine: { type: 'systeme', cle: 'maintenant' } },
      ],
    };
    const outil = OUTIL({ risk: 'read', outputPaths: ['tarifs.integrale'] });
    const h = harnais(outil, { status: 200, body: DEVIS }, requete);
    const r = await executer(outil, bacASable(h, requete));
    expect(h.appels()).toBe(1);
    expect(r.status).toBe('ok');
    expect(r.contenu).toEqual({ 'tarifs.integrale': 42.5 });
  });

  it('🔴 un POST reste simulé, et la note nomme l’appel par son LIBELLÉ, jamais par son chemin', async () => {
    // Le chemin part chez le fournisseur du modèle avec la note, et celui d'un webhook porte souvent son jeton
    // (`/services/T0/B0/<jeton>`). Le libellé est écrit pour être lu.
    const requete: RequeteConnecteur = { ...REQUETE, chemin: '/services/T0/B0/JETONSECRET' };
    const outil = OUTIL({ risk: 'read', outputPaths: ['statut'] });
    const h = harnais(outil, undefined, requete);
    const r = await executer(outil, bacASable(h, requete));
    expect(h.appels()).toBe(0);
    expect(r.contenu).toMatchObject({ simule: true });
    const note = String((r.contenu as { note?: unknown }).note);
    expect(note).toContain('« Poser une étiquette » (POST)');
    expect(JSON.stringify(r.contenu)).not.toContain('JETONSECRET');
  });

  it('🔴 un GET qui POUSSE reste simulé : le client a dit qu’il agit', async () => {
    // Un webhook d'automatisation ou une passerelle SMS appelés en GET : partis pour de vrai, ils créeraient un faux
    // lead ou enverraient un SMS depuis un essai, pour ne rendre à l'agent que `{ok, statut}`.
    const outil = OUTIL({ risk: 'read', nature: 'pousse', outputPaths: [] });
    const h = harnais(outil, { status: 200, body: DEVIS }, GET);
    const r = await executer(outil, bacASable(h, GET));
    expect(h.appels()).toBe(0);
    expect(r.contenu).toMatchObject({ simule: true });
  });

  it('🔴 un GET dont l’outil porte un risque d’écriture reste simulé', async () => {
    // Le cas d'une requête passée de POST à GET après la création de l'outil : son risque est resté `write`.
    const outil = OUTIL({ risk: 'write', outputPaths: ['statut'] });
    const h = harnais(outil, { status: 200, body: DEVIS }, GET);
    const r = await executer(outil, bacASable(h, GET));
    expect(h.appels()).toBe(0);
    expect(r.contenu).toMatchObject({ simule: true });
  });

  it('🔴 un GET qui a besoin du CONTACT reste simulé : il n’y en a pas au bac à sable', async () => {
    // `wa_id` vaudrait `bac-a-sable` et partirait tel quel : une valeur inventée, que le résolveur s'interdit.
    for (const origine of [
      { type: 'fiche', cle: 'wa_id' }, { type: 'champ', cle: 'email' }, { type: 'systeme', cle: 'derniere_saisie' },
    ] as const) {
      const requete: RequeteConnecteur = { ...GET, variables: [{ nom: 'qui', type: 'string', origine }] };
      const outil = OUTIL({ risk: 'read', outputPaths: ['statut'] });
      const h = harnais(outil, { status: 200, body: DEVIS }, requete);
      const r = await executer(outil, bacASable(h, requete));
      expect(h.appels(), origine.type).toBe(0);
      expect(r.contenu, origine.type).toMatchObject({ simule: true });
    }
  });
});
