import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { upsertContactsFromApi } from '../src/api/contacts-upsert';
import { LimiteOffreError } from '../src/offres/refus';
import type { PgContactStore } from '../src/crm/contact-store.pg';
import type { PgUserFieldStore } from '../src/crm/field-store.pg';
import type { UserFieldDef } from '../src/crm/types';

/**
 * Le CHEMIN D'ÉCRITURE PAR NUMÉRO (webhook entrant, création à la main de la console).
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

/**
 * LA LIMITE DE CONTACTS DE L'OFFRE (lot 6) : le magasin refuse une création au-delà de la limite. L'upsert partagé (webhook
 * entrant, création à la main) en fait un refus de SA ligne, avec la phrase et la limite ; les autres lignes passent.
 */
describe('upsert API : la limite de contacts de l’offre', () => {
  it('🔴 la ligne refusée porte la limite, les autres passent', async () => {
    const contacts = {
      upsertByPhoneReturningId: async (u: { tenantId: string; phoneE164: string }) => {
        if (u.phoneE164.endsWith('2')) throw new LimiteOffreError(u.tenantId, 'contacts', 100);
        return { id: `id-${u.phoneE164}`, created: true };
      },
    };
    const out = await upsertContactsFromApi('t1', [{ phone: '+33600000001' }, { phone: '+33600000002' }], {
      contacts: contacts as never,
      fields: { list: async () => [] } as never,
    });
    expect(out[0]).toMatchObject({ status: 'created' });
    expect(out[1]).toMatchObject({ status: 'error', limite: 100 });
    expect(out[1]?.reason).toMatch(/Limite de votre offre atteinte : 100 contacts/);
  });
});

describe('un champ invalide : refusé par défaut, laissé de côté pour le webhook entrant', () => {
  const defs = [
    { key: 'age', label: 'Âge', type: 'number' },
    { key: 'ville', label: 'Ville', type: 'text' },
    { key: 'rdv', label: 'Rendez-vous', type: 'date' },
  ] as UserFieldDef[];

  it('par défaut (la création à la main), le contact entier est refusé, avec la raison', async () => {
    const { d, ecrits } = deps(defs);
    const [r] = await upsertContactsFromApi('t1', [{ phone: '+33612345678', fields: { age: 'abc', ville: 'Lyon' } }], d);
    expect(r).toMatchObject({ status: 'error' });
    expect(r?.reason).toMatch(/age/);
    expect(ecrits).toEqual([]);
  });

  it('🔴 avec `ignorer` (le webhook entrant), le contact est écrit avec le reste et le champ refusé est nommé', async () => {
    // Décision de Julien du 2026-10-14 : un outil tiers lit un 200 comme un succès ; le contact s'y perdait sans bruit.
    const { d, ecrits } = deps(defs);
    const [r] = await upsertContactsFromApi('t1', [{ phone: '+33612345678', name: 'Léa', fields: { age: 'abc', ville: 'Lyon' } }],
      { ...d, champsInvalides: 'ignorer' });
    expect(r).toMatchObject({ status: 'created', contactId: 'c1' });
    expect(r?.champsRefuses).toHaveLength(1);
    expect(r?.champsRefuses?.[0]).toMatch(/age/);
    expect(ecrits[0]?.fields).toEqual({ ville: 'Lyon' });
    expect(ecrits[0]?.profileName).toBe('Léa');
  });

  it('avec `ignorer` et des champs tous valides, aucune liste de refus', async () => {
    const { d } = deps(defs);
    const [r] = await upsertContactsFromApi('t1', [{ phone: '+33612345678', fields: { age: '42' } }], { ...d, champsInvalides: 'ignorer' });
    expect(r).toMatchObject({ status: 'created' });
    expect(r).not.toHaveProperty('champsRefuses');
  });

  it('🔴 le câblage : le webhook entrant, et lui seul, écrit avec `ignorer`', () => {
    // Les tests de route passent par un faux `ecrireContact` : sans cette lecture, retirer l'option du câblage ne ferait
    // rien échouer, et la création à la main garde le refus (une personne la corrige à l'écran).
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const bloc = index.slice(index.indexOf('ecrireContact: async (tenant, entree) => {'));
    expect(bloc.slice(0, 1200)).toMatch(/champsInvalides: 'ignorer'/);
    expect(index.match(/champsInvalides: 'ignorer'/g)).toHaveLength(1);
    // Et la liste des refus remonte jusqu'à la route : sans elle, la réponse dirait « N champs » sans rien des refus.
    expect(bloc.slice(0, 1600)).toMatch(/champsRefuses: res\.champsRefuses/);
  });

  it('avec `ignorer` et tous les champs refusés, le contact est écrit sans champ et chaque refus est nommé', async () => {
    const { d, ecrits } = deps(defs);
    const [r] = await upsertContactsFromApi('t1', [{ phone: '+33612345678', fields: { age: 'abc', rdv: '03/04/2026' } }],
      { ...d, champsInvalides: 'ignorer' });
    expect(r).toMatchObject({ status: 'created' });
    expect(r?.champsRefuses).toHaveLength(2);
    expect(ecrits[0]?.fields).toEqual({});
  });

  it('avec `ignorer` et le plafond de champs atteint, le champ inconnu est refusé, le champ déclaré passe', async () => {
    const { d, ecrits } = deps(defs);
    const [r] = await upsertContactsFromApi('t1', [{ phone: '+33612345678', fields: { ville: 'Lyon', couleur: 'bleu' } }],
      { ...d, champsInvalides: 'ignorer', maxChampsParEspace: 3 });
    expect(r).toMatchObject({ status: 'created' });
    expect(r?.champsRefuses).toHaveLength(1);
    expect(r?.champsRefuses?.[0]).toMatch(/plafond/);
    expect(ecrits[0]?.fields).toEqual({ ville: 'Lyon' });
  });
});
