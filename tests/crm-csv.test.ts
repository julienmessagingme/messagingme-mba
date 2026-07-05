import { describe, it, expect } from 'vitest';
import { parseCsv } from '../src/crm/csv';

describe('parseCsv', () => {
  it('en-têtes + lignes simples', () => {
    const { headers, rows } = parseCsv('nom,tel\nJulie,0612345678\nMarc,0700000000');
    expect(headers).toEqual(['nom', 'tel']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ nom: 'Julie', tel: '0612345678' });
  });

  it('gère les guillemets et la virgule dans un champ quoté', () => {
    const { rows } = parseCsv('nom,note\n"Durand, Julie","aime, bien"');
    expect(rows[0]).toEqual({ nom: 'Durand, Julie', note: 'aime, bien' });
  });

  it('tolère le BOM et les cellules manquantes', () => {
    const { headers, rows } = parseCsv('﻿nom,tel,ville\nJulie,0612345678');
    expect(headers).toEqual(['nom', 'tel', 'ville']);
    expect(rows[0]).toEqual({ nom: 'Julie', tel: '0612345678', ville: '' });
  });

  it('ignore les lignes vides', () => {
    const { rows } = parseCsv('nom,tel\nJulie,0612345678\n\n\nMarc,0700000000\n');
    expect(rows).toHaveLength(2);
  });

  it('trim les en-têtes et les valeurs', () => {
    const { headers, rows } = parseCsv(' nom , tel \n  Julie  ,  0612345678  ');
    expect(headers).toEqual(['nom', 'tel']);
    expect(rows[0]).toEqual({ nom: 'Julie', tel: '0612345678' });
  });
});
