import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { creerAppelConnecteur } from '../src/agent/resolvers/http';
import { creerAppelHttpScenario } from '../src/workflow/appel-http';
import { creerTravailPousseeOptOut } from '../src/crm/poussee-optout';
import type { JournalAppels } from '../src/agent/catalog';
import type { SourceAppel } from '../src/agent/sources';

/**
 * LE JOURNAL DES APPELS DE CONNECTEUR, ET SES TROIS APPELANTS (tâche 9, migration 0142).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE EST UNE EXHAUSTIVITÉ, PAS UN COMPORTEMENT. `creerAppelConnecteur` est le point
 * de passage unique des appels vers le système d'un client. Il en a trois : l'agent IA, le bloc « Appel
 * HTTP » d'un scénario, et la poussée d'un opt-out. UN SEUL journalisait ses échecs ; les deux autres
 * n'écrivaient qu'un `console.warn`, donc le client ne pouvait pas savoir que SON système avait dit non.
 * C'est le motif « une capacité câblée sur un consommateur sur trois », payé plusieurs fois dans ce dépôt.
 */

const REQUETE = {
  id: 'rq1', tenantId: 't1', sourceId: 'src1', label: 'Desabonner dans le CRM',
  methode: 'POST' as const, chemin: '/unsubscribe', parametres: [], entetes: [],
  corps: { mode: 'json' as const, gabarit: '{"phone":"{{tel}}"}' },
  variables: [{ nom: 'tel', type: 'string' as const, origine: { type: 'contact' as const, cle: 'wa_id' as const } }],
  outputPaths: ['ok'], valeursTest: {}, outils: 0, updatedAt: '2026-09-14T00:00:00.000Z',
};
/**
 * ⚠️ IL SATISFAIT `SourceAppel` EN ENTIER, sans `as never`. Il annonçait un `authMode` qui n'existe dans
 * AUCUN contrat de ce dépôt, et personne ne l'a jamais vu : le `as never` posé au point d'usage avalait
 * aussi bien la propriété inventée que le `kind` manquant. C'est la quatrième fois aujourd'hui qu'un de
 * ces casts cache un faux qui ne tient pas le contrat qu'il prétend jouer.
 */
const SOURCE: SourceAppel = {
  id: 'src1', kind: 'http', baseUrl: 'https://crm.exemple.fr',
  authKind: 'none', authHeaderName: null, authSecret: null, status: 'active',
};

/** Un journal observable : c'est lui qui rend visible ce qui, jusqu'ici, n'était écrit nulle part. */
function journalEspion() {
  const ouvertures: Array<Record<string, unknown>> = [];
  const clotures: Array<Record<string, unknown>> = [];
  const journal: JournalAppels = {
    ouvrir: async (i) => { ouvertures.push(i as unknown as Record<string, unknown>); return `ligne-${ouvertures.length}`; },
    clore: async (i) => { clotures.push(i as unknown as Record<string, unknown>); },
  };
  return { journal, ouvertures, clotures };
}

function depsConnecteur(fetchImpl: typeof fetch) {
  return {
    sources: { pourAppel: async () => SOURCE, marquerEpreuve: async () => {} },
    requetes: { parId: async () => REQUETE as never },
    fetchImpl,
    verifierResolution: async () => ({ ok: true as const }),
  };
}

const repond = (statut: number): typeof fetch => (async () => new Response(
  JSON.stringify({ ok: true }), { status: statut, headers: { 'content-type': 'application/json' } },
)) as unknown as typeof fetch;

