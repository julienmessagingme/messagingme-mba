import { describe, it, expect } from 'vitest';
import { parseChemin, cheminValide, litChemin, estScalaire, valeurTexte, LONGUEUR_VALEUR_MAX } from '../src/webhook-entrant/chemin';
import { coerceMapping, extraireDuPayload, cibleValide, refDeChamp, MAX_REGLES } from '../src/webhook-entrant/mapping';

/**
 * ⚠️ VECTEUR D'OR, à garder IDENTIQUE dans `web/lib/chemin-json.test.ts`. Le front FABRIQUE ces chemins depuis
 * l'arbre affiché, ce module les LIT, et les deux ne partagent aucun paquet. C'est ce jeu commun qui garantit
 * qu'un chemin cliqué dans l'écran est un chemin lisible par le serveur.
 */
const PAYLOAD_OR = {
  client: { tel: '+33612345678', nom: 'Marie Durand', actif: true, note: null },
  lignes: [{ prix: 42.5, ref: 'A-1' }, { prix: 10, ref: 'B-2' }],
  total: 52.5,
  'cle.avec.points': 'inadressable',
};
const CHEMINS_OR = ['client.tel', 'client.nom', 'client.actif', 'lignes[0].prix', 'lignes[1].ref', 'total'];

describe('chemin JSON : analyse', () => {
  it('accepte les formes du vecteur d’or', () => {
    for (const c of CHEMINS_OR) expect(cheminValide(c), c).toBe(true);
  });

  it('accepte un chemin qui COMMENCE par un index (racine tableau)', () => {
    expect(parseChemin('[0].nom')).toEqual([{ index: 0 }, { cle: 'nom' }]);
  });

  it('découpe clés et index dans l’ordre', () => {
    expect(parseChemin('a.b[2].c')).toEqual([{ cle: 'a' }, { cle: 'b' }, { index: 2 }, { cle: 'c' }]);
  });

  it('🔴 refuse les formes malformées, sans en accepter une par distraction', () => {
    const mauvais = ['', '   ', '.a', 'a.', 'a..b', 'a.[0]', 'a[0]b', 'a[]', 'a[-1]', 'a[1', 'a]', 'a[b]'];
    for (const m of mauvais) expect(cheminValide(m), m).toBe(false);
  });

  it('🔴 refuse un chemin plus long que la limite', () => {
    expect(cheminValide('a'.repeat(301))).toBe(false);
    expect(cheminValide('a'.repeat(300))).toBe(true);
  });

  it('l’analyse est réentrante (le lastIndex du tokeniseur ne fuit pas d’un appel à l’autre)', () => {
    // Une regex globale garde son `lastIndex` entre deux `exec`. Partagée au niveau du module, elle ferait
    // rendre un résultat DIFFÉRENT au second appel avec la même entrée.
    expect(parseChemin('a.b')).toEqual(parseChemin('a.b'));
    expect(parseChemin('lignes[0].prix')).toEqual(parseChemin('lignes[0].prix'));
  });
});

describe('chemin JSON : lecture', () => {
  it('lit chaque chemin du vecteur d’or', () => {
    expect(litChemin(PAYLOAD_OR, 'client.tel')).toBe('+33612345678');
    expect(litChemin(PAYLOAD_OR, 'client.actif')).toBe(true);
    expect(litChemin(PAYLOAD_OR, 'lignes[0].prix')).toBe(42.5);
    expect(litChemin(PAYLOAD_OR, 'lignes[1].ref')).toBe('B-2');
    expect(litChemin(PAYLOAD_OR, 'total')).toBe(52.5);
  });

  it('rend undefined sans lever quand le chemin ne résout pas', () => {
    for (const c of ['absent', 'client.absent', 'lignes[9].prix', 'client.tel.encore', 'total[0]', 'client[0]']) {
      expect(litChemin(PAYLOAD_OR, c), c).toBeUndefined();
    }
  });

  it('🔴 ne remonte JAMAIS une propriété du prototype', () => {
    // Sans la garde `hasOwnProperty`, un chemin configuré par un utilisateur lirait du code au lieu de sa
    // donnée, et `__proto__` ouvrirait la porte à des surprises bien pires qu'un champ vide.
    for (const c of ['constructor', 'client.constructor', '__proto__', 'client.__proto__', 'client.toString', 'lignes.length']) {
      expect(litChemin(PAYLOAD_OR, c), c).toBeUndefined();
    }
  });

  it('🔴 une clé contenant un point est inadressable, et le dit', () => {
    // Le tiers a le droit d'émettre une clé `cle.avec.points`. On ne peut pas la viser sans inventer une
    // syntaxe d'échappement illisible : on refuse, plutôt que de lire silencieusement autre chose.
    expect(litChemin(PAYLOAD_OR, 'cle.avec.points')).toBeUndefined();
  });

  it('traverse un payload nul ou scalaire sans casser', () => {
    expect(litChemin(null, 'a')).toBeUndefined();
    expect(litChemin('texte', 'a')).toBeUndefined();
    expect(litChemin(undefined, 'a')).toBeUndefined();
  });
});

