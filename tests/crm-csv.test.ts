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

  it('🔴 un CSV en point-virgule dont une colonne porte des virgules garde ses colonnes', () => {
    // Mesuré le 2026-09-30 : laissé deviner, papaparse prenait la virgule, l'en-tête devenait la seule colonne
    // « Nom;Téléphone;Adresse », et l'import de contacts rejetait chaque ligne (« numéro invalide »).
    const { headers, rows } = parseCsv([
      'Nom;Téléphone;Adresse',
      'Dupont;0612345678;Résidence Les Pins, bât. A, 12 rue de la Paix, 75002 Paris',
      'Martin;0700000000;Chez M. Martin, 2e étage, 3 avenue Foch, 69006 Lyon',
    ].join('\n'));
    expect(headers).toEqual(['Nom', 'Téléphone', 'Adresse']);
    expect(rows).toEqual([
      { Nom: 'Dupont', 'Téléphone': '0612345678', Adresse: 'Résidence Les Pins, bât. A, 12 rue de la Paix, 75002 Paris' },
      { Nom: 'Martin', 'Téléphone': '0700000000', Adresse: 'Chez M. Martin, 2e étage, 3 avenue Foch, 69006 Lyon' },
    ]);
  });

  it('des rangées inégales retombent sur le séparateur que devine papaparse, comme avant', () => {
    // Aucun séparateur n'y rend un tableau régulier (une cellule manque) : un séparateur imposé, la virgule par
    // exemple, lirait ce fichier en point-virgule comme une seule colonne.
    const { headers, rows } = parseCsv('nom;tel;ville\nJulie;0612345678');
    expect(headers).toEqual(['nom', 'tel', 'ville']);
    expect(rows[0]).toEqual({ nom: 'Julie', tel: '0612345678', ville: '' });
  });
});
