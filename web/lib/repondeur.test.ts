import { describe, it, expect } from 'vitest';
import {
  agentsProposables, avertissementAllumageMeta, confirmationRepondeur, lireMbaAllume, lireRepondeurAgentId,
  lireReglageRepondeur, phraseContactsNonRetires, repondeurAutomatique,
} from './repondeur';

const fr = (f: string): string => f;

describe('la réponse du geste, vérifiée et jamais castée', () => {
  it('une réponse bien formée passe telle quelle', () => {
    const r = { repondeurAgentId: 'ag1', agentDeMetaEteint: true, liste: { retires: 12, refuses: 2 } };
    expect(lireReglageRepondeur(r)).toEqual(r);
    expect(lireReglageRepondeur({ repondeurAgentId: null, agentDeMetaEteint: false, liste: { retires: 0, refuses: 0 } }))
      .toEqual({ repondeurAgentId: null, agentDeMetaEteint: false, liste: { retires: 0, refuses: 0 } });
  });

  it('🔴 un agent désigné illisible : `null`, l’écran relit au lieu de supposer', () => {
    for (const brut of [null, 'ok', [], { agentDeMetaEteint: true }, { repondeurAgentId: 42 }]) {
      expect(lireReglageRepondeur(brut), JSON.stringify(brut)).toBeNull();
    }
  });

  it('🔴 un compte de refus illisible vaut zéro : on n’invente pas de contacts muets', () => {
    for (const refuses of [undefined, '2', -3, Number.NaN]) {
      expect(lireReglageRepondeur({ repondeurAgentId: 'ag1', liste: { retires: 1, refuses } })?.liste.refuses).toBe(0);
    }
    expect(lireReglageRepondeur({ repondeurAgentId: 'ag1' })).toEqual({ repondeurAgentId: 'ag1', agentDeMetaEteint: false, liste: { retires: 0, refuses: 0 } });
  });

  it('`repondeurAgentId` de la liste : absent veut dire « on ne sait pas », jamais « aucun »', () => {
    expect(lireRepondeurAgentId('ag1')).toBe('ag1');
    expect(lireRepondeurAgentId(null)).toBeNull();
    expect(lireRepondeurAgentId(undefined)).toBeUndefined();
    expect(lireRepondeurAgentId(3)).toBeUndefined();
  });
});

describe('un répondeur automatique répond-il ?', () => {
  it('🔴 l’agent de Meta allumé, OU un agent IA désigné : « le répondeur automatique prend la main » mène quelque part', () => {
    expect(repondeurAutomatique({ mbaEnabled: true, repondeurAgentId: null })).toBe(true);
    expect(repondeurAutomatique({ mbaEnabled: false, repondeurAgentId: 'ag1' })).toBe(true);
    expect(repondeurAutomatique({ mbaEnabled: false, repondeurAgentId: null })).toBe(false);
    // Une API d'avant le lot 5 ne rend pas la clé : l'agent de Meta seul décide, comme avant.
    expect(repondeurAutomatique({ mbaEnabled: false })).toBe(false);
    expect(repondeurAutomatique({ mbaEnabled: true })).toBe(true);
  });

  it('🔴 des réglages illisibles : on ne sait pas, ce qui n’est pas « aucun »', () => {
    expect(repondeurAutomatique(null)).toBeNull();
    expect(repondeurAutomatique({})).toBeNull();
    expect(repondeurAutomatique({ repondeurAgentId: 'ag1' })).toBeNull();
  });
});

describe('les agents qu’on peut désigner', () => {
  const agents = [
    { id: 'a', status: 'active' }, { id: 'b', status: 'draft' }, { id: 'c', status: 'disabled' }, { id: 'd', status: 'active' },
  ];

  it('🔴 les ACTIFS seulement : ni un brouillon, ni un agent désactivé', () => {
    expect(agentsProposables(agents, null).map((a) => a.id)).toEqual(['a', 'd']);
  });

  it('le répondeur actuel reste choisi même s’il n’est plus actif dans la liste relue', () => {
    expect(agentsProposables(agents, 'c').map((a) => a.id)).toEqual(['a', 'c', 'd']);
  });
});

describe('ce que l’écran dit avant et après le geste', () => {
  it('🔴 J6 : les contacts que Meta n’a pas retirés sont COMPTÉS, au singulier comme au pluriel', () => {
    expect(phraseContactsNonRetires(0, fr)).toBeNull();
    expect(phraseContactsNonRetires(1, fr)).toMatch(/^1 contact n’a pas pu être retiré de la liste de l’agent de Meta/);
    expect(phraseContactsNonRetires(3, fr)).toMatch(/^3 contacts n’ont pas pu être retirés de la liste de l’agent de Meta/);
  });

  it('🔴 J7 : allumer l’agent de Meta, avec un agent IA répondeur, le dit en le NOMMANT ; sans lui, rien à dire', () => {
    expect(avertissementAllumageMeta(null, fr)).toBeNull();
    expect(avertissementAllumageMeta({ label: 'Léa' }, fr)).toBe(
      'L’agent IA « Léa » est aujourd’hui le répondeur de l’espace. Allumer l’agent de Meta le retire de ce rôle : c’est l’agent de Meta qui répondra aux messages que personne ne tient.',
    );
    expect(avertissementAllumageMeta({ label: ' ' }, fr)).toMatch(/^Un agent IA est aujourd’hui le répondeur de l’espace\./);
  });
});

describe('la question posée avant d’enregistrer le répondeur (relecture de la livraison B, JB3 et JB5)', () => {
  it('🔴 JB3 (a) : l’état de l’agent de Meta ILLISIBLE fait confirmer, au conditionnel ; seul un agent de Meta LU éteint en dispense', () => {
    const illisible = confirmationRepondeur({ vers: 'Léa', depuis: null }, null, fr);
    expect(illisible?.message).toBe(
      '« Léa » deviendra le répondeur de l’espace. Si l’agent de Meta est allumé, il sera éteint pour tous vos contacts de cet espace, conversations en cours comprises.',
    );
    expect(confirmationRepondeur({ vers: 'Léa', depuis: null }, true, fr)?.message).toBe(
      '« Léa » deviendra le répondeur de l’espace, et l’agent de Meta sera éteint pour tous vos contacts de cet espace, conversations en cours comprises.',
    );
    expect(confirmationRepondeur({ vers: 'Léa', depuis: 'Marc' }, false, fr)).toBeNull();
  });

  it('🔴 JB5 : revenir à « Aucun » se confirme, quel que soit l’agent de Meta : plus aucun agent IA ne répondra', () => {
    for (const mba of [true, false, null]) {
      expect(confirmationRepondeur({ vers: null, depuis: 'Léa' }, mba, fr)).toEqual({
        titre: 'Retirer le répondeur',
        message: '« Léa » ne sera plus le répondeur de l’espace : plus aucun agent IA ne répondra aux messages que personne ne tient.',
        confirmer: 'Retirer',
      });
    }
  });

  it('l’état de l’agent de Meta dans les réglages : un booléen, sinon « on ne sait pas »', () => {
    expect(lireMbaAllume({ mbaEnabled: true })).toBe(true);
    expect(lireMbaAllume({ mbaEnabled: false })).toBe(false);
    for (const s of [null, {}, { mbaEnabled: 'true' }, { mbaEnabled: 1 }]) expect(lireMbaAllume(s), JSON.stringify(s)).toBeNull();
  });
});
