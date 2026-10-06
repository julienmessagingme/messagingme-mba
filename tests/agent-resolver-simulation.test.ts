import { describe, it, expect, vi } from 'vitest';
import { creerResolveurSimulation } from '../src/agent/resolvers/simulation';
import type { EntreeResolveur } from '../src/agent/executor';
import type { OutilDefini } from '../src/agent/catalog';
import type { FicheTrouvee, KnowledgeStore } from '../src/agent/knowledge';
import { SORTIE_SANS_SOURCE } from '../src/agent/sorties';
import { SANS_MCP } from './outils-mcp';
import { AUCUN_GESTE } from './gestes';

/**
 * Le résolveur du BAC À SABLE.
 *
 * 🔴 LA RÈGLE EST CELLE DU MONDE RÉEL : un outil qui LIT s'exécute, un outil qui AGIT est simulé. Il n'y a ni
 * contact, ni conversation, ni parcours dans un bac à sable : poser un tag écrirait sur une vraie fiche du
 * mini-CRM, envoyer un bloc partirait chez un vrai numéro. La recherche de connaissance, elle, tourne pour
 * de vrai, et c'est le point : c'est elle qu'on veut éprouver, puisque tout ce que l'agent a le droit de
 * dire vient de là.
 *
 * 🔴 ET LA SIMULATION LE DIT AU MODÈLE. Lui laisser croire que l'action a eu lieu ferait un test menteur :
 * l'agent enchaînerait comme si le tag était posé, et le client réglerait la suite sur une prémisse fausse.
 */

const FICHE = (over: Partial<FicheTrouvee> = {}): FicheTrouvee => ({
  id: 'f1', titre: 'La piscine', corps: 'Ouverte de 9 h à 20 h.', sourceUrl: 'https://exemple.fr/p',
  termesTrouves: 3, couverture: 1, proximiteTitre: 0.9, ...over,
});

/** Les cibles fixées (RC4), telles que la pose les écrit dans `binding`. */
const WF = '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b';
const CIBLES: Record<string, Record<string, unknown>> = {
  poser_tag: { handler: 'poser_tag', tag: 'vip' },
  ecrire_variable: { handler: 'ecrire_variable', champ: 'ville', valeurs: [] },
  envoyer_bloc: { handler: 'envoyer_bloc', workflowId: WF, code: 'nod_t1_01HZX5Y6Z7A8B9C0D1E2F3G4H5' },
  lancer_scenario: { handler: 'lancer_scenario', workflowId: WF },
};

function entree(handler: string, args: Record<string, unknown> = {}, binding: Record<string, unknown> = CIBLES[handler] ?? { handler }): EntreeResolveur {
  const outil: OutilDefini = { ...SANS_MCP, ...AUCUN_GESTE(),
    id: 'o1', tenantId: 't1', origin: 'mba', name: `mba_${handler}`,
    description: '', params: [], binding, sourceId: null, requestId: null, nePasUtiliser: '', nature: 'integre' as const, outputPaths: [], risk: 'write',
    timeoutMs: 8000, maxBytes: 16384, autonome: true,
  };
  return {
    outil,
    args,
    ctx: {
      tenantId: 't1', agentId: 'a1', sessionId: 'bac-a-sable', runId: 'bac-a-sable',
      workflowId: 'bac-a-sable', waId: 'bac-a-sable', contact: null, contactInconnu: 'tous',
      appelsRestants: 10, budgetRestantMicroEur: 30_000, deadline: Date.now() + 10_000,
    },
    signal: AbortSignal.timeout(10_000),
  };
}

const store = (fiches: FicheTrouvee[]): KnowledgeStore => ({ chercher: async () => fiches });

