import { describe, it, expect } from 'vitest';
import { creerResolveurMba, type DepsResolveurMba } from '../src/agent/resolvers/mba';
import { creerResolveurSimulation } from '../src/agent/resolvers/simulation';
import type { EntreeResolveur } from '../src/agent/executor';
import type { OutilDefini } from '../src/agent/catalog';
import type { FicheTrouvee, KnowledgeStore } from '../src/agent/knowledge';
import { SORTIE_SANS_SOURCE } from '../src/agent/sorties';
import { CORPS_MAX } from '../src/agent/resolvers/connaissance';

/**
 * PARITÉ de la recherche de connaissance entre la PRODUCTION et le BAC À SABLE (lot 1 du programme,
 * 2026-08-31).
 *
 * 🔴 Le bac à sable n'a de valeur que s'il rend EXACTEMENT ce que la production rendrait. La règle vivait en
 * double, à l'identique — donc à la merci du premier ajustement fait d'un seul côté — et c'est le garde-fou
 * ANTI-HALLUCINATION : « aucune fiche pertinente » impose une sortie, ce qui empêche le modèle de répondre de
 * mémoire. Un bac à sable plus indulgent laisserait croire qu'un agent sait répondre là où il transférera.
 *
 * Ce test compare les deux SORTIES, il ne relit pas le code : il tiendrait donc même si quelqu'un
 * dé-mutualisait la fonction, tant que les deux restent d'accord.
 */

const FICHE = (over: Partial<FicheTrouvee> = {}): FicheTrouvee => ({
  id: 'f1', titre: 'La piscine', corps: 'Ouverte de 9 h à 20 h.', sourceUrl: 'https://exemple.fr/p',
  termesTrouves: 3, couverture: 1, proximiteTitre: 0.9, ...over,
});

const store = (fiches: FicheTrouvee[]): KnowledgeStore => ({ chercher: async () => fiches });

function entree(args: Record<string, unknown>): EntreeResolveur {
  const outil: OutilDefini = {
    id: 'o1', tenantId: 't1', agentId: 'a1', origin: 'mba', name: 'mba_chercher_connaissance',
    description: '', params: [], binding: { handler: 'chercher_connaissance' }, sourceId: null, requestId: null,
    nePasUtiliser: '', outputPaths: [], risk: 'read', timeoutMs: 8000, maxBytes: 16384, autonome: true,
  };
  return {
    outil,
    args,
    ctx: {
      tenantId: 't1', agentId: 'a1', sessionId: 's', runId: 'r', workflowId: 'w', waId: '33600000000',
      contact: null, contactInconnu: 'tous', appelsRestants: 10, budgetRestantMicroEur: 30_000,
      deadline: Date.now() + 10_000,
    },
    signal: AbortSignal.timeout(10_000),
  };
}

/** Les deux résolveurs, câblés sur la MÊME base de connaissance. */
function lesDeux(fiches: FicheTrouvee[]) {
  const connaissance = store(fiches);
  const prod: DepsResolveurMba = {
    envoyerBloc: async () => ({ ok: true }),
    escaladerVersHumain: async () => {},
    poserTag: async () => {},
    ecrireChamp: async () => {},
    connaissance,
  };
  return { production: creerResolveurMba(prod), simulation: creerResolveurSimulation({ connaissance }) };
}

describe('recherche de connaissance : production et bac à sable rendent la MÊME chose', () => {
  it('des sources pertinentes -> contenu identique des deux côtés', async () => {
    const { production, simulation } = lesDeux([FICHE(), FICHE({ id: 'f2', titre: 'Le sauna' })]);
    const args = { requete: 'la piscine' };
    const p = await production(entree(args));
    const s = await simulation(entree(args));
    expect(s.contenu).toEqual(p.contenu);
    expect(s.sortie).toBe(p.sortie);
    expect(p.contenu).toMatchObject({ sources: [{ titre: 'La piscine' }, { titre: 'Le sauna' }] });
  });

  it('🔴 aucune fiche pertinente -> MÊME aveu ET MÊME sortie imposée (le garde-fou anti-hallucination)', async () => {
    const horsSujet = FICHE({ termesTrouves: 1, couverture: 0.1, proximiteTitre: 0.05 });
    const { production, simulation } = lesDeux([horsSujet]);
    const args = { requete: 'la capitale de la Mongolie' };
    const p = await production(entree(args));
    const s = await simulation(entree(args));
    expect(p.contenu).toEqual({ aucune_source: true });
    expect(p.sortie).toBe(SORTIE_SANS_SOURCE);
    expect(s.contenu).toEqual(p.contenu);
    expect(s.sortie).toBe(p.sortie);
  });

  it('la troncature d’une fiche longue est la même des deux côtés', async () => {
    const long = FICHE({ corps: 'a'.repeat(CORPS_MAX + 500) });
    const { production, simulation } = lesDeux([long]);
    const args = { requete: 'la piscine' };
    const p = await production(entree(args));
    const s = await simulation(entree(args));
    expect(s.contenu).toEqual(p.contenu);
    const source = (p.contenu as { sources: Array<{ contenu: string }> }).sources[0]!;
    expect(source.contenu.endsWith('...')).toBe(true);
    expect(source.contenu.length).toBe(CORPS_MAX + 3);
  });

  it('une base VIDE donne le même verdict des deux côtés', async () => {
    const { production, simulation } = lesDeux([]);
    const args = { requete: 'quoi que ce soit' };
    const p = await production(entree(args));
    const s = await simulation(entree(args));
    expect(p.contenu).toEqual({ aucune_source: true });
    expect(s.contenu).toEqual(p.contenu);
    expect(s.sortie).toBe(p.sortie);
  });
});
