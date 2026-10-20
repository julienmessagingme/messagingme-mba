import { describe, expect, it } from 'vitest';
import { lancementDuBrouillon } from './campagne-prevue';

/**
 * LE BROUILLON PRÉPARÉ PAR L'ASSISTANT POUR UNE DATE (« Campagnes depuis Claude », tâche 9).
 *
 * 🔴 Qui a vu « demain 10 h » dans son assistant ne doit pas envoyer tout de suite en cliquant dans la console : le bouton
 * d'un brouillon daté PROGRAMME à sa date. Une date passée n'est jamais lue comme « maintenant » en silence : le bouton
 * redevient « Lancer », et l'écran dit que la date est passée.
 */
const MAINTENANT = Date.parse('2027-10-30T12:00:00.000Z');

describe('le lancement d’un brouillon', () => {
  it('sans date prévue : « Lancer », comme avant', () => {
    expect(lancementDuBrouillon(null, MAINTENANT)).toEqual({ action: 'lancer', prevuePassee: null });
    // Une API qui ne rend pas encore le champ (console publiée avant l'API) : rien ne change.
    expect(lancementDuBrouillon(undefined, MAINTENANT)).toEqual({ action: 'lancer', prevuePassee: null });
  });

  it('une date future : « Programmer pour », à cette date', () => {
    expect(lancementDuBrouillon('2027-10-31T09:00:00.000Z', MAINTENANT)).toEqual({ action: 'programmer', quand: '2027-10-31T09:00:00.000Z' });
  });

  it('une date passée : « Lancer », et la date passée est dite', () => {
    expect(lancementDuBrouillon('2027-10-29T09:00:00.000Z', MAINTENANT)).toEqual({ action: 'lancer', prevuePassee: '2027-10-29T09:00:00.000Z' });
  });

  it('une valeur illisible : « Lancer », sans date', () => {
    expect(lancementDuBrouillon('demain', MAINTENANT)).toEqual({ action: 'lancer', prevuePassee: null });
  });
});
