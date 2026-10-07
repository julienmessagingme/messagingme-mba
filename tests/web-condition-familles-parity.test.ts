import { describe, it, expect } from 'vitest';
import {
  famillesDeCondition as famillesServeur, sortiesDeCondition as sortiesServeur, MAX_FAMILLES_CONDITION,
  SORTIE_SINON as SINON_SERVEUR, CODE_PREMIERE_FAMILLE as PREMIERE_SERVEUR,
} from '../src/workflow/conditions';
import {
  famillesDeCondition as famillesConsole, sortiesDeCondition as sortiesConsole, MAX_FAMILLES, SORTIE_SINON,
  CODE_PREMIERE_FAMILLE,
} from '../web/lib/condition-familles';

/**
 * LES FAMILLES D'UN BLOC CONDITION, LUES PAREIL DES DEUX CÔTÉS (RC5).
 *
 * ⚠️ Ce test SERVEUR lit un fichier CONSOLE (`web/lib/condition-familles.ts`), comme la parité de l'éligibilité de
 * campagne : les deux builds ne partagent aucun module, et c'est ici qu'on prouve qu'ils disent la même chose.
 *
 * 🔴 CE QUI SE PASSE S'ILS DIVERGENT, et c'est muet des deux côtés : la carte dessine une sortie que le moteur ne
 * prend jamais (le client la relie, personne n'y passe), ou cache une famille que le moteur suit (une branche
 * invisible à l'analyse de fenêtre et à l'éligibilité de campagne, qui sont des miroirs).
 */
const cas: Array<[string, Record<string, unknown>]> = [
  ['bloc d’avant les familles', { match: 'any', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] }],
  ['bloc vide', {}],
  ['trois familles', { familles: [
    { code: 'true', nom: 'VIP', groupe: { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] } },
    { code: 'k2', nom: 'Gold', groupe: { match: 'any', clauses: [] } },
    { code: 'k3', nom: '', groupe: { match: 'all', clauses: [] } },
  ] }],
  ['familles vides', { familles: [] }],
  ['familles malformées', { familles: [{ code: 'a' }, { code: 'a' }, { code: 'false' }, { code: 'x:y' }, null, 'texte', { code: 'b', groupe: 'pas un objet' }] }],
  ['douze familles', { familles: Array.from({ length: 12 }, (_, i) => ({ code: `c${i}`, nom: '', groupe: {} })) }],
  ['`familles` qui n’est pas un tableau : ancienne forme', { familles: { code: 'a' }, match: 'all', clauses: [] }],
];

describe('familles d’un bloc Condition : la console lit ce que le moteur lit', () => {
  it('🔴 mêmes sorties, dans le même ordre, sur chaque bloc', () => {
    for (const [nom, data] of cas) {
      expect(sortiesConsole({ data }), nom).toEqual(sortiesServeur({ data }));
    }
  });

  it('mêmes codes et mêmes groupes (le nom, lui, est rogné par le serveur et gardé tel quel par l’écran)', () => {
    for (const [nom, data] of cas) {
      const serveur = famillesServeur(data).map((f) => ({ code: f.code, groupe: f.groupe }));
      const console_ = famillesConsole(data).map((f) => ({ code: f.code, groupe: f.groupe }));
      expect(console_, nom).toEqual(serveur);
    }
  });

  it('les constantes recopiées sont les mêmes', () => {
    expect(MAX_FAMILLES).toBe(MAX_FAMILLES_CONDITION);
    expect(SORTIE_SINON).toBe(SINON_SERVEUR);
    expect(CODE_PREMIERE_FAMILLE).toBe(PREMIERE_SERVEUR);
  });
});
