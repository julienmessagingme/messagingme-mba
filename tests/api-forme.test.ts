import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { messageDeForme } from '../src/api/forme';

/**
 * LE MESSAGE D'UN DÉFAUT DE FORME (spec 2026-09-24, § 9) : « fields.adresse : texte attendu », le CHEMIN
 * d'abord, en français. Les formes des issues de zod 4 ont été relevées sur la version installée.
 */
const s = z.strictObject({
  text: z.string().min(1).max(5),
  n: z.number().int().optional(),
  liste: z.array(z.string()).max(2).optional(),
  cat: z.enum(['a', 'b']).optional(),
});
const msg = (v: unknown, precisions?: Record<string, string>): string => {
  const r = s.safeParse(v);
  if (r.success) throw new Error('attendu : un échec de forme');
  return messageDeForme(r.error, precisions);
};

describe('messageDeForme', () => {
  it('type attendu, en français', () => {
    expect(msg({ text: 3 })).toBe('text : texte attendu');
    expect(msg({})).toBe('text : texte attendu');
    expect(msg({ text: 'a', n: 2.5 })).toBe('n : entier attendu');
  });

  it('bornes de texte et de tableau', () => {
    expect(msg({ text: '' })).toBe('text : 1 caractère(s) au moins');
    expect(msg({ text: 'abcdefg' })).toBe('text : 5 caractère(s) au plus');
    expect(msg({ text: 'a', liste: ['a', 'b', 'c'] })).toBe('liste : 2 élément(s) au plus');
  });

  it('une borne EXCLUSIVE ne s’annonce pas comme inclusive', () => {
    const r1 = z.strictObject({ n: z.number().positive() }).safeParse({ n: 0 });
    const r2 = z.strictObject({ n: z.number().lt(10) }).safeParse({ n: 10 });
    if (r1.success || r2.success) throw new Error('attendu : deux échecs de forme');
    expect(messageDeForme(r1.error)).toBe('n : plus de 0');
    expect(messageDeForme(r2.error)).toBe('n : moins de 10');
  });

  it('🔴 un chemin nommé comme une propriété d’Object ne lit pas la chaîne de prototypes', () => {
    const r = z.record(z.string(), z.string()).safeParse({ constructor: 1 });
    if (r.success) throw new Error('attendu : un échec de forme');
    expect(messageDeForme(r.error)).toBe('constructor : texte attendu');
  });

  it('champ inconnu : il est NOMMÉ', () => {
    expect(msg({ text: 'a', to: 'x' })).toBe('corps : champ inconnu (to)');
  });

  it('valeur hors énumération : les valeurs admises', () => {
    expect(msg({ text: 'a', cat: 'z' })).toBe('cat : valeur admise a | b');
  });

  it('une précision par chemin remplace la phrase générique', () => {
    expect(msg({ text: 3 }, { text: 'une phrase courte' })).toBe('text : une phrase courte');
  });

  it('⚠️ ce que l’appelant a écrit est BORNÉ avant d’être recopié dans la réponse', () => {
    const cle = 'x'.repeat(5000);
    const m = msg({ text: 'a', [cle]: 1 });
    expect(m).toBe(`corps : champ inconnu (${'x'.repeat(40)})`);
  });
});
