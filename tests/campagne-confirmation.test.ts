import { describe, it, expect } from 'vitest';
import { ALPHABET_CODE, DUREE_CODE_MS, empreinteCode, empreinteEtat, nouveauCode, type EtatConfirme } from '../src/campaign/confirmation';

/**
 * LA CONFIRMATION D'UNE CAMPAGNE PRÉPARÉE PAR L'ASSISTANT (plan « Campagnes depuis Claude », tâche 7), sa partie pure.
 * Le code lie le lancement à ce que la personne a VU : toute différence de l'état (modèle, catégorie, date, variables,
 * nombre de destinataires, statut) change l'empreinte, donc le code ne lance plus rien.
 */
const ETAT: EtatConfirme = {
  templateName: 'retard_livraison', templateLanguage: 'fr', category: 'utility', prevueLe: '2027-10-30T08:00:00.000Z',
  paramMapping: [{ position: 1, source: { type: 'attribute', key: 'name' } }], recipientCount: 38, status: 'draft',
};

describe('empreinteEtat', () => {
  it('la même pour le même état, quel que soit l’ordre des clés', () => {
    const inverse = Object.fromEntries(Object.entries(ETAT).reverse()) as unknown as EtatConfirme;
    expect(empreinteEtat(inverse)).toBe(empreinteEtat(ETAT));
  });

  it('🔴 change dès qu’un seul champ change', () => {
    const variantes: Array<Partial<EtatConfirme>> = [
      { templateName: 'autre' }, { templateLanguage: 'en' }, { category: 'marketing' }, { prevueLe: null },
      { prevueLe: '2027-10-30T09:00:00.000Z' }, { paramMapping: [] }, { recipientCount: 39 }, { status: 'scheduled' },
    ];
    for (const v of variantes) expect(empreinteEtat({ ...ETAT, ...v }), JSON.stringify(v)).not.toBe(empreinteEtat(ETAT));
  });
});

describe('le code', () => {
  it('six caractères d’un alphabet sans 0, O, 1 ni I', () => {
    expect(ALPHABET_CODE).not.toMatch(/[0O1I]/);
    for (let i = 0; i < 200; i += 1) expect(nouveauCode()).toMatch(new RegExp(`^[${ALPHABET_CODE}]{6}$`));
  });

  it('jamais deux fois le même sur un petit tirage', () => {
    expect(new Set(Array.from({ length: 200 }, nouveauCode)).size).toBe(200);
  });

  it('son empreinte ne dépend pas de la casse ni des espaces qu’un assistant ajoute en recopiant', () => {
    expect(empreinteCode(' k7m2qp ')).toBe(empreinteCode('K7M2QP'));
    expect(empreinteCode('K7M2QP')).not.toBe(empreinteCode('K7M2QR'));
    expect(empreinteCode('K7M2QP')).not.toContain('K7M2QP');
  });

  it('valable 30 minutes', () => {
    expect(DUREE_CODE_MS).toBe(30 * 60 * 1000);
  });
});
