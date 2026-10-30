import { describe, it, expect } from 'vitest';
import { poids, phraseUtilisations, phrasesDuDepot, utilisationsDuRefus } from './medias';

const fr = (texte: string) => texte;

describe('le bilan du bouton « Ajouter des fichiers » (2026-10-30)', () => {
  it('dit ce qui est entré, au singulier comme au pluriel, et ce qui était déjà là', () => {
    expect(phrasesDuDepot({ ajoutes: 1, dejaLa: 0, refus: [] }, fr)).toEqual({ info: '1 fichier ajouté.', erreur: null });
    expect(phrasesDuDepot({ ajoutes: 3, dejaLa: 2, refus: [] }, fr).info)
      .toBe('3 fichiers ajoutés. 2 fichiers étaient déjà dans la médiathèque.');
  });

  it('🔴 nomme chaque refus avec son fichier, et ne dit rien de ce qui n’est pas arrivé', () => {
    expect(phrasesDuDepot({ ajoutes: 0, dejaLa: 0, refus: [{ nom: 'film.mov', raison: 'Format MOV.' }, { nom: 'gros.png', raison: 'Trop lourd.' }] }, fr))
      .toEqual({ info: null, erreur: '« film.mov » : Format MOV. « gros.png » : Trop lourd.' });
  });
});

describe('la médiathèque côté console (spec médias, lot B)', () => {
  it('dit un poids en Ko sous le mégaoctet, en Mo au-delà, avec une décimale utile', () => {
    expect(poids(0)).toBe('0 Ko');
    expect(poids(512)).toBe('1 Ko');
    expect(poids(300 * 1024)).toBe('300 Ko');
    expect(poids(1024 * 1024)).toBe('1 Mo');
    expect(poids(1.5 * 1024 * 1024)).toBe('1,5 Mo');
    expect(poids(100 * 1024 * 1024)).toBe('100 Mo');
  });

  it('nomme ce qui utilise encore un fichier, lieu par lieu', () => {
    expect(phraseUtilisations([
      { lieu: 'scenario', nom: 'Bienvenue' },
      { lieu: 'campagne', nom: 'Rentrée' },
    ], fr)).toBe('Utilisé par le scénario « Bienvenue » et la campagne « Rentrée ». Retirez-le d’abord de ces contenus.');
    expect(phraseUtilisations([{ lieu: 'message_rcs', nom: 'Promo' }], fr))
      .toBe('Utilisé par le message RCS « Promo ». Retirez-le d’abord de ce contenu.');
  });

  it('🔴 lit la liste d’un refus 409, et rien d’autre : un lieu inconnu (serveur plus récent) est gardé, nommé simplement', () => {
    expect(utilisationsDuRefus({ code: 'media_utilise', utilisations: [{ lieu: 'brouillon_campagne', nom: 'X' }] }))
      .toEqual([{ lieu: 'brouillon_campagne', nom: 'X' }]);
    expect(utilisationsDuRefus({ code: 'media_utilise', utilisations: [{ lieu: 'nouveau', nom: 'Y' }] }))
      .toEqual([{ lieu: 'nouveau', nom: 'Y' }]);
    expect(phraseUtilisations([{ lieu: 'nouveau', nom: 'Y' }], fr)).toBe('Utilisé par « Y ». Retirez-le d’abord de ce contenu.');
    for (const brut of [null, {}, { code: 'autre' }, { code: 'media_utilise', utilisations: 'non' }, { code: 'media_utilise', utilisations: [{ lieu: 1 }] }]) {
      expect(utilisationsDuRefus(brut)).toBeNull();
    }
  });
});
