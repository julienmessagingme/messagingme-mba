import { describe, it, expect } from 'vitest';
import { upsertContactsFromApi } from '../src/api/contacts-upsert';
import type { PgContactStore } from '../src/crm/contact-store.pg';
import type { PgUserFieldStore } from '../src/crm/field-store.pg';
import type { UserFieldDef } from '../src/crm/types';

/**
 * LE PLAFOND DE CHAMPS PERSONNALISÉS D'UN ESPACE, sur le chemin de l'API publique.
 *
 * 🔴 TRANCHÉ PAR JULIEN LE 2026-09-14 : « garder, mais borné ». L'auto-création d'un champ inconnu est un
 * choix produit utile (l'import CSV fait pareil) et ne change pas pour un intégrateur normal. Ce qui
 * change, c'est qu'elle a une fin : une boucle d'appels avec des clés aléatoires faisait grossir
 * `user_fields` SANS AUCUNE LIMITE pour l'espace visé, et chaque définition créée y reste.
 *
 * 🔴 CE QUE LE PLAFOND NE FAIT PAS, ET C'EST LA MOITIÉ DU SUJET : il ne casse rien de ce qui existe. Il
 * refuse la CRÉATION d'une définition de plus ; les valeurs des champs DÉJÀ déclarés continuent de passer,
 * y compris dans le même lot et pour le même contact. Un plafond qui bloquerait tout l'espace une fois
 * atteint transformerait une protection en panne.
 *
 * ⚠️ IL VIT SUR LE CHEMIN DE L'API, PAS DANS `ensureFieldByKey`. Cet utilitaire sert aussi aux champs que
 * le PRODUIT pose lui-même (le consentement WhatsApp, l'origine d'une pub CTWA) : les soumettre au
 * plafond ferait échouer un mécanisme interne pour une raison commerciale, sur un espace chargé.
 */
interface Ecrit { fields: Record<string, string> }

function deps(defs: UserFieldDef[], max?: number) {
  const ecrits: Ecrit[] = [];
  const crees: string[] = [];
  const contacts = {
    upsertByPhoneReturningId: async (c: { fields: Record<string, string> }) => {
      ecrits.push({ fields: c.fields });
      return { id: `c${ecrits.length}`, created: true };
    },
  } as unknown as PgContactStore;
  const fields = {
    list: async () => defs,
    // ⚠️ LE FAUX ENREGISTRE CE QU'ON LUI DEMANDE DE CRÉER : c'est ce compte, et non le statut rendu, qui
    // dit si le plafond a vraiment retenu quelque chose. Un test qui ne regarderait que l'outcome
    // passerait sur un code qui crée la définition PUIS refuse le contact.
    upsert: async (_t: string, d: UserFieldDef) => { crees.push(d.key); },
  } as unknown as PgUserFieldStore;
  return { d: { contacts, fields, ...(max === undefined ? {} : { maxChampsParEspace: max }) }, ecrits, crees };
}

const champ = (key: string): UserFieldDef => ({ key, label: key, type: 'text' } as UserFieldDef);

/**
 * ⚠️ DES NUMÉROS COMPLETS, ET CE N'EST PAS DU DÉTAIL. Ces cas appellent le VRAI service, qui normalise le
 * téléphone AVANT de regarder les champs : un numéro trop court (« +33611 ») sort en « téléphone
 * invalide » et le test rougit en accusant le plafond, qui n'a rien fait. Les tests de ROUTE, eux, passent
 * par un faux service et acceptent n'importe quoi : la même donnée n'y a pas le même sens.
 */

describe('le plafond de champs personnalisés par espace', () => {
  it('🔴 au plafond, un champ INCONNU est refusé, et rien n’est créé', async () => {
    const { d, crees } = deps([champ('prenom'), champ('ville')], 2);
    const out = await upsertContactsFromApi('t1', [{ phone: '+33612345678', fields: { nouveau: 'x' } }], d);
    expect(out[0]).toMatchObject({ index: 0, status: 'error' });
    expect(out[0]!.reason).toMatch(/champs personnalisés/i);
    expect(crees).toEqual([]);
  });

  it('🔴 au plafond, les champs DÉJÀ déclarés passent : le plafond ne casse pas l’existant', async () => {
    const { d, ecrits, crees } = deps([champ('prenom'), champ('ville')], 2);
    const out = await upsertContactsFromApi('t1', [{ phone: '+33612345678', fields: { prenom: 'Marc', ville: 'Lyon' } }], d);
    expect(out[0]).toMatchObject({ status: 'created' });
    expect(ecrits[0]!.fields).toEqual({ prenom: 'Marc', ville: 'Lyon' });
    expect(crees).toEqual([]);
  });

  it('🔴 dans un MÊME lot, le refus ne touche que les contacts qui créeraient un champ de plus', async () => {
    // Le cas réel d'une boucle : un lot mixte, dont certaines lignes portent des clés inventées. Les
    // lignes saines doivent passer, sinon la protection coûte plus cher que ce qu'elle protège.
    const { d, crees } = deps([champ('prenom')], 1);
    const out = await upsertContactsFromApi('t1', [
      { phone: '+33612345678', fields: { prenom: 'A' } },
      { phone: '+33698765432', fields: { invente_1: 'x' } },
      { phone: '+33755667788', fields: { prenom: 'C' } },
    ], d);
    expect(out.map((o) => o.status)).toEqual(['created', 'error', 'created']);
    expect(crees).toEqual([]);
  });

  it('⚠️ le plafond compte les créations DU LOT, pas seulement celles d’avant', async () => {
    // Sans cela, un seul appel de 500 contacts porteurs de 500 clés distinctes passerait entièrement : le
    // plafond ne serait qu'un compteur d'historique, jamais une borne.
    const { d, crees } = deps([], 2);
    const out = await upsertContactsFromApi('t1', [
      { phone: '+33612345678', fields: { a: '1' } },
      { phone: '+33698765432', fields: { b: '2' } },
      { phone: '+33755667788', fields: { c: '3' } },
    ], d);
    expect(out.map((o) => o.status)).toEqual(['created', 'created', 'error']);
    expect(crees).toEqual(['a', 'b']);
  });

  it('un intégrateur normal crée ses trois champs sans rien voir', async () => {
    // Le témoin dans l'autre sens, et il est indispensable : un plafond posé trop bas (ou compté de
    // travers) casserait le premier appel d'un client qui découvre l'API.
    const { d, crees } = deps([], 200);
    const out = await upsertContactsFromApi('t1', [
      { phone: '+33612345678', fields: { prenom: 'A', ville: 'Lyon', segment: 'vip' } },
    ], d);
    expect(out[0]).toMatchObject({ status: 'created' });
    expect(crees).toEqual(['prenom', 'ville', 'segment']);
  });

  it('⚠️ 0 DÉSACTIVE le plafond, comme les plafonds de débit : c’est le levier d’urgence', async () => {
    const { d, crees } = deps([], 0);
    const out = await upsertContactsFromApi('t1', [{ phone: '+33612345678', fields: { invente: 'x' } }], d);
    expect(out[0]).toMatchObject({ status: 'created' });
    expect(crees).toEqual(['invente']);
  });
});
