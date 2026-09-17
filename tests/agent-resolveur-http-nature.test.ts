import { describe, it, expect } from 'vitest';
import { creerResolveurHttp } from '../src/agent/resolvers/http';
import { connecteurSimule } from '../src/agent/resolvers/simulation';
import type { EntreeResolveur } from '../src/agent/executor';
import type { OutilDefini } from '../src/agent/catalog';
import type { SourceAppel } from '../src/agent/sources';
import type { RequeteConnecteur } from '../src/agent/requetes';
import { SANS_MCP } from './outils-mcp';

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
  ...SANS_MCP,
  id: 'to1', tenantId: 't1', origin: 'http', sourceId: 'src1', requestId: 'rq1', nePasUtiliser: '',
  name: 'poser_etiquette', description: 'pose une étiquette', params: [], binding: {},
  nature: 'integre', outputPaths: ['statut'],
  risk: 'write', timeoutMs: 5_000, maxBytes: 16_384, autonome: false,
  ...over,
});

/** La réponse du système du client : un succès BAVARD, celui qui rend la question intéressante. */
const CORPS = JSON.stringify({ statut: 'ok', email: 'client@exemple.test', interne: 'CRM-9182' });

function harnais(outil: OutilDefini, reponse: { status: number; body: string } = { status: 200, body: CORPS }) {
  const epreuves: Array<{ ok: boolean }> = [];
  const fetchImpl = (async () => new Response(reponse.body, {
    status: reponse.status, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;

  const resolveur = creerResolveurHttp({
    sources: {
      pourAppel: async () => SOURCE,
      marquerEpreuve: async (_t, _i, ok) => { epreuves.push({ ok }); },
    },
    requetes: { parId: async () => REQUETE },
    derniereSaisie: async () => null,
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
  return { resolveur, entree, epreuves };
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
