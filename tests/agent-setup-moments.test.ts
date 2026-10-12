import { describe, it, expect } from 'vitest';
import { actionChoisie, AGENDA, basculesDuTour, momentDuPoint, type Point } from '../src/agent/setup/couverture';

/**
 * Les moments de l'entretien de construction, tenus par le serveur (agent SMATIS, 2026-10-12) : un moment ne naît
 * qu'au tour qui les recueille, une reformulation se rattache au moment demandé, et la réponse du client à la liste
 * numérotée se lit sans le modèle.
 */
const COLLECTE = AGENDA.find((p) => p.collecteDesMoments)!;
const ACTION_1: Point = { code: 'bascule_1_action', question: 'q', aObtenir: 'a' };
const AVANT = [{ moment: 'le client veut parler à un conseiller' }, { moment: 'le client veut faire un devis' }];

describe('momentDuPoint', () => {
  it('lit l’index et la nature d’un point engendré, et rien d’autre', () => {
    expect(momentDuPoint('bascule_2_action')).toEqual({ index: 1, quoi: 'action' });
    expect(momentDuPoint('bascule_1_moyen')).toEqual({ index: 0, quoi: 'moyen' });
    expect(momentDuPoint('bascules')).toBeNull();
    expect(momentDuPoint(undefined)).toBeNull();
  });
});

describe('basculesDuTour', () => {
  it('au tour qui recueille les moments, tout passe', () => {
    const p = [{ moment: 'a' }, { moment: 'b' }];
    expect(basculesDuTour([], p, COLLECTE)).toEqual(p);
  });

  it('🔴 ailleurs, une reformulation porteuse d’une action se rattache au moment demandé', () => {
    const r = basculesDuTour(AVANT, [{ moment: 'Le client demande à parler à un conseiller', action: 'humain' }], ACTION_1);
    expect(r).toEqual([{ moment: 'le client veut parler à un conseiller', action: 'humain' }]);
  });

  it('deux orphelines : on ne devine pas laquelle, aucune n’est rattachée', () => {
    const r = basculesDuTour(AVANT, [
      { moment: 'x', action: 'humain' }, { moment: 'y', action: 'scenario' },
    ], ACTION_1);
    expect(r).toEqual([]);
  });

  it('une entrée qui apparie un moment connu passe, quelle que soit la casse', () => {
    const r = basculesDuTour(AVANT, [{ moment: 'Le client veut faire un devis', action: 'scenario' }], ACTION_1);
    expect(r).toEqual([{ moment: 'Le client veut faire un devis', action: 'scenario' }]);
  });

  it('une orpheline sans action ni moyen ne sert à rien : écartée', () => {
    expect(basculesDuTour(AVANT, [{ moment: 'le client veut résilier' }], ACTION_1)).toEqual([]);
  });
});

describe('actionChoisie', () => {
  it('🔴 lit le numéro seul, ou le mot qui distingue un choix', () => {
    expect(actionChoisie('4')).toBe('humain');
    expect(actionChoisie(' 1) ')).toBe('scenario');
    expect(actionChoisie('Il doit passer la main à un humain')).toBe('humain');
    expect(actionChoisie('lancer le scénario SMATIS Devis')).toBe('scenario');
    expect(actionChoisie('appeler notre API')).toBe('outil_api');
    expect(actionChoisie('rien de particulier')).toBe('continuer');
    expect(actionChoisie('autre chose')).toBe('autre');
  });

  it('ne devine pas : rien ne ressort, ou deux choix se disputent le message', () => {
    expect(actionChoisie('je ne sais pas')).toBeNull();
    expect(actionChoisie('une API ou un humain')).toBeNull();
    expect(actionChoisie('9')).toBeNull();
  });
});
