import { describe, it, expect } from 'vitest';
import { poids, phraseUtilisations, utilisationsDuRefus } from './medias';

const fr = (texte: string) => texte;

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
