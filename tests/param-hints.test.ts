import { describe, it, expect } from 'vitest';
import { parseParamHints } from '../src/crm/template';

describe('parseParamHints', () => {
  it('undefined -> [] (aucun indice)', () => {
    expect(parseParamHints(undefined)).toEqual([]);
    expect(parseParamHints([])).toEqual([]);
  });

  it('indices valides (sparse) préservés', () => {
    const raw = [
      { position: 1, source: { type: 'field', key: 'prenom' } },
      { position: 3, source: { type: 'attribute', key: 'name' } },
    ];
    expect(parseParamHints(raw)).toEqual(raw); // sparse OK (pas de 1..N contigu exigé)
  });

  it('accepte les attributs système bsuid et wa_id', () => {
    const raw = [
      { position: 1, source: { type: 'attribute', key: 'bsuid' } },
      { position: 2, source: { type: 'attribute', key: 'wa_id' } },
    ];
    expect(parseParamHints(raw)).toEqual(raw);
  });

  it('rejette : non-tableau, position non entière / < 1, source invalide, position en double', () => {
    expect(parseParamHints('x')).toBeNull();
    expect(parseParamHints([{ position: 1.5, source: { type: 'attribute', key: 'name' } }])).toBeNull();
    expect(parseParamHints([{ position: 0, source: { type: 'attribute', key: 'name' } }])).toBeNull();
    expect(parseParamHints([{ position: 1, source: { type: 'attribute', key: 'ville' } }])).toBeNull(); // attribute key invalide
    expect(parseParamHints([{ position: 1, source: { type: 'field' } }])).toBeNull(); // field sans key
    expect(parseParamHints([
      { position: 1, source: { type: 'attribute', key: 'name' } },
      { position: 1, source: { type: 'attribute', key: 'phone' } },
    ])).toBeNull(); // deux sources pour la même position
  });
});
