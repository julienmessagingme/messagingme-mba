import { describe, it, expect } from 'vitest';
import { importContacts } from '../src/crm/import';
import type { ContactStore, ContactUpsert } from '../src/crm/import';
import type { UserFieldStore } from '../src/crm/fields';
import type { UserFieldDef, ColumnMapping } from '../src/crm/types';

class FakeContactStore implements ContactStore {
  readonly byPhone = new Map<string, ContactUpsert>();
  async upsertByPhone(c: ContactUpsert): Promise<'created' | 'updated'> {
    const k = `${c.tenantId}|${c.phoneE164}`;
    const existed = this.byPhone.has(k);
    this.byPhone.set(k, c);
    return existed ? 'updated' : 'created';
  }
}
class FakeFieldStore implements UserFieldStore {
  readonly defs: UserFieldDef[] = [];
  async list(): Promise<UserFieldDef[]> {
    return this.defs;
  }
  async upsert(_t: string, def: UserFieldDef): Promise<void> {
    this.defs.push(def);
  }
}

const mapping: ColumnMapping = {
  columns: {
    tel: { target: 'phone' },
    nom: { target: 'name' },
    ville: { target: 'custom', key: 'ville' },
    interne: { target: 'ignore' },
  },
};

describe('importContacts', () => {
  it('upsert dédup par téléphone, champs perso + user field enregistré, opt-in, rapport', async () => {
    const contacts = new FakeContactStore();
    const userFields = new FakeFieldStore();
    const rows = [
      { tel: '0612345678', nom: 'Julie', ville: 'Lyon', interne: 'x' },
      { tel: '06 12 34 56 78', nom: 'Julie B', ville: 'Lyon', interne: 'y' }, // même numéro -> update
      { tel: '0700000000', nom: 'Marc', ville: 'Paris', interne: 'z' },
    ];
    const report = await importContacts({ rows, mapping, tenantId: 't1', optIn: true }, { contacts, userFields });

    expect(report).toMatchObject({ created: 2, updated: 1, skipped: 0 });
    expect(contacts.byPhone.size).toBe(2); // dédup
    const julie = contacts.byPhone.get('t1|+33612345678');
    expect(julie?.fields).toEqual({ ville: 'Lyon' }); // 'interne' ignoré
    expect(julie?.optInStatus).toBe('opted_in');
    expect(userFields.defs.map((d) => d.key)).toContain('ville'); // user field créé
  });

  it('tags : appliqués à tous les contacts importés', async () => {
    const contacts = new FakeContactStore();
    const userFields = new FakeFieldStore();
    const rows = [{ tel: '0612345678', nom: 'Julie', ville: 'Lyon', interne: '' }];
    await importContacts({ rows, mapping, tenantId: 't1', optIn: true, tags: ['salon-2026', 'prospect'] }, { contacts, userFields });
    expect(contacts.byPhone.get('t1|+33612345678')?.tags).toEqual(['salon-2026', 'prospect']);
  });

  it('champ booléen pré-existant : « Oui » -> canonique « true » ; valeur non reconnue -> brute, ligne NON rejetée', async () => {
    const contacts = new FakeContactStore();
    const userFields = new FakeFieldStore();
    userFields.defs.push({ key: 'consent', label: 'Consentement', type: 'boolean' });
    const boolMapping: ColumnMapping = { columns: { tel: { target: 'phone' }, optin: { target: 'custom', key: 'consent' } } };
    const rows = [
      { tel: '0612345678', optin: 'Oui' },
      { tel: '0700000000', optin: 'bof' }, // non reconnu -> brut, mais la ligne passe quand même
    ];
    const report = await importContacts({ rows, mapping: boolMapping, tenantId: 't1', optIn: false }, { contacts, userFields });
    expect(report.created).toBe(2);
    expect(report.skipped).toBe(0);
    expect(contacts.byPhone.get('t1|+33612345678')?.fields).toEqual({ consent: 'true' });
    expect(contacts.byPhone.get('t1|+33700000000')?.fields).toEqual({ consent: 'bof' });
  });

  it('téléphone invalide ou absent -> skip + erreur dans le rapport', async () => {
    const contacts = new FakeContactStore();
    const userFields = new FakeFieldStore();
    const rows = [
      { tel: '', nom: 'SansTel', ville: '', interne: '' },
      { tel: '123', nom: 'Invalide', ville: '', interne: '' },
      { tel: '0612345678', nom: 'Ok', ville: '', interne: '' },
    ];
    const report = await importContacts({ rows, mapping, tenantId: 't1', optIn: false }, { contacts, userFields });
    expect(report.created).toBe(1);
    expect(report.skipped).toBe(2);
    expect(report.errors).toHaveLength(2);
  });
});
