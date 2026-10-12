import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  appliquerProposition, nomLibre, restreindreProposition, type Changement, type PropositionConstruction,
} from '../web/lib/api-agent-setup';
import { PLACEHOLDER, textesDuType } from '../web/lib/mba-outils';

/**
 * « ENREGISTRER » POSE L'OUTIL QUI LANCE LE SCÉNARIO D'UN MOMENT (décision de Julien du 2026-10-12). Le serveur a
 * rapproché le moyen d'un scénario en ligne et rendu sa ligne de diff ; la console pose l'outil par la route du bouton
 * « Ajouter un outil », éteint, avec la consigne de l'onglet Outils complétée de la situation gardée.
 */

// Le socle HTTP de la console est remplacé (`vi.mock` passe avant les imports) : ce test ne touche aucun réseau, il
// note ce que `request` reçoit et rend les outils déjà posés.
const etat = vi.hoisted(() => ({
  appels: [] as Array<{ path: string; method: string; body: Record<string, unknown> | null }>,
  poses: [] as Array<Record<string, unknown>>,
}));
vi.mock('../web/lib/http', () => ({
  request: (path: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    etat.appels.push({ path, method, body });
    if (method === 'GET' && path.endsWith('/tools')) return Promise.resolve({ outils: etat.poses, catalogue: [] });
    if (method === 'POST' && path.endsWith('/tools')) return Promise.resolve({ outil: { id: `cree-${etat.appels.length}` } });
    return Promise.resolve({ outil: {} });
  },
}));

const DEVIS = { workflowId: '44444444-4444-4444-8444-444444444444', nom: 'SMATIS Devis (flow)', moment: 'le client veut faire un devis' };
const RDV = { workflowId: '55555555-5555-4555-8555-555555555555', nom: 'Prise de RDV', moment: 'il veut un rendez-vous' };
const PROPOSITION: PropositionConstruction = { fiche: {}, outils: [], scenarios: [DEVIS, RDV] };
const CHANGEMENTS: Changement[] = [
  { champ: `scenario.${DEVIS.workflowId}`, label: 'Outil', avant: '', apres: 'veut faire un devis' },
  { champ: `scenario.${RDV.workflowId}`, label: 'Outil', avant: '', apres: 'veut un rendez-vous' },
];

beforeEach(() => { etat.appels.length = 0; etat.poses.length = 0; });

describe('restreindreProposition, les scénarios', () => {
  it('🔴 une ligne jetée ne pose rien, une ligne corrigée part avec le texte du client', () => {
    const g = new Map([[`scenario.${DEVIS.workflowId}`, 'demande un devis pour sa toiture']]);
    const r = restreindreProposition(PROPOSITION, CHANGEMENTS, g);
    expect(r.scenarios).toEqual([{ ...DEVIS, situation: 'demande un devis pour sa toiture' }]);
  });

  it('🔴 un scénario sans ligne de diff ne part pas : poser un outil qui envoie exige un geste sur sa ligne', () => {
    expect(restreindreProposition(PROPOSITION, [], new Map()).scenarios).toEqual([]);
  });
});

describe('appliquerProposition, les scénarios', () => {
  const posee = (p: PropositionConstruction) => appliquerProposition('t1', 'ag1', p, 4);

  it('🔴 pose l’outil « Lancer un scénario » qui VISE le scénario, avec la consigne de l’onglet Outils', async () => {
    await posee({ fiche: {}, outils: [], scenarios: [{ ...DEVIS, situation: 'veut faire un devis' }] });
    const ajout = etat.appels.find((a) => a.method === 'POST');
    expect(ajout).toEqual({
      path: '/tenants/t1/agents/ag1/tools', method: 'POST',
      body: { handler: 'lancer_scenario', name: 'lancer_smatis_devis_flow', cible: { workflowId: DEVIS.workflowId } },
    });
    const mots = etat.appels.find((a) => a.method === 'PATCH')!;
    expect(mots.path).toMatch(/\/tools\/cree-\d+$/);
    const textes = textesDuType('scenario', 'agent');
    expect(mots.body).toEqual({
      title: 'Lancer « SMATIS Devis (flow) »',
      description: textes.quand[0].replace(PLACEHOLDER, 'veut faire un devis'),
      nePasUtiliser: textes.pasQuand[0],
    });
    // La consigne est complète : le formulaire de l'onglet refuserait un texte qui garde son « [décrivez la situation] ».
    expect(String(mots.body!.description)).not.toContain(PLACEHOLDER);
    // Aucune activation : l'outil naît éteint, l'allumer reste au client.
    expect(etat.appels.some((a) => /activ/.test(a.path))).toBe(false);
  });

  it('🔴 un scénario que l’agent lance déjà est sauté, un nom pris prend un suffixe', async () => {
    etat.poses.push(
      { id: 'x1', name: 'lancer_prise_de_rdv', origin: 'mba', binding: { handler: 'poser_tag', tag: 'rdv' } },
      { id: 'x2', name: 'mba_lancer_scenario', origin: 'mba', binding: { handler: 'lancer_scenario', workflowId: DEVIS.workflowId } },
    );
    await posee({ fiche: {}, outils: [], scenarios: [{ ...DEVIS, situation: 'a' }, { ...RDV, situation: 'b' }] });
    const ajouts = etat.appels.filter((a) => a.method === 'POST');
    expect(ajouts.map((a) => a.body)).toEqual([
      { handler: 'lancer_scenario', name: 'lancer_prise_de_rdv_2', cible: { workflowId: RDV.workflowId } },
    ]);
  });

  it('sans scénario ni outil, n’appelle rien', async () => {
    await posee({ fiche: {}, outils: [], scenarios: [] });
    expect(etat.appels).toEqual([]);
  });
});

describe('nomLibre', () => {
  it('rend la base, sinon le premier suffixe libre, dans les 64 caractères', () => {
    expect(nomLibre('lancer_x', new Set())).toBe('lancer_x');
    expect(nomLibre('lancer_x', new Set(['lancer_x', 'lancer_x_2']))).toBe('lancer_x_3');
    const long = `lancer_${'a'.repeat(80)}`;
    expect(nomLibre(long, new Set([long.slice(0, 64)]))).toHaveLength(64);
    expect(nomLibre('', new Set())).toBe('lancer_scenario');
  });
});
