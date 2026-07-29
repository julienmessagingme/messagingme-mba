import { describe, it, expect } from 'vitest';
import { isDefaultSaveTo, defaultSaveTo, suggestBaseField, BASE_SAVE_FIELDS, PROFILE_NAME_SAVE_KEY } from '../web/lib/flow-mapping';

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

describe('suggestBaseField', () => {
  it('« Email » / « E-mail » / « Mail » / « Courriel » -> champ de base email', () => {
    for (const l of ['Email', 'E-mail', 'mail', 'Courriel', 'Adresse email']) {
      expect(suggestBaseField(l)).toEqual({ key: 'email', label: 'Email' });
    }
  });

  it('« Prénom » (accent/casse) / « First name » -> prenom', () => {
    expect(suggestBaseField('Prénom')).toEqual({ key: 'prenom', label: 'Prénom' });
    expect(suggestBaseField('PRENOM')).toEqual({ key: 'prenom', label: 'Prénom' });
    expect(suggestBaseField('First name')).toEqual({ key: 'prenom', label: 'Prénom' });
  });

  it('« Nom » / « Name » / « Nom de famille » -> sentinelle profile_name', () => {
    expect(suggestBaseField('Nom')).toEqual({ key: PROFILE_NAME_SAVE_KEY, label: 'Nom' });
    expect(suggestBaseField('name')).toEqual({ key: PROFILE_NAME_SAVE_KEY, label: 'Nom' });
    expect(suggestBaseField('Nom de famille')).toEqual({ key: PROFILE_NAME_SAVE_KEY, label: 'Nom' });
  });

  it('« nom » ne matche PAS prenom (pas de piège de sous-chaîne)', () => {
    expect(suggestBaseField('Nom')!.key).toBe(PROFILE_NAME_SAVE_KEY);
    expect(suggestBaseField('Prénom')!.key).toBe('prenom');
  });

  it('la sentinelle « Nom » est impossible à produire par slugify (pas de collision de slug)', () => {
    // slugify n'émet que [a-z0-9] séparés par _ (jamais de @) -> aucun libellé ne peut se mapper par défaut dessus.
    expect(PROFILE_NAME_SAVE_KEY).toMatch(/[^a-z0-9_]/);
  });

  it('libellé sans correspondance -> null', () => {
    expect(suggestBaseField('Ville')).toBeNull();
    expect(suggestBaseField('')).toBeNull();
    expect(suggestBaseField('   ')).toBeNull();
  });

  it('BASE_SAVE_FIELDS expose Nom/Prénom/Email avec les bonnes clés', () => {
    expect(BASE_SAVE_FIELDS.map((f) => f.key)).toEqual([PROFILE_NAME_SAVE_KEY, 'prenom', 'email']);
  });
});
