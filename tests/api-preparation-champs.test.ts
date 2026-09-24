// tests/api-preparation-champs.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MAX_TAGS_PAR_CONTACT, preparateurDeChamps, raisonDeValidation, schemaTags } from '../src/api/contacts-upsert';
import type { UserFieldDef } from '../src/crm/types';

/**
 * LA PRÉPARATION DES CHAMPS D'UN CONTACT, extraite pour être PARTAGÉE (l'upsert d'import et le service des
 * fiches de l'API publique). Ce qui compte : le cache des définitions est chargé UNE fois et grossit au fil
 * des appels, donc un champ auto-créé par le premier contact n'est pas recréé par le second, et le plafond
 * par espace se compte sur ce cache vivant.
 */
const champ = (key: string): UserFieldDef => ({ key, label: key, type: 'text' } as UserFieldDef);

function fields(defs: UserFieldDef[]) {
  const etat = { listes: 0, crees: [] as string[] };
  const store = {
    list: async () => { etat.listes += 1; return defs; },
    upsert: async (_t: string, d: UserFieldDef) => { etat.crees.push(d.key); },
  };
  return { store, etat };
}

describe('preparateurDeChamps', () => {
  it('🔴 un champ créé par un appel est CONNU du suivant : il n’est pas recréé', async () => {
    const { store, etat } = fields([champ('prenom')]);
    const preparer = await preparateurDeChamps('t1', { fields: store, maxChampsParEspace: 0 });
    expect(await preparer({ prenom: 'Marc', ville: 'Lyon' })).toEqual({ ok: true, valeurs: { prenom: 'Marc', ville: 'Lyon' } });
    expect(await preparer({ ville: 'Paris' })).toEqual({ ok: true, valeurs: { ville: 'Paris' } });
    expect(etat.crees).toEqual(['ville']);
  });

  it('au plafond, un champ INCONNU est refusé en le disant, et rien n’est créé', async () => {
    const { store, etat } = fields([champ('prenom')]);
    const preparer = await preparateurDeChamps('t1', { fields: store, maxChampsParEspace: 1 });
    const r = await preparer({ nouveau: 'x' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.raison).toMatch(/plafond de 1 champs personnalisés/);
    expect(etat.crees).toEqual([]);
  });

  it('un code `fld_` inconnu est refusé : un code ne se devine pas', async () => {
    const { store } = fields([]);
    const preparer = await preparateurDeChamps('t1', { fields: store, maxChampsParEspace: 0 });
    expect(await preparer({ fld_inexistant: 'x' })).toEqual({ ok: false, raison: 'champ inconnu : fld_inexistant' });
  });

  it('aucun champ : aucune valeur, et c’est un succès', async () => {
    const { store } = fields([]);
    expect(await (await preparateurDeChamps('t1', { fields: store }))(undefined)).toEqual({ ok: true, valeurs: {} });
  });
});

describe('raisonDeValidation : les clés de l’API des fiches', () => {
  const echec = (schema: z.ZodType, corps: unknown): string => {
    const r = schema.safeParse(corps);
    if (r.success) throw new Error('attendu un échec');
    return raisonDeValidation(r.error);
  };

  it('🔴 l’ancienne clé `optIn` est REFUSÉE en nommant celle qui la remplace', () => {
    expect(echec(z.object({ optIn: z.never().optional() }), { optIn: true })).toMatch(/consent/);
  });

  it('`phone` refusé sur une modification dit pourquoi', () => {
    expect(echec(z.object({ phone: z.never().optional() }), { phone: '+33612345678' })).toMatch(/ne se modifie pas/);
  });

  it('les bornes nomment le champ : `contactId`, `externalId`, `consent`, `consentSource`', () => {
    expect(echec(z.object({ contactId: z.guid() }), { contactId: 'c1' })).toMatch(/« contactId » : un identifiant de fiche/);
    expect(echec(z.object({ externalId: z.string().max(512) }), { externalId: 'x'.repeat(513) })).toMatch(/« externalId » : texte de 512 caractères au plus/);
    expect(echec(z.object({ consent: z.enum(['opted_in', 'opted_out']) }), { consent: 'oui' })).toMatch(/« consent » : « opted_in » ou « opted_out »/);
    expect(echec(z.object({ consentSource: z.string().max(100) }), { consentSource: 'x'.repeat(101) })).toMatch(/« consentSource » : 100 caractères au plus/);
  });

  it('`bsuid` refusé sur une modification dit pourquoi ; une autre clé refusée dit qu’elle n’est pas acceptée', () => {
    expect(echec(z.object({ bsuid: z.never().optional() }), { bsuid: 'B' })).toBe('« bsuid » ne se modifie pas : il porte les conversations de la fiche');
    expect(echec(z.object({ autre: z.never().optional() }), { autre: 1 })).toBe('« autre » : clé non acceptée ici');
  });

  it('🔴 les listes d’étiquettes, ET chacun de leurs éléments, répondent en français en nommant le chemin exact', () => {
    const s = z.object({ addTags: schemaTags.optional(), removeTags: schemaTags.optional(), tags: schemaTags.optional() });
    const trop = Array.from({ length: MAX_TAGS_PAR_CONTACT + 1 }, (_, i) => `t${i}`);
    expect(echec(s, { addTags: trop })).toBe(`« addTags » : une liste de ${MAX_TAGS_PAR_CONTACT} étiquettes au plus, en texte`);
    expect(echec(s, { addTags: ['ok', 'ok', 'ok', {}] })).toBe('« addTags.3 » : une étiquette est un texte ou un nombre');
    expect(echec(s, { removeTags: [[]] })).toBe('« removeTags.0 » : une étiquette est un texte ou un nombre');
    expect(echec(s, { tags: [null] })).toBe('« tags.0 » : une étiquette est un texte ou un nombre');
  });

  it('le message d’un `refine` à la racine est rendu TEL QUEL (il est écrit par nous, en français)', () => {
    const s = z.object({ a: z.string().optional() }).refine(() => false, { message: 'donnez exactement une clé' });
    expect(echec(s, {})).toBe('donnez exactement une clé');
  });
});
