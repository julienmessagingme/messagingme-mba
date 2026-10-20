import { describe, it, expect } from 'vitest';
import { campDeLOutil, refusDeCampPourLesSorties, refusDeCampPourUnOutil, type OutilPourCamp } from '../src/agent/camp';
import { sortiesDeLaFiche } from '../src/agent/agent-store.pg';
import { sortieAgentSchema } from '../src/agent/fiche';

/**
 * CHOISIR SON CAMP (`src/agent/camp.ts`, demande de Julien du 2026-10-20) : un agent passe à l'équipe en qualifiant
 * d'abord OU directement, jamais les deux. Chaque refus dit ce qu'il faut désactiver.
 */

const WF = '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b';
const QUALIF: OutilPourCamp = {
  titre: 'Qualifier le candidat',
  binding: { handler: 'qualifier_transferer', questions: [{ champ: 'prenom', question: 'ton prénom', valeurs: [] }] },
};
const ENCHAINE_TRANSFERT: OutilPourCamp = {
  titre: 'Qualifier puis À traiter',
  binding: { handler: 'enchainer', etapes: [{ type: 'tag', tag: 'chaud' }, { type: 'transferer' }] },
};
const ENCHAINE_SCENARIO: OutilPourCamp = {
  titre: 'Qualifier puis scénario',
  binding: { handler: 'enchainer', etapes: [{ type: 'tag', tag: 'chaud' }, { type: 'scenario', workflowId: WF }] },
};
const PASSER_LA_MAIN: OutilPourCamp = { titre: 'Passer la main à un humain', binding: { handler: 'escalader' } };
const TAG: OutilPourCamp = { titre: 'Tag VIP', binding: { handler: 'poser_tag', tag: 'vip' } };
const REGLE_HUMAIN = { code: 'mise_en_relation', label: 'Mise en relation', humain: true };
const REGLE = { code: 'rdv_pris', label: 'Rendez-vous pris' };

describe('le camp d’un outil', () => {
  it('🔴 qualification : l’outil dédié, ou un enchaînement qui finit par le transfert', () => {
    expect(campDeLOutil(QUALIF.binding)).toBe('qualification');
    expect(campDeLOutil(ENCHAINE_TRANSFERT.binding)).toBe('qualification');
  });

  it('🔴 direct : « Passer la main à un humain »', () => {
    expect(campDeLOutil(PASSER_LA_MAIN.binding)).toBe('direct');
  });

  it('aucun camp : un enchaînement qui finit par un scénario, un autre outil, une cible illisible', () => {
    expect(campDeLOutil(ENCHAINE_SCENARIO.binding)).toBeNull();
    expect(campDeLOutil(TAG.binding)).toBeNull();
    expect(campDeLOutil({ handler: 'enchainer', etapes: 'abîmé' })).toBeNull();
    expect(campDeLOutil(null)).toBeNull();
  });
});

describe('activer un outil, ou changer sa cible', () => {
  it('🔴 la qualification est refusée à côté de « Passer la main », qui est nommé', () => {
    const refus = refusDeCampPourUnOutil('qualification', [TAG, PASSER_LA_MAIN], []);
    expect(refus).toMatch(/Choisissez un camp/);
    expect(refus).toMatch(/Désactivez d’abord « Passer la main à un humain »/);
  });

  it('🔴 la qualification est refusée à côté d’une règle d’arrêt qui passe à un humain, et la règle est nommée', () => {
    expect(refusDeCampPourUnOutil('qualification', [TAG], [REGLE, REGLE_HUMAIN]))
      .toMatch(/la règle d’arrêt « Mise en relation ».*Décochez d’abord « passe à un humain »/);
  });

  it('🔴 « Passer la main » est refusé à côté d’un outil qui qualifie, nommé', () => {
    expect(refusDeCampPourUnOutil('direct', [ENCHAINE_TRANSFERT], [])).toMatch(/Désactivez d’abord « Qualifier puis À traiter »/);
  });

  it('passe quand rien ne s’oppose, et pour un outil sans camp', () => {
    expect(refusDeCampPourUnOutil('qualification', [TAG, ENCHAINE_SCENARIO], [REGLE])).toBeNull();
    expect(refusDeCampPourUnOutil('direct', [TAG], [REGLE_HUMAIN])).toBeNull();
    expect(refusDeCampPourUnOutil(null, [QUALIF, PASSER_LA_MAIN], [REGLE_HUMAIN])).toBeNull();
    // Deux outils du même camp cohabitent : le choix porte sur le camp, pas sur le nombre d'outils.
    expect(refusDeCampPourUnOutil('qualification', [QUALIF], [])).toBeNull();
  });
});

describe('écrire les règles d’arrêt', () => {
  it('🔴 une règle qui passe à un humain est refusée à côté d’un outil qui qualifie, nommé', () => {
    expect(refusDeCampPourLesSorties([REGLE_HUMAIN], [TAG, QUALIF]))
      .toMatch(/« Mise en relation ».*Désactivez d’abord « Qualifier le candidat »/);
  });

  it('passe sans règle cochée, ou sans outil qui qualifie', () => {
    expect(refusDeCampPourLesSorties([REGLE], [QUALIF])).toBeNull();
    expect(refusDeCampPourLesSorties([REGLE_HUMAIN], [PASSER_LA_MAIN, ENCHAINE_SCENARIO])).toBeNull();
  });
});

describe('la case « passe à un humain » d’une règle d’arrêt', () => {
  it('s’écrit, se relit, et n’apparaît pas sur une règle qui ne la porte pas', () => {
    expect(sortieAgentSchema.safeParse(REGLE_HUMAIN).success).toBe(true);
    expect(sortieAgentSchema.safeParse({ ...REGLE, humain: 'oui' }).success).toBe(false);
    expect(sortiesDeLaFiche({ sorties: [REGLE_HUMAIN, REGLE, { code: 'faux', label: 'Faux', humain: 'true' }] }))
      .toEqual([REGLE_HUMAIN, REGLE, { code: 'faux', label: 'Faux' }]);
  });
});
