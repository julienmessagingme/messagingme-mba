import { describe, it, expect } from 'vitest';
import { toCsv, teteCsv, TETE_APERCU_CARACTERES } from './csv';

describe('toCsv (export CSV F5, RFC 4180)', () => {
  it('assemble en-têtes + lignes, séparateur virgule, fin de ligne CRLF', () => {
    expect(toCsv(['a', 'b'], [['1', '2'], ['3', '4']])).toBe('a,b\r\n1,2\r\n3,4');
  });

  it('échappe virgule, guillemet et retour ligne (entoure de guillemets, double les guillemets internes)', () => {
    expect(toCsv(['x'], [['a,b']])).toBe('x\r\n"a,b"');
    expect(toCsv(['x'], [['a"b']])).toBe('x\r\n"a""b"');
    expect(toCsv(['x'], [['a\nb']])).toBe('x\r\n"a\nb"');
  });

  it('null / undefined -> cellule vide ; nombre -> texte', () => {
    expect(toCsv(['x', 'y', 'z'], [[null, undefined, 42]])).toBe('x,y,z\r\n,,42');
  });

  it('en-têtes seuls (aucune ligne) -> juste la ligne d\'en-têtes', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b');
  });
});

/**
 * AUDIT-SCALE-2026-08-25.md, R9 : l'aperçu envoyait le fichier ENTIER pour n'en lire que les en-têtes et
 * quatre lignes. Le mur du volume tombait donc au CHOIX du fichier, avant tout import.
 */
describe('teteCsv (tête de fichier envoyée à l\'aperçu)', () => {
  it('fichier plus court que le seuil -> rendu tel quel (nombre de lignes exact)', () => {
    const petit = 'Nom,Tel\nJulie,+33611111111\nMarc,+33622222222';
    expect(teteCsv(petit)).toBe(petit);
  });

  it('gros fichier -> seule la tête est rendue, et elle est bien plus petite que le fichier', () => {
    const ligne = 'Nom0000000,+33600000000\n';
    const gros = 'Nom,Tel\n' + ligne.repeat(60_000); // ~1,4 Mo
    const tete = teteCsv(gros);
    expect(tete.length).toBeLessThanOrEqual(TETE_APERCU_CARACTERES);
    expect(tete.length).toBeLessThan(gros.length / 2);
  });

  it('la coupe tombe sur une fin de ligne : aucune ligne tronquée ne part en exemple', () => {
    const gros = 'Nom,Tel\n' + 'Nom0000000,+33600000000\n'.repeat(60_000);
    const tete = teteCsv(gros);
    expect(tete.endsWith('+33600000000')).toBe(true);
    // Toutes les lignes de données ont la même longueur : aucune ne doit être coupée en deux.
    for (const l of tete.split('\n').slice(1)) expect(l).toBe('Nom0000000,+33600000000');
  });

  it('en-têtes seuls plus longs que le seuil -> on rend quand même quelque chose (jamais vide)', () => {
    const monstre = 'a'.repeat(TETE_APERCU_CARACTERES + 10);
    expect(teteCsv(monstre).length).toBe(TETE_APERCU_CARACTERES);
  });
});
