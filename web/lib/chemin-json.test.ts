import { describe, it, expect } from 'vitest';
import { arbreDuPayload, cheminsAttachables, apercuValeur, ELEMENTS_MAX, PROFONDEUR_MAX } from './chemin-json';

/**
 * ⚠️ VECTEUR D'OR, à garder IDENTIQUE dans `tests/webhook-entrant-chemin.test.ts`. Ce module FABRIQUE les
 * chemins, le serveur les LIT, et les deux ne partagent aucun paquet. C'est ce jeu commun qui garantit qu'un
 * chemin cliqué dans l'écran est un chemin lisible par le serveur.
 */
const PAYLOAD_OR = {
  client: { tel: '+33612345678', nom: 'Marie Durand', actif: true, note: null },
  lignes: [{ prix: 42.5, ref: 'A-1' }, { prix: 10, ref: 'B-2' }],
  total: 52.5,
  'cle.avec.points': 'inadressable',
};
const CHEMINS_OR = ['client.tel', 'client.nom', 'client.actif', 'lignes[0].prix', 'lignes[1].ref', 'total'];

describe('arbre JSON : les chemins fabriqués', () => {
  it('🔴 produit EXACTEMENT les chemins que le serveur sait lire', () => {
    const attachables = cheminsAttachables(arbreDuPayload(PAYLOAD_OR));
    for (const c of CHEMINS_OR) expect(attachables, c).toContain(c);
  });

  it('🔴 une clé contenant un point n’est JAMAIS proposée', () => {
    // Le serveur ne peut pas la relire (la grammaire n'a pas d'échappement). La proposer donnerait un mapping
    // qui semble configuré et ne rend jamais rien.
    const attachables = cheminsAttachables(arbreDuPayload(PAYLOAD_OR));
    expect(attachables).not.toContain('cle.avec.points');
    expect(attachables.some((c) => c.includes('cle.avec'))).toBe(false);
  });

  it('la clé inadressable reste AFFICHÉE, simplement pas attachable', () => {
    // La masquer ferait chercher une clé qu'on a bien reçue.
    const racine = arbreDuPayload(PAYLOAD_OR);
    const perdue = racine.find((n) => n.cle === 'cle.avec.points');
    expect(perdue).toBeDefined();
    expect(perdue?.attachable).toBe(false);
    expect(perdue?.chemin).toBe('');
  });

  it('🔴 l’inadressabilité se propage à TOUT le sous-arbre', () => {
    // Sinon on proposerait `x` pour `{"a.b": {"x": 1}}`, qui pointe ailleurs dans le payload.
    const arbre = arbreDuPayload({ 'a.b': { x: 1, y: { z: 2 } }, ok: { x: 3 } });
    expect(cheminsAttachables(arbre)).toEqual(['ok.x']);
  });

  it('un objet et un tableau ne sont pas attachables, leurs feuilles le sont', () => {
    const arbre = arbreDuPayload(PAYLOAD_OR);
    const client = arbre.find((n) => n.cle === 'client');
    expect(client?.type).toBe('objet');
    expect(client?.attachable).toBe(false);
    expect(client?.enfants.find((n) => n.cle === 'tel')?.attachable).toBe(true);
    const lignes = arbre.find((n) => n.cle === 'lignes');
    expect(lignes?.type).toBe('tableau');
    expect(lignes?.attachable).toBe(false);
    expect(lignes?.enfants[0]?.cle).toBe('[0]');
  });

  it('🔴 `null` n’est pas attachable (une absence n’est pas une valeur)', () => {
    const arbre = arbreDuPayload(PAYLOAD_OR);
    const note = arbre.find((n) => n.cle === 'client')?.enfants.find((n) => n.cle === 'note');
    expect(note?.chemin).toBe('client.note'); // le chemin existe...
    expect(note?.attachable).toBe(false);     // ... mais il n'y a rien à stocker
  });

  it('un payload scalaire ou absent rend un arbre vide', () => {
    expect(arbreDuPayload(null)).toEqual([]);
    expect(arbreDuPayload(undefined)).toEqual([]);
    expect(arbreDuPayload('texte')).toEqual([]);
  });

  it('un payload RACINE tableau est déplié avec des chemins indexés', () => {
    expect(cheminsAttachables(arbreDuPayload([{ nom: 'a' }, { nom: 'b' }]))).toEqual(['[0].nom', '[1].nom']);
  });
});

describe('arbre JSON : les bornes', () => {
  it('un très grand tableau est tronqué', () => {
    const gros = { lignes: Array.from({ length: ELEMENTS_MAX + 50 }, (_, i) => ({ i })) };
    expect(arbreDuPayload(gros)[0]?.enfants).toHaveLength(ELEMENTS_MAX);
  });

  it('un payload très profond cesse d’être déplié', () => {
    // Construit une imbrication plus profonde que la limite.
    let profond: Record<string, unknown> = { fin: 1 };
    for (let i = 0; i < PROFONDEUR_MAX + 3; i += 1) profond = { n: profond };
    const chemins = cheminsAttachables(arbreDuPayload(profond));
    expect(chemins).toEqual([]); // la feuille est au-delà de la limite : rien n'est proposé
  });
});

describe('arbre JSON : les aperçus', () => {
  it('résume ce qu’on ne peut pas attacher, et montre ce qu’on peut', () => {
    expect(apercuValeur({ a: 1, b: 2 })).toBe('2 champs');
    expect(apercuValeur([1])).toBe('1 élément');
    expect(apercuValeur([1, 2])).toBe('2 éléments');
    expect(apercuValeur(null)).toBe('null');
    expect(apercuValeur(false)).toBe('false');
    expect(apercuValeur('x'.repeat(80))).toHaveLength(58); // tronqué + points de suspension
  });
});
