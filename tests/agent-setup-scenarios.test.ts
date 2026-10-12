import { describe, it, expect } from 'vitest';
import {
  champScenario, scenarioDuMoyen, scenariosAPoser, scenariosDesMoments, situationDuMoment,
} from '../src/agent/setup/scenarios';
import { agendaEffectif, type Inventaire } from '../src/agent/setup/couverture';

/**
 * Le scénario d'un moment, choisi dans l'entretien de construction et posé par « Enregistrer » (décision de Julien du
 * 2026-10-12, plan `docs/superpowers/plans/2026-10-12-scenario-dans-l-entretien.md`). 🔴 La cible vient de la liste
 * réelle des scénarios en ligne, jamais d'un nom rendu par le modèle.
 */
const DEVIS = { id: '11111111-1111-4111-8111-111111111111', nom: 'SMATIS Devis (flow)' };
const RDV = { id: '22222222-2222-4222-8222-222222222222', nom: 'Prise de rendez-vous' };
const RDV_VIP = { id: '33333333-3333-4333-8333-333333333333', nom: 'Prise de rendez-vous VIP' };
const EN_LIGNE = [DEVIS, RDV, RDV_VIP];

describe('scenarioDuMoyen', () => {
  it('🔴 reconnaît le nom exact, à la casse, aux accents et aux guillemets près', () => {
    expect(scenarioDuMoyen('smatis devis (FLOW)', EN_LIGNE)).toBe(DEVIS);
    expect(scenarioDuMoyen('« SMATIS Devis (flow) »', EN_LIGNE)).toBe(DEVIS);
    expect(scenarioDuMoyen('prise de rendez-vous', EN_LIGNE)).toBe(RDV);
  });

  it('🔴 reconnaît un nom contenu dans la réponse du client', () => {
    expect(scenarioDuMoyen('il faut lancer le scénario SMATIS Devis (flow) bien sûr', EN_LIGNE)).toBe(DEVIS);
  });

  it('reconnaît une réponse contenue dans un SEUL nom', () => {
    expect(scenarioDuMoyen('devis', EN_LIGNE)).toBe(DEVIS);
  });

  it('🔴 ne devine pas entre deux candidats : aucun', () => {
    // « rendez-vous » est contenu dans deux noms : ni l'un ni l'autre.
    expect(scenarioDuMoyen('rendez-vous', EN_LIGNE)).toBeNull();
    // Deux noms contenus dans la réponse : aucun non plus.
    expect(scenarioDuMoyen('SMATIS Devis (flow) ou Prise de rendez-vous', [DEVIS, RDV])).toBeNull();
  });

  it('une réponse vide ou étrangère ne désigne rien', () => {
    expect(scenarioDuMoyen('   ', EN_LIGNE)).toBeNull();
    expect(scenarioDuMoyen('je ne sais pas encore', EN_LIGNE)).toBeNull();
    expect(scenarioDuMoyen('devis', [])).toBeNull();
  });
});

describe('scenariosDesMoments et scenariosAPoser', () => {
  const bascules = [
    { moment: 'le client veut faire un devis', action: 'scenario' as const, moyen: 'SMATIS Devis (flow)' },
    { moment: 'le client veut parler à un conseiller', action: 'humain' as const, moyen: 'SMATIS Devis (flow)' },
    { moment: 'il veut un rendez-vous', action: 'scenario' as const, moyen: 'rendez-vous' },
    { moment: 'il redemande un devis', action: 'scenario' as const, moyen: 'devis' },
  ];

  it('🔴 un moment « scénario » reconnu propose un outil ; un autre type d’action, ou un moyen ambigu, rien', () => {
    const des = scenariosDesMoments(bascules, EN_LIGNE, new Set());
    expect(des.map((d) => d.moment)).toEqual(['le client veut faire un devis', 'il redemande un devis']);
    expect(scenariosAPoser(des)).toEqual([
      { workflowId: DEVIS.id, nom: DEVIS.nom, moment: 'le client veut faire un devis' },
    ]);
  });

  it('🔴 un scénario que l’agent lance déjà n’est pas reproposé', () => {
    const des = scenariosDesMoments(bascules, EN_LIGNE, new Set([DEVIS.id]));
    expect(des.every((d) => d.dejaVise)).toBe(true);
    expect(scenariosAPoser(des)).toEqual([]);
  });

  it('la clé de la ligne de diff porte le scénario', () => {
    expect(champScenario(DEVIS.id)).toBe(`scenario.${DEVIS.id}`);
  });
});

describe('situationDuMoment', () => {
  it('🔴 complète « dès que le client … » sans répéter le sujet ni la ponctuation', () => {
    expect(situationDuMoment('Quand le client veut faire un devis.')).toBe('veut faire un devis');
    expect(situationDuMoment('le client a une question sur son dossier')).toBe('a une question sur son dossier');
    expect(situationDuMoment('il veut prendre rendez-vous')).toBe('veut prendre rendez-vous');
    expect(situationDuMoment('demande de devis')).toBe('demande de devis');
  });
});

describe('la question du moyen d’un moment « scénario »', () => {
  const question = (scenarios?: string[]): string => {
    const inv: Inventaire = { outilsApi: [], outilsMcp: [], systemesApi: [], mcp: [], ...(scenarios ? { scenarios } : {}) };
    const etat = { poses: [], reponses: [], bascules: [{ moment: 'le client veut faire un devis', action: 'scenario' as const }] };
    return agendaEffectif(etat, inv).find((p) => p.code === 'bascule_1_moyen')!.question;
  };

  it('🔴 liste les scénarios en ligne par leur nom', () => {
    // Julien, 2026-10-12 : il devait taper de mémoire le nom de « SMATIS Devis (flow) », et rien n'arrivait dans Outils.
    const q = question(['SMATIS Devis (flow)', 'Prise de rendez-vous']);
    expect(q).toMatch(/Vos scénarios en ligne/);
    expect(q).toContain('SMATIS Devis (flow)');
    expect(q).toContain('Prise de rendez-vous');
  });

  it('sans scénario en ligne, dit qu’il faut le créer et laisse une autre issue', () => {
    const q = question();
    expect(q).toMatch(/AUCUN scénario n’est en ligne/);
    expect(q).toMatch(/choisissez autre chose/);
  });
});
