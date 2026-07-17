import { describe, it, expect } from 'vitest';
import { slugify, ensureField, ensureFieldByKey, isUserFieldType, validateFieldValue, canonicalizeFieldValue } from '../src/crm/fields';
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

describe('ensureFieldByKey', () => {
  it('idempotent PAR CLÉ : 2 appels, libellés différents -> 1 seule def (clé stable, 1er gagne)', async () => {
    const store = new FakeFieldStore();
    const a = await ensureFieldByKey(store, 't1', 'whatsapp_optin', 'Consentement WhatsApp', 'boolean');
    const b = await ensureFieldByKey(store, 't1', 'whatsapp_optin', 'Un autre libellé', 'boolean');
    expect(a.key).toBe('whatsapp_optin');
    expect(a.type).toBe('boolean');
    expect(b.label).toBe('Consentement WhatsApp'); // def existante conservée
    expect(await store.list('t1')).toHaveLength(1);
  });
  it('ne réécrit PAS un champ existant à cette clé (type conservé)', async () => {
    const store = new FakeFieldStore();
    await store.upsert('t1', { key: 'whatsapp_optin', label: 'Déjà là', type: 'text' });
    const def = await ensureFieldByKey(store, 't1', 'whatsapp_optin', 'X', 'boolean');
    expect(def.type).toBe('text'); // conservé, pas écrasé
    expect(await store.list('t1')).toHaveLength(1);
  });
  it('rejette un type invalide', async () => {
    const store = new FakeFieldStore();
    // @ts-expect-error type invalide au runtime
    await expect(ensureFieldByKey(store, 't1', 'k', 'L', 'carotte')).rejects.toThrow(/type de champ invalide/);
  });
});

describe('validateFieldValue', () => {
  it('booléen : accepte true/false/oui/non/1/0 (insensible à la casse), rejette le reste', () => {
    for (const v of ['true', 'FALSE', 'oui', 'Non', '1', '0']) expect(validateFieldValue('boolean', v)).toBe(true);
    expect(validateFieldValue('boolean', 'peut-être')).toBe(false);
    expect(validateFieldValue('boolean', '')).toBe(false);
  });
  it('number/date/url/text', () => {
    expect(validateFieldValue('number', '42.5')).toBe(true);
    expect(validateFieldValue('number', 'x')).toBe(false);
    expect(validateFieldValue('date', '2026-07-17')).toBe(true);
    expect(validateFieldValue('date', '17/07/2026')).toBe(false);
    expect(validateFieldValue('url', 'https://a.b')).toBe(true);
    expect(validateFieldValue('url', 'ftp://a')).toBe(false);
    expect(validateFieldValue('text', 'quoi que ce soit')).toBe(true);
    expect(validateFieldValue('text', '')).toBe(false);
  });
});

describe('canonicalizeFieldValue', () => {
  it('booléen -> true/false STRICT quel que soit le synonyme', () => {
    for (const v of ['true', 'oui', '1', 'OUI', ' True ']) expect(canonicalizeFieldValue('boolean', v)).toBe('true');
    for (const v of ['false', 'non', '0', 'NON', ' False ']) expect(canonicalizeFieldValue('boolean', v)).toBe('false');
  });
  it('booléen non reconnu -> renvoyé trimé tel quel (défensif, pas de throw)', () => {
    expect(canonicalizeFieldValue('boolean', ' bof ')).toBe('bof');
  });
  it('autres types -> identité (trim seulement), aucune régression', () => {
    expect(canonicalizeFieldValue('text', '  Paris ')).toBe('Paris');
    expect(canonicalizeFieldValue('number', ' 42 ')).toBe('42');
    expect(canonicalizeFieldValue('date', '2026-07-17')).toBe('2026-07-17');
    expect(canonicalizeFieldValue('url', ' https://a.b ')).toBe('https://a.b');
  });
});
