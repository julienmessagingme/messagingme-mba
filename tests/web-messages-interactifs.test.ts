import { describe, it, expect } from 'vitest';
import {
  CONSIGNE_MESSAGE_MAX, TYPES, TYPES_MESSAGE_INTERACTIF as TYPES_WEB, composerConsigne, octets, separerConsigne,
} from '../web/lib/messages-interactifs';
import { CONSIGNE_MAX, TYPES_MESSAGE_INTERACTIF as TYPES_SERVEUR } from '../src/mba/messages-interactifs';
import { isValidSkillTitle } from '../web/lib/mba-skills';
import { NOMS_ICONES } from '../web/lib/icones';

/**
 * Les messages interactifs côté console (`web/lib/messages-interactifs.ts`) : la liste des types et la borne sont
 * DUPLIQUÉES du serveur, délibérément (les deux builds ne partagent aucun module) ; ce fichier casse dès qu'elles
 * divergent.
 */

describe('la console et le serveur parlent des mêmes neuf types', () => {
  it('🔴 même liste, même ordre, même borne', () => {
    expect([...TYPES_WEB]).toEqual([...TYPES_SERVEUR]);
    expect(CONSIGNE_MESSAGE_MAX).toBe(CONSIGNE_MAX);
  });

  it('chaque type a un nom, une aide, un canevas en deux langues, une icône de la famille, et un titre de départ valide', () => {
    for (const type of TYPES_WEB) {
      const x = TYPES[type];
      for (const paire of [x.nom, x.aide, x.canevas]) {
        expect(paire[0].trim(), type).not.toBe('');
        expect(paire[1].trim(), type).not.toBe('');
      }
      expect(NOMS_ICONES as readonly string[], type).toContain(x.icone);
      expect(isValidSkillTitle(x.titre), type).toBe(true);
      // La ligne « Quand » a son propre champ : le canevas ne la répète pas.
      expect(x.canevas[0]).not.toMatch(/^Quand/);
    }
  });
});

describe('la consigne : « Quand l’envoyer » puis le contenu', () => {
  it('se compose et se sépare à l’identique, en français comme en anglais', () => {
    const fr = composerConsigne('le client veut réserver', 'Texte : choisissez\nBoutons : Matin, Soir');
    expect(fr).toBe('Quand : le client veut réserver\nTexte : choisissez\nBoutons : Matin, Soir');
    expect(separerConsigne(fr)).toEqual({ quand: 'le client veut réserver', contenu: 'Texte : choisissez\nBoutons : Matin, Soir' });
    const en = composerConsigne('the customer wants to book', 'Text: pick one', 'en');
    expect(en).toBe('When: the customer wants to book\nText: pick one');
    expect(separerConsigne(en)).toEqual({ quand: 'the customer wants to book', contenu: 'Text: pick one' });
  });

  it('⚠️ une consigne écrite ailleurs (l’assistant, Meta) va ENTIÈRE dans le contenu, jamais coupée au hasard', () => {
    const libre = 'Si le client demande un lien, envoie un bouton vers https://exemple.fr';
    expect(separerConsigne(libre)).toEqual({ quand: '', contenu: libre });
  });

  it('reconnaît aussi « quand: », « QUAND : » ou « When : », qu’un modèle peut écrire', () => {
    for (const ecrit of ['quand: le client hésite\nx', 'QUAND : le client hésite\nx', 'When : le client hésite\nx']) {
      expect(separerConsigne(ecrit), ecrit).toEqual({ quand: 'le client hésite', contenu: 'x' });
    }
    // Un mot qui commence par « quand » sans deux-points n'est pas une ligne « quand ».
    expect(separerConsigne('Quandary\nx')).toEqual({ quand: '', contenu: 'Quandary\nx' });
  });

  it('un « quand » sur plusieurs lignes est ramené à une ligne, sinon la séparation le couperait', () => {
    expect(separerConsigne(composerConsigne('le client\nveut réserver', 'x'))).toEqual({ quand: 'le client veut réserver', contenu: 'x' });
  });

  it('compte en octets, comme Meta', () => {
    expect(octets('é')).toBe(2);
    expect(octets('a'.repeat(10))).toBe(10);
  });
});
