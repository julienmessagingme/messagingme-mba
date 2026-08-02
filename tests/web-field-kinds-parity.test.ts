import { describe, it, expect } from 'vitest';
import { USER_FIELD_KINDS } from '../web/lib/field-kinds';
import { USER_FIELD_TYPES } from '../src/crm/fields';

// Dette fermée (plan .loop/condition-node.md) : rien ne verrouillait la parité entre la liste de types côté
// front (`UserFieldKind`) et côté serveur (`USER_FIELD_TYPES`). Un futur ajout de type dans un seul des deux
// fichiers passait inaperçu. Ce test casse dès qu'ils divergent.
describe('parité des types de champ front (UserFieldKind) / back (USER_FIELD_TYPES)', () => {
  it('les deux listes contiennent exactement les mêmes types', () => {
    expect([...USER_FIELD_KINDS].sort()).toEqual([...USER_FIELD_TYPES].sort());
  });
});