describe('résolveur de simulation', () => {
  it('🔴 la recherche de connaissance s’exécute POUR DE VRAI', async () => {
    const r = await creerResolveurSimulation({ connaissance: store([FICHE()]) })(entree('chercher_connaissance', { requete: 'la piscine' }));
    expect(r.contenu).toMatchObject({ sources: [{ titre: 'La piscine' }] });
    expect(r.sortie).toBeUndefined();
  });

  it('🔴 et elle rend la MÊME sortie qu’en production quand elle ne trouve rien', async () => {
    // Un bac à sable qui adoucirait le garde-fou laisserait croire que l'agent sait répondre là où il
    // transférera. C'est précisément ce qu'on vient tester.
    const horsSujet = FICHE({ termesTrouves: 1, couverture: 0.1, proximiteTitre: 0.05 });
    const r = await creerResolveurSimulation({ connaissance: store([horsSujet]) })(entree('chercher_connaissance', { requete: 'la capitale de la Mongolie' }));
    expect(r.contenu).toEqual({ aucune_source: true });
    expect(r.sortie).toBe(SORTIE_SANS_SOURCE);
  });

  it('une requête vide est un échec métier, pas une exception', async () => {
    const r = await creerResolveurSimulation({ connaissance: store([]) })(entree('chercher_connaissance', {}));
    expect(r.ok).toBe(false);
  });

  it('terminer s’exécute vraiment : c’est ce qui montre par quelle règle d’arrêt l’agent sort', async () => {
    const r = await creerResolveurSimulation({ connaissance: store([]) })(entree('terminer', { sortie: 'rdv_pris' }));
    expect(r.sortie).toBe('rdv_pris');
  });

  it('🔴 terminer rend son dernier message ROGNÉ, comme en production, et rien pour un message blanc', async () => {
    // C'est ce que le bac à sable montre et archive : un terminer simulé qui le perdrait ferait croire au
    // client que son agent sort en silence.
    const resolveur = creerResolveurSimulation({ connaissance: store([]) });
    expect(await resolveur(entree('terminer', { sortie: 'rdv_pris', message: ' Rendez-vous noté, à jeudi. ' })))
      .toEqual({ contenu: { sortie: 'rdv_pris' }, sortie: 'rdv_pris', dernierMessage: 'Rendez-vous noté, à jeudi.' });
    for (const vide of [{}, { message: '' }, { message: '   ' }]) {
      expect(await resolveur(entree('terminer', { sortie: 'rdv_pris', ...vide })), JSON.stringify(vide))
        .not.toHaveProperty('dernierMessage');
    }
  });

  it('lire le contact rend « inconnu », et c’est la VÉRITÉ du bac à sable', async () => {
    const r = await creerResolveurSimulation({ connaissance: store([]) })(entree('lire_contact'));
    expect(r.contenu).toEqual({ connu: false });
  });

  it('🔴 les outils à EFFET sont simulés, et le DISENT', async () => {
    const resolveur = creerResolveurSimulation({ connaissance: store([]) });
    for (const [handler, args] of [
      ['poser_tag', {}],
      ['ecrire_variable', { valeur: 'Lyon' }],
      ['envoyer_bloc', {}],
      ['escalader', {}],
    ] as const) {
      const r = await resolveur(entree(handler, args));
      const contenu = r.contenu as { simule?: boolean; note?: string };
      expect(contenu.simule, handler).toBe(true);
      expect(contenu.note, handler).toContain('n\'a PAS eu lieu');
      // Aucun de ces appels ne rend la main ni ne sort : le client doit pouvoir voir la SUITE.
      expect(r.sortie, handler).toBeUndefined();
      expect(r.rendu, handler).toBeUndefined();
    }
  });

  it('l’escalade simulée ne rend PAS la main', async () => {
    // En production, `rendu` arrête le tour parce que la conversation est passée à un humain. Ici il n'y a
    // personne à qui la passer, et arrêter le tour empêcherait de voir ce que l'agent aurait dit ensuite.
    const r = await creerResolveurSimulation({ connaissance: store([]) })(entree('escalader'));
    expect(r.rendu).toBeUndefined();
  });

  it('les cibles simulées sont RENDUES, pour que l’écran les montre, et viennent de la cible, pas du modèle (RC4)', async () => {
    const simulation = creerResolveurSimulation({ connaissance: store([]) });
    expect((await simulation(entree('poser_tag', { tag: 'autre' }))).contenu).toMatchObject({ tag: 'vip' });
    expect((await simulation(entree('ecrire_variable', { cle: 'opt_in', valeur: 'Lyon' }))).contenu).toMatchObject({ champ: 'ville', valeur: 'Lyon' });
    expect((await simulation(entree('envoyer_bloc', { code: 'nod_autre' }))).contenu).toMatchObject({ code: 'nod_t1_01HZX5Y6Z7A8B9C0D1E2F3G4H5' });
  });

  it('🔴 RC4 : un outil à cible mal configuré refuse au bac à sable comme en production', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const simulation = creerResolveurSimulation({ connaissance: store([]) });
    for (const h of ['poser_tag', 'ecrire_variable', 'envoyer_bloc', 'lancer_scenario']) {
      const r = await simulation(entree(h, {}, { handler: h }));
      expect(r.ok, h).toBe(false);
      expect(JSON.stringify(r.contenu), h).toContain('outil mal configuré');
    }
  });

  it('🔴 RC4 : « lancer un scénario » simulé est TERMINAL comme en production, et dit qu’il n’a rien lancé', async () => {
    // Un essai qui continuerait montrerait l'agent parler par-dessus un scénario, ce que la production ne fait jamais.
    const r = await creerResolveurSimulation({ connaissance: store([]) })(entree('lancer_scenario'));
    expect(r.scenarioLance).toBe(true);
    expect(r.contenu).toMatchObject({ simule: true, workflowId: WF });
    expect(JSON.stringify(r.contenu)).toContain('PAS été lancé');
    expect(r.sortie).toBeUndefined();
    expect(r.rendu).toBeUndefined();
  });

  it('un handler inconnu est un échec métier lisible, jamais une exception', async () => {
    const r = await creerResolveurSimulation({ connaissance: store([]) })(entree('rm_rf'));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.contenu)).toContain('inconnu');
  });
});
