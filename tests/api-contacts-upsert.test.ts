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

/**
 * ÉCRITURES PAR VAGUES (lot 6 du programme II). Les 500 upserts d'un lot plein partaient à la file, un
 * aller-retour chacun, soit environ cinq secondes et demie de latence pure. Ils partent maintenant par
 * vagues, la VALIDATION restant séquentielle (elle partage un cache de champs et peut en créer un).
 */
describe('upsert API : écritures par vagues', () => {
  /** Store qui compte les écritures SIMULTANÉES et retient le maximum atteint. */
  function storeQuiCompte() {
    const etat = { enVol: 0, max: 0, total: 0 };
    const contacts = {
      upsertByPhoneReturningId: async (u: { phoneE164: string }) => {
        etat.enVol += 1;
        etat.max = Math.max(etat.max, etat.enVol);
        etat.total += 1;
        await new Promise((r) => { setTimeout(r, 5); });
        etat.enVol -= 1;
        return { id: `id-${u.phoneE164}`, created: true };
      },
    };
    return { etat, contacts };
  }

  it('🔴 plusieurs écritures en vol, mais BORNÉES (le pool n’est pas à nous seuls)', async () => {
    const { etat, contacts } = storeQuiCompte();
    const items = Array.from({ length: 20 }, (_, i) => ({ phone: `+3360000${String(i).padStart(4, '0')}` }));
    await upsertContactsFromApi('t1', items, {
      contacts: contacts as never,
      fields: { list: async () => [] } as never,
    });
    expect(etat.total).toBe(20);
    expect(etat.max).toBeGreaterThan(1); // ce n'est plus séquentiel
    expect(etat.max).toBeLessThanOrEqual(4); // et ça ne prend pas tout le pool
  });

  it('🔴 les résultats restent dans l’ORDRE REÇU, erreurs de validation comprises', async () => {
    // Les erreurs de validation sortent au premier temps, les écritures au second : sans le tri final, un
    // numéro invalide en tête de lot se serait retrouvé en queue de réponse, et l'intégrateur qui lit
    // `results[i]` pour son item `i` aurait attribué l'erreur au mauvais contact.
    const { contacts } = storeQuiCompte();
    const items = [
      { phone: 'pas-un-numero' },
      { phone: '+33600000001' },
      { phone: '' },
      { phone: '+33600000002' },
    ];
    const res = await upsertContactsFromApi('t1', items, {
      contacts: contacts as never,
      fields: { list: async () => [] } as never,
    });
    expect(res.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(res.map((r) => r.status)).toEqual(['error', 'created', 'error', 'created']);
  });
});
