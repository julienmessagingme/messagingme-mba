import { describe, it, expect } from 'vitest';
import {
  cibleDeLecture,
  marqueTraduction,
  texteDeBulle,
  texteDuVocal,
} from './traduction-lecture';

describe('cibleDeLecture', () => {
  it('la cible est la langue de la CONSOLE, jamais une question de plus', () => {
    expect(cibleDeLecture(true, 'fr')).toBe('fr');
    expect(cibleDeLecture(true, 'en')).toBe('en');
  });

  it('🔴 éteint, on ne demande RIEN : sans `traduire`, la réponse du fil est celle d’avant ce lot', () => {
    // Une chaîne vide partirait dans l'URL et ferait entrer la route dans son chemin de traduction.
    expect(cibleDeLecture(false, 'fr')).toBeUndefined();
    expect(cibleDeLecture(false, 'en')).toBeUndefined();
  });
});

describe('marqueTraduction', () => {
  it('une bulle traduite le dit', () => {
    expect(marqueTraduction({ traduit: true, traductionEchouee: false })).toBe('traduit');
  });

  it('🔴 TENTÉ ET RATÉ n’est PAS JAMAIS TENTÉ', () => {
    // Au-delà du plafond de 40, rien n'a été tenté : annoncer un échec ferait chercher une panne qui
    // n'existe pas, sur des messages anciens que personne n'a demandé à traduire.
    expect(marqueTraduction({ traduit: false, traductionEchouee: true })).toBe('echec');
    expect(marqueTraduction({ traduit: false, traductionEchouee: false })).toBe('aucune');
  });

  it('un fil demandé SANS traduction ne porte aucun des deux drapeaux, donc aucune marque', () => {
    expect(marqueTraduction({})).toBe('aucune');
  });

  it('le drapeau de traduction l’emporte : une bulle traduite n’est jamais un échec', () => {
    expect(marqueTraduction({ traduit: true, traductionEchouee: true })).toBe('traduit');
  });
});

describe('texteDeBulle', () => {
  it('notre lecture quand il y en a une', () => {
    expect(texteDeBulle({ affiche: 'Bonjour', body: 'Hola' })).toBe('Bonjour');
  });

  it('l’original quand le fil n’a pas été demandé traduit', () => {
    expect(texteDeBulle({ body: 'Hola' })).toBe('Hola');
  });

  it('🔴 `affiche` VIDE compte pour absent, sinon le repli `[image]` disparaît', () => {
    // Le serveur rend `affiche: ''` pour un message sans corps (autocollant, image sans légende),
    // parce que son original est `null`. Le prendre au mot viderait la bulle le jour où l'on allume
    // la traduction, et l'écran perdrait le seul indice du TYPE du message.
    expect(texteDeBulle({ affiche: '', body: null })).toBeNull();
    expect(texteDeBulle({ affiche: '', body: '[image]' })).toBe('[image]');
  });
});

describe('texteDuVocal', () => {
  it('rien à montrer tant que personne n’a demandé la transcription', () => {
    expect(texteDuVocal({ transcription: null, affiche: '[audio]' })).toEqual({ texte: null, traduit: false });
  });

  it('la transcription seule quand le fil n’est pas traduit', () => {
    expect(texteDuVocal({ transcription: 'Hola, tengo un problema' }))
      .toEqual({ texte: 'Hola, tengo un problema', traduit: false });
  });

  it('notre lecture de la transcription quand le fil est traduit', () => {
    expect(texteDuVocal({ transcription: 'Hola', affiche: 'Bonjour', traduit: true }))
      .toEqual({ texte: 'Bonjour', traduit: true });
  });

  it('🔴 un vocal SANS transcription mais AVEC légende traduite ne montre pas sa légende comme un dit', () => {
    // C'est la légende qui est partie au modèle, pas ce qui a été dit : `traduit` vaut true et
    // `affiche` porte la légende traduite. L'afficher sous l'étiquette « transcription » ferait
    // passer un texte écrit pour une parole, exactement ce que la migration 0125 refuse.
    expect(texteDuVocal({ transcription: null, affiche: 'Regarde ça', traduit: true }))
      .toEqual({ texte: null, traduit: false });
  });
});
