import { describe, it, expect } from 'vitest';
import { SYSTEM_FIELDS } from './fields';
import { SYSTEM_FIELD_LABELS, slugify } from '../../src/crm/fields';

/**
 * ANTI-DÉRIVE entre les deux listes de libellés des champs de BASE.
 *
 * Le front les affiche (`SYSTEM_FIELD_META`), le serveur s'en sert pour refuser qu'un champ perso porte le
 * même libellé et fabrique un doublon indiscernable. Les deux vivent dans des arbres sans paquet commun :
 * si le front ajoute un champ de base ou en renomme un, le serveur cesserait de le protéger EN SILENCE, et
 * le doublon reviendrait.
 *
 * ⚠️ Ce test vit ICI et pas dans la suite racine : importer `web/lib/fields.ts` depuis la racine tire
 * `web/lib/api.ts` puis `http.ts`, et le tsconfig racine n'a pas la lib DOM. L'import ne marche que dans ce
 * sens-là, du web vers `src/` (qui est pur).
 */
describe('libellés des champs de base : front et serveur d’accord', () => {
  it('🔴 chaque libellé affiché par le front est protégé côté serveur, dans les DEUX langues', () => {
    const protegesParLeServeur = new Set(SYSTEM_FIELD_LABELS.map((l) => slugify(l)));
    for (const f of SYSTEM_FIELDS) {
      const [fr, en] = f.label;
      expect(protegesParLeServeur.has(slugify(fr)), `libellé FR « ${fr} » (champ ${f.key}) non protégé côté serveur`).toBe(true);
      expect(protegesParLeServeur.has(slugify(en)), `libellé EN « ${en} » (champ ${f.key}) non protégé côté serveur`).toBe(true);
    }
  });
});
