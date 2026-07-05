import { describe, it, expect } from 'vitest';
import { recognizeColumns } from '../src/crm/recognize';

describe('recognizeColumns', () => {
  it('reconnaît les attributs standard (FR + EN)', () => {
    const s = recognizeColumns(['Téléphone', 'Mobile', 'Nom', 'First Name']);
    expect(s.map((x) => x.target)).toEqual(['phone', 'phone', 'name', 'name']);
  });

  it('email -> custom avec key normalisée "email"', () => {
    const [s] = recognizeColumns(['Adresse mail']);
    expect(s?.target).toBe('custom');
    expect(s?.suggestedKey).toBe('email');
  });

  it('en-tête inconnu -> custom avec key sluggifiée', () => {
    const [s] = recognizeColumns(['Ville de résidence']);
    expect(s?.target).toBe('custom');
    expect(s?.suggestedKey).toBe('ville_de_residence');
  });

  it('"Numéro" seul -> phone, mais "Numéro de commande" -> custom', () => {
    expect(recognizeColumns(['Numéro'])[0]?.target).toBe('phone');
    const [cmd] = recognizeColumns(['Numéro de commande']);
    expect(cmd?.target).toBe('custom');
    expect(cmd?.suggestedKey).toBe('numero_de_commande');
  });
});
