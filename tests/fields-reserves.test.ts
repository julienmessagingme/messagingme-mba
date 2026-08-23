import { describe, it, expect } from 'vitest';
import { isReservedFieldLabel, SYSTEM_FIELD_KEYS } from '../src/crm/fields';

/**
 * Un champ perso ne doit pas pouvoir porter le libellé d'un champ de BASE.
 *
 * Le défaut réparé ici : le garde-fou comparait le slug du libellé saisi aux seules CLÉS, qui sont
 * anglaises (`name`, `phone`), alors que l'écran Champs affiche des libellés FRANÇAIS. Taper exactement ce
 * qu'on voit à l'écran passait donc, et fabriquait deux entrées « Nom » indiscernables dans tous les
 * sélecteurs de la console. Constaté sur un espace réel le 2026-08-23, avec « Nom » ET « Téléphone » en
 * double, tous deux vides et impossibles à remplir (ces valeurs vont dans les ATTRIBUTS du contact).
 */

describe('libellés réservés aux champs de base', () => {
  it('🔴 refuse les libellés FRANÇAIS des champs de base, ceux que l’écran affiche', () => {
    // C'est le cas qui est passé en production : l'utilisateur recopie ce qu'il voit.
    for (const label of ['Nom', 'Téléphone', 'Prénom', 'Email', 'BSUID', 'WhatsApp ID']) {
      expect(isReservedFieldLabel(label), label).toBe(true);
    }
  });

  it('🔴 refuse aussi les libellés ANGLAIS (la console est bilingue)', () => {
    for (const label of ['Name', 'Phone', 'First name']) {
      expect(isReservedFieldLabel(label), label).toBe(true);
    }
  });

  it('refuse quelle que soit la casse, les accents et les espaces', () => {
    for (const label of ['nom', 'NOM', '  Nom  ', 'telephone', 'TÉLÉPHONE', 'prenom', 'first  name']) {
      expect(isReservedFieldLabel(label), label).toBe(true);
    }
  });

  it('laisse passer un libellé qui n’est PAS un champ de base', () => {
    // Le garde-fou ne doit pas devenir un filtre à tout : ces libellés sont légitimes.
    for (const label of ['Ville', 'Nom de la société', 'Téléphone du bureau', 'Métier', 'Adresse', 'Prénom du conjoint']) {
      expect(isReservedFieldLabel(label), label).toBe(false);
    }
  });

  it('couvre toutes les clés système, pas seulement les libellés', () => {
    // L'ancien garde-fou attrapait déjà celles-là (« BSUID » -> 'bsuid') : on ne les perd pas au passage.
    for (const key of SYSTEM_FIELD_KEYS) expect(isReservedFieldLabel(key), key).toBe(true);
  });

  // ⚠️ Le test ANTI-DÉRIVE (les libellés du serveur couvrent ceux que le front affiche) vit côté WEB,
  // dans `web/lib/fields.test.ts`. Il ne peut pas vivre ici : importer `web/lib/fields.ts` depuis la suite
  // racine tire `web/lib/api.ts` puis `http.ts`, et le tsconfig racine n'a pas la lib DOM, donc `tsc`
  // passe au rouge sur `window`. L'import ne marche que dans l'autre sens.
});