describe('valeurs stockables', () => {
  it('🔴 seuls les scalaires : un objet ou un tableau rendrait la variable VIDE dans un template', () => {
    expect(estScalaire('x')).toBe(true);
    expect(estScalaire(0)).toBe(true);
    expect(estScalaire(false)).toBe(true);
    for (const v of [null, undefined, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) expect(estScalaire(v)).toBe(false);
  });

  it('convertit en texte, et refuse ce qui ne se stocke pas', () => {
    expect(valeurTexte(42.5)).toBe('42.5');
    expect(valeurTexte(true)).toBe('true');
    expect(valeurTexte('  espace  ')).toBe('espace');
    expect(valeurTexte(0)).toBe('0'); // 🔴 zéro est une VALEUR, pas une absence
    expect(valeurTexte(false)).toBe('false');
    expect(valeurTexte('   ')).toBeNull();
    // 🔴 Trop longue : ÉCARTÉE ici, et pas laissée au chemin d'écriture partagé, qui refuserait
    // l'enregistrement ENTIER (le téléphone avec). Une description à rallonge d'un tiers ne doit pas faire
    // perdre le reste de l'appel.
    expect(valeurTexte('x'.repeat(LONGUEUR_VALEUR_MAX))).toHaveLength(LONGUEUR_VALEUR_MAX);
    expect(valeurTexte('x'.repeat(LONGUEUR_VALEUR_MAX + 1))).toBeNull();
    expect(valeurTexte({ a: 1 })).toBeNull();
    expect(valeurTexte([1, 2])).toBeNull();
    expect(valeurTexte(null)).toBeNull();
  });
});

describe('mapping : cibles', () => {
  it('reconnaît les trois formes, et rien d’autre', () => {
    expect(cibleValide('sys:phone')).toBe(true);
    expect(cibleValide('sys:name')).toBe(true);
    expect(cibleValide('field:ville')).toBe(true);
    expect(cibleValide('field:fld_ab12_sys_email')).toBe(true);
    for (const c of ['', 'sys:autre', 'field:', 'field:   ', 'ville', 42, null, 'field:' + 'x'.repeat(101)]) {
      expect(cibleValide(c), String(c)).toBe(false);
    }
  });

  it('extrait la référence de champ', () => {
    expect(refDeChamp('field:ville')).toBe('ville');
    expect(refDeChamp('sys:phone')).toBeNull();
  });
});

describe('mapping : coercition du jsonb', () => {
  it('retire les règles illisibles au lieu de lever', () => {
    const regles = coerceMapping([
      { chemin: 'client.tel', cible: 'sys:phone' },
      { chemin: 'a..b', cible: 'field:x' },         // chemin malformé
      { chemin: 'client.nom', cible: 'sys:autre' }, // cible inconnue
      { chemin: 42, cible: 'sys:name' },            // types faux
      null,
      'texte',
      { chemin: 'total', cible: 'field:montant' },
    ]);
    expect(regles).toEqual([
      { chemin: 'client.tel', cible: 'sys:phone' },
      { chemin: 'total', cible: 'field:montant' },
    ]);
  });

  it('un mapping qui n’est pas un tableau rend un mapping vide', () => {
    expect(coerceMapping(null)).toEqual([]);
    expect(coerceMapping({ chemin: 'a', cible: 'sys:phone' })).toEqual([]);
  });

  it('borne le nombre de règles', () => {
    const trop = Array.from({ length: MAX_REGLES + 20 }, (_, i) => ({ chemin: `c${i}`, cible: 'field:x' }));
    expect(coerceMapping(trop)).toHaveLength(MAX_REGLES);
  });
});

describe('mapping : extraction', () => {
  const regles = coerceMapping([
    { chemin: 'client.tel', cible: 'sys:phone' },
    { chemin: 'client.nom', cible: 'sys:name' },
    { chemin: 'total', cible: 'field:montant' },
    { chemin: 'lignes[0].ref', cible: 'field:reference' },
    { chemin: 'client.absent', cible: 'field:jamais' },
  ]);

  it('lit ce que le mapping vise, et signale ce qui n’a rien rendu', () => {
    const ex = extraireDuPayload(PAYLOAD_OR, regles);
    expect(ex.telephone).toBe('+33612345678');
    expect(ex.nom).toBe('Marie Durand');
    expect(ex.champs).toEqual({ montant: '52.5', reference: 'A-1' });
    expect(ex.ignores).toEqual(['client.absent']);
  });

  it('🔴 n’écrit QUE ce que le mapping vise, même si le payload porte des clés à nos noms', () => {
    // C'est la garde de fond : itérer sur les clés REÇUES laisserait un tiers écrire où il veut.
    const ex = extraireDuPayload({ montant: '999', sys: { phone: '+33600000000' }, client: { tel: '+33611111111' } }, regles);
    expect(ex.champs).toEqual({});
    expect(ex.telephone).toBe('+33611111111');
  });

  it('🔴 deux règles qui résolvent sur la MÊME cible : la première gagne', () => {
    // Les deux chemins rendent une valeur : c'est le seul cas où l'ordre décide vraiment. Avec des chemins
    // dont le second ne résout pas, « premier gagnant » et « dernier gagnant » donnent le même résultat, et
    // le test ne prouverait rien.
    const deux = coerceMapping([
      { chemin: 'client.tel', cible: 'sys:phone' },
      { chemin: 'client.nom', cible: 'sys:phone' },
      { chemin: 'total', cible: 'field:montant' },
      { chemin: 'lignes[0].prix', cible: 'field:montant' },
    ]);
    const ex = extraireDuPayload(PAYLOAD_OR, deux);
    expect(ex.telephone).toBe('+33612345678');
    expect(ex.champs.montant).toBe('52.5');
  });

  it('le repli SERT quand le chemin principal est absent', () => {
    const avecRepli = coerceMapping([
      { chemin: 'absent.tel', cible: 'sys:phone' },
      { chemin: 'client.tel', cible: 'sys:phone' },
    ]);
    expect(extraireDuPayload(PAYLOAD_OR, avecRepli).telephone).toBe('+33612345678');
  });

  it('🔴 une valeur trop longue est écartée SANS emporter les autres champs', () => {
    const ex = extraireDuPayload(
      { client: { tel: '+33612345678', nom: 'Marie' }, total: 'x'.repeat(LONGUEUR_VALEUR_MAX + 1), lignes: [{ ref: 'A-1' }] },
      regles,
    );
    expect(ex.telephone).toBe('+33612345678');
    expect(ex.nom).toBe('Marie');
    expect(ex.champs).toEqual({ reference: 'A-1' }); // `montant` écarté, `reference` conservé
    expect(ex.ignores).toContain('total');
  });

  it('un payload vide ne rend rien et ne lève pas', () => {
    const ex = extraireDuPayload({}, regles);
    expect(ex.telephone).toBeNull();
    expect(ex.nom).toBeNull();
    expect(ex.champs).toEqual({});
    expect(ex.ignores).toHaveLength(5);
  });
});
