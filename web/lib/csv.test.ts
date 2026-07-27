import { describe, it, expect } from 'vitest';
import { toCsv } from './csv';

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
