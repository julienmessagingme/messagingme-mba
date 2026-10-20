import { describe, it, expect } from 'vitest';
import { OUTILS, type DepsMcp } from '../src/mcp/outils';
import { RefusOutil } from '../src/mcp/saisie';
import { DROITS } from '../src/offres/offres';
import type { UserFieldDef } from '../src/crm/types';
import type { BulkEdits, BulkTarget } from '../src/crm/contact-store.pg';

/**
 * LES CHAMPS DEPUIS CLAUDE (plan docs/superpowers/plans/2026-10-20-champs-depuis-claude.md) : lister les champs d'un
 * espace, en créer un, en remplir un sur une cible. Les trois appellent ce que la console appelle (`creerChamp`,
 * `defPourEcriture`, `validateFieldValue`, `applyEditsMany`) : ce fichier tient ce que l'outil ajoute devant.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const C1 = '11111111-1111-4111-8111-111111111111';
const PERSONNE = { userId: 'u1' };
const outil = (nom: string) => OUTILS.find((o) => o.nom === nom)!;

const VILLE: UserFieldDef = { key: 'ville', label: 'Ville', type: 'text' };
const AGE: UserFieldDef = { key: 'age', label: 'Âge', type: 'number' };

function deps(o: { couteuxAccepte?: boolean } = {}) {
  const trace: string[] = [];
  const crees: UserFieldDef[] = [];
  const ecrits: Array<{ cible: BulkTarget; edits: BulkEdits }> = [];
  const champs = [VILLE, AGE];
  const d = {
    offres: { offreDe: async () => ({ droits: { fonctions: DROITS.pro.fonctions } }) },
    couteux: { consommer: async () => { trace.push('plafond'); return { accepte: o.couteuxAccepte ?? true, attenteMs: 1000 }; } },
    inbox: { contactIdsDesConversations: async () => [] },
    champs: {
      list: async () => champs,
      create: async (_t: string, def: UserFieldDef) => { if (champs.some((c) => c.key === def.key)) return 'exists'; crees.push(def); return 'created'; },
    },
    ensureSocleField: async (_t: string, key: string, label: string, type: UserFieldDef['type']) => { trace.push(`socle:${key}`); champs.push({ key, label, type }); },
    contacts: {
      contactIdsForTarget: async (_t: string, cible: BulkTarget) => ('ids' in cible ? cible.ids : []),
      applyEditsMany: async (_t: string, cible: BulkTarget, edits: BulkEdits) => { trace.push('ecriture'); ecrits.push({ cible, edits }); return { affected: 12, stopsGardes: 0 }; },
    },
  } as unknown as DepsMcp;
  return { d, trace, crees, ecrits };
}

describe('list_fields', () => {
  it('une lecture ouverte à toutes les offres, lisible avec une clé', () => {
    const o = outil('list_fields');
    expect(o.fonction).toBeNull();
    expect(o.scope).toBe('mcp:read');
    expect(o.exigePersonne).toBeUndefined();
  });

  it('rend clé, libellé et type, et dit comment s’en servir dans une variable', async () => {
    const r = (await outil('list_fields').executer(deps().d, T, {}, null)) as { fields: Array<{ key: string }> };
    expect(r.fields.slice(-2)).toEqual([{ key: 'ville', label: 'Ville', type: 'text' }, { key: 'age', label: 'Âge', type: 'number' }]);
  });

  it('les champs de base (prénom, e-mail) sont listés même s’ils n’ont jamais servi (relecture, jaune 1)', async () => {
    const r = (await outil('list_fields').executer(deps().d, T, {}, null)) as { fields: Array<{ key: string }> };
    expect(r.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['prenom', 'email']));
    expect(new Set(r.fields.map((f) => f.key)).size).toBe(r.fields.length);
  });
});

describe('create_field', () => {
  it('🔴 une écriture au nom d’une personne, ouverte à toutes les offres comme l’API', () => {
    const o = outil('create_field');
    expect(o.fonction).toBeNull();
    expect(o.exigePersonne).toBe(true);
    expect(o.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('crée le champ par la fonction de la console : la clé vient du libellé', async () => {
    const { d, crees } = deps();
    expect(await outil('create_field').executer(d, T, { label: 'Code postal', type: 'text' }, PERSONNE)).toEqual({ key: 'code_postal', label: 'Code postal', type: 'text' });
    expect(crees).toEqual([{ key: 'code_postal', label: 'Code postal', type: 'text' }]);
  });

  it('refuse un type inconnu, un libellé de champ de base, une clé existante, et sans personne', async () => {
    const { d, crees } = deps();
    for (const [args, personne] of [
      [{ label: 'Couleur', type: 'color' }, PERSONNE],
      [{ label: 'Nom', type: 'text' }, PERSONNE],
      [{ label: 'Ville', type: 'text' }, PERSONNE],
      [{ label: 'Pays', type: 'text' }, null],
    ] as const) {
      await expect(outil('create_field').executer(d, T, args, personne), JSON.stringify(args)).rejects.toThrow(RefusOutil);
    }
    expect(crees).toEqual([]);
  });
});

describe('set_contact_field', () => {
  it('🔴 une action en masse de l’offre console, au nom d’une personne', () => {
    const o = outil('set_contact_field');
    expect(o.fonction).toBe('console');
    expect(o.exigePersonne).toBe(true);
  });

  it('remplit le champ sur la cible, par l’action en masse, valeur ramenée à sa forme canonique', async () => {
    const { d, trace, ecrits } = deps();
    expect(await outil('set_contact_field').executer(d, T, { key: 'age', value: ' 42 ', contact_ids: [C1] }, PERSONNE)).toEqual({ updated: 12 });
    expect(ecrits).toEqual([{ cible: { ids: [C1] }, edits: { setField: { key: 'age', value: '42' } } }]);
    expect(trace).toEqual(['plafond', 'ecriture']);
  });

  it('un champ de base absent (prénom) est créé comme dans la console', async () => {
    const { d, trace } = deps();
    await outil('set_contact_field').executer(d, T, { key: 'prenom', value: 'Léa', contact_ids: [C1] }, PERSONNE);
    expect(trace).toContain('socle:prenom');
  });

  it('🔴 refusé sans rien écrire : champ inconnu, valeur hors type, cible vide, plafond atteint', async () => {
    for (const [args, o] of [
      [{ key: 'inconnu', value: 'x', contact_ids: [C1] }, {}],
      [{ key: 'age', value: 'quarante', contact_ids: [C1] }, {}],
      [{ key: 'ville', value: 'Lyon' }, {}],
      [{ key: 'ville', value: 'Lyon', contact_ids: [C1] }, { couteuxAccepte: false }],
    ] as const) {
      const v = deps(o);
      await expect(outil('set_contact_field').executer(v.d, T, args, PERSONNE), JSON.stringify(args)).rejects.toThrow(RefusOutil);
      expect(v.ecrits, JSON.stringify(args)).toEqual([]);
    }
  });

describe('set_contact_field : la personne et la cible d’abord (relecture, jaunes 2 et 7)', () => {
  it('sans personne : refusé, rien n’est lu ni écrit', async () => {
    const { d, trace, ecrits } = deps();
    await expect(outil('set_contact_field').executer(d, T, { key: 'ville', value: 'Lyon', contact_ids: [C1] }, null)).rejects.toThrow(RefusOutil);
    expect(trace).toEqual([]);
    expect(ecrits).toEqual([]);
  });

  it('une cible vide est refusée AVANT de créer un champ de base', async () => {
    const { d, trace } = deps();
    await expect(outil('set_contact_field').executer(d, T, { key: 'prenom', value: 'Léa' }, PERSONNE)).rejects.toThrow(RefusOutil);
    expect(trace).toEqual([]);
  });
});
});
