import { describe, it, expect } from 'vitest';
import { langueSortanteParDefaut, nomDeLangue } from './langue-nom';

/**
 * LE LIBELLE DU BOUTON DE TRADUCTION, et pourquoi il se teste.
 *
 * 🔴 Le bouton NOMME sa cible (« Traduire en espagnol »), jamais « Traduire » tout court : c'est la
 * seule protection qui reste quand la langue apprise du contact est fausse (un « ok » ou un emoji
 * peuvent la fausser une fois). Un libellé qui retomberait sur un code brut ou sur du vide ferait
 * disparaître cette protection sans rien casser d'autre.
 */
describe('nomDeLangue', () => {
  it('nomme la langue dans la langue de la console', () => {
    expect(nomDeLangue('es', 'fr')).toBe('espagnol');
    expect(nomDeLangue('es', 'en')).toBe('Spanish');
    expect(nomDeLangue('fr', 'fr')).toBe('français');
  });

  it('comprend une variante régionale, dans les deux écritures', () => {
    // Le serveur range ce que le modèle rend : `pt-BR` comme `pt_BR` doivent se lire.
    expect(nomDeLangue('pt-BR', 'fr')).toMatch(/portugais/i);
    expect(nomDeLangue('pt_BR', 'fr')).toMatch(/portugais/i);
  });

  it('🔴 un code illisible rend le CODE, il ne casse pas l’écran', () => {
    // `Intl.DisplayNames.of` lève sur un code mal formé, et cette valeur vient de la base : elle a été
    // écrite par un modèle. Un libellé de bouton n'est pas une raison de casser l'Inbox.
    expect(nomDeLangue('pas une langue', 'fr')).toBe('pas une langue');
    expect(nomDeLangue('', 'fr')).toBe('');
  });
});

describe('langueSortanteParDefaut', () => {
  it('🔴 c’est l’AUTRE langue de la console, jamais l’anglais en dur', () => {
    // « Traduire en anglais » proposé à un opérateur qui écrit déjà en anglais est un bouton qui ne
    // fait rien. Ce n'est qu'un défaut proposé, pas une supposition sur le contact : le bouton le
    // NOMME, donc il ne ment pas.
    expect(langueSortanteParDefaut('fr')).toBe('en');
    expect(langueSortanteParDefaut('en')).toBe('fr');
  });
});
