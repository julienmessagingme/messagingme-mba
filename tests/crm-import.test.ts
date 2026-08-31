import { describe, it, expect } from 'vitest';
import { importContacts } from '../src/crm/import';
import type { ContactStore, ContactUpsert, LotContacts } from '../src/crm/import';
import type { UserFieldStore } from '../src/crm/fields';
import type { UserFieldDef, ColumnMapping } from '../src/crm/types';

class FakeContactStore implements ContactStore {
  readonly byPhone = new Map<string, ContactUpsert>();
  /** Nombre d'ALLERS-RETOURS (un par lot), ce que R9 cherche justement à faire tomber. */
  lots = 0;
  async upsertManyByPhone(lot: LotContacts): Promise<Array<'created' | 'updated'>> {
    this.lots += 1;
    return lot.contacts.map((c) => {
      const k = `${lot.tenantId}|${c.phoneE164}`;
      const existait = this.byPhone.has(k);
      // On reconstruit la forme unitaire : c'est elle que les tests inspectent (tags, opt-in, champs).
      this.byPhone.set(k, {
        tenantId: lot.tenantId,
        phoneE164: c.phoneE164,
        profileName: c.profileName,
        fields: c.fields,
        optInStatus: lot.optInStatus,
        ...(lot.optInSource ? { optInSource: lot.optInSource } : {}),
        ...(lot.tags ? { tags: lot.tags } : {}),
      });
      return existait ? 'updated' : 'created';
    });
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

  /**
   * AUDIT-SCALE-2026-08-25.md, R9 : l'import faisait un aller-retour PAR LIGNE, en ligne dans le handler
   * HTTP. À 11 ms d'aller-retour mesurés, un fichier de 5000 lignes dépassait le timeout de 100 s de
   * Cloudflare, et l'opérateur voyait une erreur pendant que le serveur travaillait encore.
   */
  it('gros fichier -> écrit par LOTS, pas une requête par ligne', async () => {
    const contacts = new FakeContactStore();
    const userFields = new FakeFieldStore();
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      tel: `+336${String(i).padStart(8, '0')}`, nom: `Nom ${i}`, ville: 'Lyon', interne: '',
    }));
    const report = await importContacts({ rows, mapping, tenantId: 't1', optIn: true }, { contacts, userFields });

    expect(report).toMatchObject({ created: 1200, updated: 0, skipped: 0 });
    expect(contacts.byPhone.size).toBe(1200);
    expect(contacts.lots).toBe(3); // 500 + 500 + 200, et non 1200 allers-retours
  });

  it('lignes invalides : elles ne partent pas en base et ne comptent pas dans les lots', async () => {
    const contacts = new FakeContactStore();
    const userFields = new FakeFieldStore();
    const rows = [
      { tel: '0612345678', nom: 'Ok', ville: '', interne: '' },
      { tel: 'pas un numéro', nom: 'Non', ville: '', interne: '' },
    ];
    const report = await importContacts({ rows, mapping, tenantId: 't1', optIn: false }, { contacts, userFields });
    expect(report).toMatchObject({ created: 1, skipped: 1 });
    expect(contacts.lots).toBe(1);
    expect(contacts.byPhone.size).toBe(1);
  });

  it('aucune ligne valide -> AUCUN lot envoyé (pas de requête vide)', async () => {
    const contacts = new FakeContactStore();
    const userFields = new FakeFieldStore();
    const report = await importContacts(
      { rows: [{ tel: '', nom: 'SansTel', ville: '', interne: '' }], mapping, tenantId: 't1', optIn: false },
      { contacts, userFields },
    );
    expect(report.skipped).toBe(1);
    expect(contacts.lots).toBe(0);
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
