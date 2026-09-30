import { describe, it, expect, vi } from 'vitest';
import { valeurPourChamp, creerAppelHttpScenario } from '../src/workflow/appel-http';
import { walk } from '../src/workflow/engine';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * Le bloc « Appel HTTP » d'un scénario.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : le bloc ne DÉCRIT aucun appel, il en DÉSIGNE un. Toutes les gardes (source
 * active, filtre de sortie, variables requises, adresse interne, échéance, corps borné) vivent dans
 * `creerAppelConnecteur`, partagé avec l'agent IA et couvert par ses propres tests. Ici on vérifie ce qui est
 * PROPRE au scénario : ce qui devient la valeur d'un champ, et ce qui arrive quand l'appel échoue.
 */

describe('valeurPourChamp', () => {
  it('🔴 UN seul champ déclaré -> sa valeur NUE, pas du JSON', () => {
    // C'est le cas courant, et y ranger `{"statut":"expédiée"}` obligerait le client à écrire une condition
    // sur du JSON, ce que l'écran de condition ne sait pas faire.
    expect(valeurPourChamp({ statut: 'expédiée' })).toBe('expédiée');
    expect(valeurPourChamp({ 'livraison.jours': 3 })).toBe('3');
    expect(valeurPourChamp({ actif: false })).toBe('false');
  });

  it('plusieurs champs -> l’objet JSON, faute de pouvoir en choisir un honnêtement', () => {
    expect(valeurPourChamp({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });

  it('une valeur STRUCTURÉE sous un seul chemin reste du JSON', () => {
    expect(valeurPourChamp({ livraison: { date: '2026-09-11' } })).toBe('{"date":"2026-09-11"}');
  });

  it('⚠️ rien de lisible -> chaîne vide, comme un échec', () => {
    // Le scénario branche ensuite sur « le champ est vide ». Distinguer « pas reçu » de « reçu vide »
    // demanderait un second champ que personne n'a demandé.
    expect(valeurPourChamp({})).toBe('');
    expect(valeurPourChamp({ a: null })).toBe('');
    expect(valeurPourChamp(null)).toBe('');
    expect(valeurPourChamp('texte')).toBe('');
    expect(valeurPourChamp([1, 2])).toBe('');
  });
});

describe('le bloc dans le graphe', () => {
  const graphe = (data: Record<string, unknown>): WorkflowGraph => ({
    nodes: [
      { id: 'a', type: 'http', data, position: { x: 0, y: 0 } },
      { id: 'b', type: 'quick_message', data: { body: 'suite' }, position: { x: 0, y: 0 } },
    ],
    edges: [{ id: 'e', source: 'a', target: 'b' }],
  });

  it('🔴 un bloc réglé produit l’action, et le parcours CONTINUE', () => {
    // Action SYNCHRONE non bloquante, comme un tag : le walk est pur, l'exécuteur fait l'IO, et le contact
    // reçoit la suite sans attendre que le connecteur réponde à l'écran.
    const r = walk(graphe({ requestId: 'req-1', champCible: 'statut_commande' }), 'a');
    expect(r.actions.map((s) => s.action)).toContainEqual({
      kind: 'appelHttp', requestId: 'req-1', champCible: 'statut_commande',
    });
  });

  it('⚠️ un bloc SANS APPEL choisi ne fait RIEN, et ne casse pas le parcours', () => {
    // Un scénario en production ne doit pas s'arrêter parce qu'un bloc est incomplet : il ne fait rien, et
    // l'écran le montre. Même traitement qu'un bloc tag sans tag.
    for (const data of [{}, { champCible: 'x' }, { requestId: '  ', champCible: 'x' }]) {
      expect(walk(graphe(data), 'a').actions.some((s) => s.action.kind === 'appelHttp')).toBe(false);
    }
  });

  it('🔴 un appel choisi SANS champ cible est un appel qui POUSSE, pas un bloc incomplet', () => {
    // Envoyer un événement à Brevo (réponse 204, rien à ranger) : exiger un champ obligeait à garder un
    // identifiant inutile, et un appel sans réponse n'avait même rien à cocher.
    const r = walk(graphe({ requestId: 'req-1' }), 'a');
    expect(r.actions.map((s) => s.action)).toContainEqual({ kind: 'appelHttp', requestId: 'req-1', champCible: '' });
  });
});

describe('le câblage du bloc', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    sources: {
      pourAppel: async () => ({
        id: 's1', kind: 'http' as const, baseUrl: 'https://api.client.fr/v1', authKind: 'none' as const,
        authHeaderName: null, authSecret: null, status: 'active' as const,
      }),
      marquerEpreuve: async () => {},
    },
    requetes: {
      parId: async () => ({
        id: 'req-1', tenantId: 't1', sourceId: 's1', label: 'Statut',
        methode: 'GET' as const, chemin: '/commandes', parametres: [], entetes: [],
        corps: { mode: 'aucun' as const }, variables: [], outputPaths: ['statut'],
        valeursTest: {}, outils: 0, updatedAt: '2026-09-11T00:00:00.000Z',
      }),
    },
    projectionContact: async () => ({ nom: 'Jean', tags: [], champs: {} }),
    verifierResolution: async () => ({ ok: true }),
    ...over,
  });

  it('🔴 une réponse lisible devient la valeur du champ', async () => {
    const appel = creerAppelHttpScenario(deps({
      fetchImpl: (async () => new Response('{"statut":"expédiée"}', { status: 200 })) as unknown as typeof fetch,
    }) as never);
    expect(await appel('t1', '33600000001', 'req-1', 'integre')).toEqual({ ok: true, valeur: 'expédiée' });
  });

  it('🔴 un connecteur en panne rend `ok: false` et une valeur VIDE, il ne LÈVE pas', async () => {
    // Laisser l'exception remonter arrêterait le parcours du contact au milieu, pour une panne qui ne le
    // concerne pas. L'exécuteur vide alors le champ, ce qui se teste dans une condition.
    const appel = creerAppelHttpScenario(deps({
      fetchImpl: (async () => { throw new Error('réseau'); }) as unknown as typeof fetch,
    }) as never);
    expect(await appel('t1', '33600000001', 'req-1', 'integre')).toEqual({ ok: false, valeur: '' });
  });

  it('🔴 une requête introuvable NE PART PAS sur le réseau', async () => {
    const fetchImpl = vi.fn();
    const appel = creerAppelHttpScenario(deps({
      requetes: { parId: async () => null },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }) as never);
    expect(await appel('t1', '33600000001', 'req-absente', 'integre')).toEqual({ ok: false, valeur: '' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('🔴 une source INACTIVE ne part pas non plus', async () => {
    // La garde vit dans le code partagé avec l'agent IA : ce test vérifie qu'elle s'applique AUSSI par ce
    // chemin-ci, ce qui est tout l'intérêt d'avoir extrait l'appel au lieu de le réécrire.
    const fetchImpl = vi.fn();
    const appel = creerAppelHttpScenario(deps({
      sources: {
        pourAppel: async () => ({
          id: 's1', kind: 'http' as const, baseUrl: 'https://api.client.fr/v1', authKind: 'none' as const,
          authHeaderName: null, authSecret: null, status: 'disabled' as const,
        }),
        marquerEpreuve: async () => {},
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }) as never);
    expect(await appel('t1', '33600000001', 'req-1', 'integre')).toEqual({ ok: false, valeur: '' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('un appel qui POUSSE (bloc sans champ cible)', () => {
    // La requête ne déclare AUCUN champ de réponse : c'est le cas d'un événement Brevo, qui répond 204.
    const sansSortie = {
      requetes: {
        parId: async () => ({
          id: 'req-1', tenantId: 't1', sourceId: 's1', label: 'Événement',
          methode: 'POST' as const, chemin: '/events', parametres: [], entetes: [],
          corps: { mode: 'aucun' as const }, variables: [], outputPaths: [],
          valeursTest: {}, outils: 0, updatedAt: '2026-09-30T00:00:00.000Z',
        }),
      },
    };

    it('🔴 un 204 SANS CORPS est un succès, sans champ de réponse déclaré', async () => {
      const appel = creerAppelHttpScenario(deps({
        ...sansSortie,
        fetchImpl: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
      }) as never);
      expect(await appel('t1', '33600000001', 'req-1', 'pousse')).toEqual({ ok: true, valeur: '' });
    });

    it('🔴 la même requête en INTÈGRE reste refusée : rien à lire, et elle ne part pas', async () => {
      // L'autre sens : c'est bien le bloc sans champ qui ouvre la poussée, pas un assouplissement général.
      const fetchImpl = vi.fn();
      const appel = creerAppelHttpScenario(deps({ ...sansSortie, fetchImpl: fetchImpl as unknown as typeof fetch }) as never);
      expect(await appel('t1', '33600000001', 'req-1', 'integre')).toEqual({ ok: false, valeur: '' });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('un refus du système du client (4xx) reste un échec', async () => {
      const appel = creerAppelHttpScenario(deps({
        ...sansSortie,
        fetchImpl: (async () => new Response('{"message":"bad"}', { status: 400 })) as unknown as typeof fetch,
      }) as never);
      expect(await appel('t1', '33600000001', 'req-1', 'pousse')).toEqual({ ok: false, valeur: '' });
    });
  });
});
