import { describe, it, expect } from 'vitest';
import { isDefaultSaveTo, defaultSaveTo } from '../web/lib/flow-mapping';

/**
 * Helper PUR du builder de formulaires (web/lib/flow-mapping.ts), testé depuis la suite racine par import
 * RELATIF : aucune dépendance React/Next, donc pas besoin d'une 2e suite côté web. Ce helper décide si la cible
 * stockée d'un champ est le mapping PAR DÉFAUT ; s'il se trompe, le round-trip d'édition ré-sérialise une cible
 * que l'utilisateur n'a jamais choisie (et pour un optin, ça peut BLOQUER la ré-édition du formulaire).
 */
describe('isDefaultSaveTo', () => {
  it('optin + whatsapp_optin -> DÉFAUT (saveTo vidé au round-trip)', () => {
    expect(isDefaultSaveTo('optin', 'whatsapp_optin', 'jaccepte')).toBe(true);
  });

  it('optin + autre champ booléen -> choix EXPLICITE (conservé)', () => {
    expect(isDefaultSaveTo('optin', 'accepte_sms', 'jaccepte')).toBe(false);
  });

  it('optin + la clé du champ lui-même -> EXPLICITE (le défaut d’un optin n’est PAS sa propre clé)', () => {
    expect(isDefaultSaveTo('optin', 'jaccepte', 'jaccepte')).toBe(false);
  });

  it('non-optin + la clé du champ -> DÉFAUT', () => {
    expect(isDefaultSaveTo('text', 'prenom', 'prenom')).toBe(true);
  });

  it('non-optin + une autre clé -> choix EXPLICITE', () => {
    expect(isDefaultSaveTo('text', 'surnom', 'prenom')).toBe(false);
  });

  it('non-optin + whatsapp_optin -> EXPLICITE (whatsapp_optin n’est le défaut QUE des optin)', () => {
    expect(isDefaultSaveTo('text', 'whatsapp_optin', 'prenom')).toBe(false);
  });

  it('cible absente ou vide -> DÉFAUT (champ jamais mappé)', () => {
    expect(isDefaultSaveTo('text', undefined, 'prenom')).toBe(true);
    expect(isDefaultSaveTo('optin', undefined, 'jaccepte')).toBe(true);
    expect(isDefaultSaveTo('text', '', 'prenom')).toBe(true);
  });
});

describe('defaultSaveTo', () => {
  it('optin -> whatsapp_optin ; tout autre type -> la clé du champ', () => {
    expect(defaultSaveTo('optin', 'jaccepte')).toBe('whatsapp_optin');
    expect(defaultSaveTo('checkbox', 'options')).toBe('options');
    expect(defaultSaveTo('text', 'prenom')).toBe('prenom');
  });
});
