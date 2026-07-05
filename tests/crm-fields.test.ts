import { describe, it, expect } from 'vitest';
import { slugify, ensureField, isUserFieldType } from '../src/crm/fields';
import type { UserFieldStore } from '../src/crm/fields';
import type { UserFieldDef } from '../src/crm/types';

class FakeFieldStore implements UserFieldStore {
  private readonly byTenant = new Map<string, UserFieldDef[]>();
  async list(tenantId: string): Promise<UserFieldDef[]> {
    return this.byTenant.get(tenantId) ?? [];
  }
  async upsert(tenantId: string, def: UserFieldDef): Promise<void> {
    const arr = this.byTenant.get(tenantId) ?? [];
    arr.push(def);
    this.byTenant.set(tenantId, arr);
  }
}

describe('slugify', () => {
  it('minuscule, sans accents, séparateurs -> _', () => {
    expect(slugify('Prénom')).toBe('prenom');
    expect(slugify('Ville de résidence')).toBe('ville_de_residence');
    expect(slugify('N° commande !')).toBe('n_commande');
  });
  it('chaîne sans caractère alphanumérique -> "field"', () => {
    expect(slugify('!!!')).toBe('field');
    expect(slugify('')).toBe('field');
  });
});

describe('isUserFieldType', () => {
  it('valide les types connus', () => {
    expect(isUserFieldType('text')).toBe(true);
    expect(isUserFieldType('number')).toBe(true);
    expect(isUserFieldType('carotte')).toBe(false);
  });
});

describe('ensureField', () => {
  it('crée le champ une seule fois (idempotent sur la key)', async () => {
    const store = new FakeFieldStore();
    const a = await ensureField(store, 't1', 'Prénom');
    const b = await ensureField(store, 't1', 'prénom'); // même slug
    expect(a.key).toBe('prenom');
    expect(b.key).toBe('prenom');
    expect(await store.list('t1')).toHaveLength(1);
  });
  it('rejette un type invalide', async () => {
    const store = new FakeFieldStore();
    // @ts-expect-error test d'un type invalide au runtime
    await expect(ensureField(store, 't1', 'X', 'carotte')).rejects.toThrow(/type de champ invalide/);
  });

  it('COMPORTEMENT ASSUMÉ : deux labels de slug identique partagent la même def (dedup, 1er gagne)', async () => {
    const store = new FakeFieldStore();
    const a = await ensureField(store, 't1', 'Ville!');
    const b = await ensureField(store, 't1', 'Ville?'); // même slug 'ville'
    expect(a.key).toBe('ville');
    expect(b.label).toBe('Ville!'); // renvoie la def existante (pas de disambiguation)
    expect(await store.list('t1')).toHaveLength(1);
  });
});
