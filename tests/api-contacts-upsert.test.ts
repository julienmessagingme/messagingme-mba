import { describe, it, expect } from 'vitest';
import { upsertContactsFromApi } from '../src/api/contacts-upsert';
import type { PgContactStore } from '../src/crm/contact-store.pg';
import type { PgUserFieldStore } from '../src/crm/field-store.pg';
import type { UserFieldDef } from '../src/crm/types';

/**
 * Le CHEMIN D'ÉCRITURE PARTAGÉ (API publique, import de liste, webhook entrant).
 *
 * Ce qui est vérifié ici et nulle part ailleurs : la SOURCE du consentement. Les tests de route passent par
 * un faux `ecrireContact` et ne touchent donc jamais cette fonction ; supprimer le passage de `optInSource`
 * n'y faisait rien échouer. Or c'est précisément ce champ qui permet de justifier un consentement plus tard
 * (`csv_import`, `hubspot_list`, `webhook:<nom>`) : sans lui on sait qu'il y a consentement, pas d'où il vient.
 */

interface Ecrit {
  optInStatus: string;
  optInSource?: string;
  fields: Record<string, string>;
  profileName: string | null;
}

function deps(defs: UserFieldDef[] = []): { d: { contacts: PgContactStore; fields: PgUserFieldStore }; ecrits: Ecrit[] } {
  const ecrits: Ecrit[] = [];
  // Doubles STRUCTURELS : `upsertContactsFromApi` prend les classes concrètes, dont les membres privés
  // empêchent un objet littéral de les satisfaire. La conversion est donc inévitable ici, et elle est sans
  // risque : le test ne se sert que des deux méthodes réellement appelées.
  const contacts = {
    upsertByPhoneReturningId: async (c: Ecrit & { tenantId: string }) => {
      ecrits.push({ optInStatus: c.optInStatus, optInSource: c.optInSource, fields: c.fields, profileName: c.profileName });
      return { id: 'c1', created: true };
    },
  } as unknown as PgContactStore;
  const fields = { list: async () => defs, upsert: async () => {} } as unknown as PgUserFieldStore;
  return { d: { contacts, fields }, ecrits };
}

describe('consentement écrit par le chemin partagé', () => {
  it('sans opt-in, le contact naît en « inconnu » et AUCUNE source n’est posée', async () => {
    const { d, ecrits } = deps();
    await upsertContactsFromApi('t1', [{ phone: '+33612345678' }], d);
    expect(ecrits[0]?.optInStatus).toBe('unknown');
    expect(ecrits[0]?.optInSource).toBeUndefined();
  });

  it('avec opt-in mais sans source, on retombe sur `api` (le comportement d’origine)', async () => {
    const { d, ecrits } = deps();
    await upsertContactsFromApi('t1', [{ phone: '+33612345678', optIn: true }], d);
    expect(ecrits[0]).toMatchObject({ optInStatus: 'opted_in', optInSource: 'api' });
  });

  it('🔴 la source FOURNIE est celle qui est écrite', async () => {
    // Le cas du webhook : sans ce passage, tous les consentements se ressembleraient et on ne saurait plus
    // par quel formulaire ils sont entrés.
    const { d, ecrits } = deps();
    await upsertContactsFromApi('t1', [{ phone: '+33612345678', optIn: true, optInSource: 'webhook:Formulaire du site' }], d);
    expect(ecrits[0]?.optInSource).toBe('webhook:Formulaire du site');
  });

  it('🔴 une source fournie SANS opt-in n’écrit rien : on ne trace pas un consentement qui n’existe pas', async () => {
    const { d, ecrits } = deps();
    await upsertContactsFromApi('t1', [{ phone: '+33612345678', optInSource: 'webhook:Formulaire du site' }], d);
    expect(ecrits[0]?.optInStatus).toBe('unknown');
    expect(ecrits[0]?.optInSource).toBeUndefined();
  });
});