describe('l’appel de connecteur journalise, et le journal dit QUI appelait', () => {
  it('un appel réussi ouvre puis clôt en « ok »', async () => {
    const { journal, ouvertures, clotures } = journalEspion();
    const appel = creerAppelConnecteur(depsConnecteur(repond(200)));
    const r = await appel({
      tenantId: 't1', waId: '33600', contact: null, requestId: 'rq1', maxBytes: 4096, args: {},
      signal: AbortSignal.timeout(5000),
      lecture: { nature: 'integre', champs: null } as const,
      journal: { journal, source: 'scenario', nom: 'Desabonner dans le CRM', sessionId: null, toolId: null },
    });
    expect(r.ok).not.toBe(false);
    expect(ouvertures).toHaveLength(1);
    expect(ouvertures[0]).toMatchObject({ tenantId: 't1', source: 'scenario', toolName: 'Desabonner dans le CRM', sessionId: null, origin: 'http' });
    expect(clotures[0]).toMatchObject({ status: 'ok', httpStatus: 200 });
  });

  /**
   * 🔴 LE CAS QUI DONNE SON SENS À LA TÂCHE. Sans lui, un système client qui refuse tous les appels d'un
   * scénario ne laisse AUCUNE trace consultable, et le client cherche pendant des jours pourquoi son
   * parcours ne remplit plus rien.
   */
  it('🔴 un refus du système du client est journalisé, avec son code HTTP', async () => {
    const { journal, clotures } = journalEspion();
    const appel = creerAppelConnecteur(depsConnecteur(repond(500)));
    await appel({
      tenantId: 't1', waId: '33600', contact: null, requestId: 'rq1', maxBytes: 4096, args: {},
      signal: AbortSignal.timeout(5000),
      lecture: { nature: 'pousse' } as const,
      journal: { journal, source: 'optout', nom: 'Desabonner', sessionId: null, toolId: null },
    });
    expect(clotures[0]).toMatchObject({ status: 'erreur_outil', httpStatus: 500 });
    expect(String(clotures[0]?.erreur)).toContain('http_500');
  });

  /**
   * ⚠️ `timeout` SE DISTINGUE D'UN REFUS, et c'est le signal le plus utile du journal : « votre système n'a
   * pas répondu à temps » et « votre système a refusé » appellent des corrections opposées. Le premier se
   * règle chez l'hébergeur, le second dans le code.
   */
  it('⚠️ un système qui ne répond pas à temps est journalisé en « timeout », pas en erreur', async () => {
    const { journal, clotures } = journalEspion();
    const controleur = new AbortController();
    const appel = creerAppelConnecteur(depsConnecteur((async () => {
      // On abandonne comme le ferait une échéance, puis on lève comme `fetch` le fait alors.
      controleur.abort();
      throw new Error('The operation was aborted');
    }) as unknown as typeof fetch));
    await appel({
      tenantId: 't1', waId: '33600', contact: null, requestId: 'rq1', maxBytes: 4096, args: {},
      signal: controleur.signal,
      lecture: { nature: 'integre', champs: null } as const,
      journal: { journal, source: 'scenario', nom: 'X', sessionId: null, toolId: null },
    });
    expect(clotures[0]).toMatchObject({ status: 'timeout' });
  });

  /**
   * 🔴 LE JOURNAL NE PEUT PAS FAIRE ÉCHOUER L'APPEL. Un journal muet est un désagrément ; un appel vers le
   * système d'un client qui meurt parce qu'une insertion a trébuché est un incident.
   */
  it('🔴 un journal en panne n’empêche pas l’appel de partir', async () => {
    let parti = false;
    const casse: JournalAppels = {
      ouvrir: async () => { throw new Error('base indisponible'); },
      clore: async () => { throw new Error('base indisponible'); },
    };
    const appel = creerAppelConnecteur(depsConnecteur((async () => {
      parti = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch));
    const r = await appel({
      tenantId: 't1', waId: '33600', contact: null, requestId: 'rq1', maxBytes: 4096, args: {},
      signal: AbortSignal.timeout(5000), lecture: { nature: 'integre', champs: null } as const,
      journal: { journal: casse, source: 'scenario', nom: 'X', sessionId: null, toolId: null },
    });
    expect(parti, 'l’appel doit partir malgré le journal en panne').toBe(true);
    expect(r.ok).not.toBe(false);
  });

  /**
   * ⚠️ LE TÉMOIN DANS L'AUTRE SENS : `journal: null` est une DÉCISION (le résolveur d'agent, dont
   * l'exécuteur journalise déjà au-dessus). Sans ce cas, un enveloppement qui journaliserait TOUJOURS
   * passerait tous les tests précédents tout en écrivant DEUX lignes par appel d'agent.
   */
  it('⚠️ `journal: null` n’écrit rien du tout', async () => {
    const { journal, ouvertures } = journalEspion();
    const appel = creerAppelConnecteur(depsConnecteur(repond(200)));
    await appel({
      tenantId: 't1', waId: '33600', contact: null, requestId: 'rq1', maxBytes: 4096, args: {},
      signal: AbortSignal.timeout(5000), lecture: { nature: 'integre', champs: null } as const, journal: null,
    });
    expect(ouvertures).toEqual([]);
    expect(journal).toBeDefined(); // le journal existe, il n'est simplement pas passé
  });
});

describe('les deux appelants qui ne journalisaient RIEN le font', () => {
  it('🔴 le bloc « Appel HTTP » d’un scénario', async () => {
    const { journal, ouvertures } = journalEspion();
    const bloc = creerAppelHttpScenario({
      ...depsConnecteur(repond(500)),
      projectionContact: async () => ({ nom: 'Julie', tags: [], champs: {} }),
      journalAppels: journal,
      libelleRequete: async () => 'Chercher une commande',
    });
    const r = await bloc('t1', '33600', 'rq1');
    expect(r.ok, 'un 500 vide le champ, comme avant').toBe(false);
    expect(ouvertures[0]).toMatchObject({ source: 'scenario', toolName: 'Chercher une commande' });
  });

  it('⚠️ ...et sans libellé lisible, il journalise quand même, avec l’identifiant', async () => {
    const { journal, ouvertures } = journalEspion();
    const bloc = creerAppelHttpScenario({
      ...depsConnecteur(repond(500)),
      projectionContact: async () => null,
      journalAppels: journal,
    });
    await bloc('t1', '33600', 'rq1');
    // Une ligne incomplète vaut mieux que pas de ligne : même doctrine que `workflow_advance_failures`.
    expect(ouvertures[0]).toMatchObject({ source: 'scenario', toolName: 'rq1' });
  });

  it('🔴 la poussée d’un opt-out, qui est le cas le plus important des trois', async () => {
    const { journal, ouvertures, clotures } = journalEspion();
    const travail = creerTravailPousseeOptOut({
      ...depsConnecteur(repond(500)),
      requeteConfiguree: async () => 'rq1',
      projectionContact: async () => ({ nom: 'Julie', tags: [], champs: {} }),
      journalAppels: journal,
      libelleRequete: async () => 'Desabonner dans le CRM',
    });
    await expect(travail({ tenantId: 't1', waIds: ['33600', '33601'] })).rejects.toThrow(/appels en echec/);
    // UNE ligne par personne : un lot qui n'en écrirait qu'une cacherait les autres refus non poussés.
    expect(ouvertures).toHaveLength(2);
    expect(ouvertures[0]).toMatchObject({ source: 'optout', toolName: 'Desabonner dans le CRM' });
    expect(clotures).toHaveLength(2);
  });

  /**
   * ⚠️ LE TÉMOIN : sans journal câblé, les deux retombent EXACTEMENT sur le comportement d'avant. Sans ce
   * cas, on pourrait rendre la dépendance obligatoire sans s'en apercevoir, et casser tous les harnais.
   */
  it('⚠️ sans journal câblé, les deux marchent comme avant', async () => {
    const bloc = creerAppelHttpScenario({
      ...depsConnecteur(repond(200)),
      projectionContact: async () => null,
    });
    expect((await bloc('t1', '33600', 'rq1')).ok).toBe(true);
  });
});

/**
 * 🔴 L'EXHAUSTIVITÉ EST DÉRIVÉE DU FICHIER, PAS RECOPIÉE ICI. Un quatrième appelant de
 * `creerAppelConnecteur` devra écrire son `journal:`, parce que le champ est OBLIGATOIRE dans
 * `AppelConnecteur` : le compilateur le lui dira. Ce test garde la propriété qui rend cela vrai, parce
 * qu'un `journal?:` optionnel la ferait disparaître sans qu'aucun test ne rougisse.
 */
describe('🔴 le journal reste OBLIGATOIRE dans le contrat d’appel', () => {
  it('`AppelConnecteur.journal` n’est pas optionnel', () => {
    const source = readFileSync(new URL('../src/agent/resolvers/http.ts', import.meta.url), 'utf8');
    // Le champ, sans commentaires : la prose de ce fichier cite plusieurs fois le mot `journal`.
    const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code, 'le champ doit exister dans le contrat').toMatch(/journal: JournalDAppel \| null;/);
    expect(code, 'un `journal?:` optionnel se ferait oublier au prochain appelant').not.toMatch(/journal\?: JournalDAppel/);
  });
});
