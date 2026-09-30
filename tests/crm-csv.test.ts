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

  it('tolère le BOM et les cellules manquantes, qui restent absentes', () => {
    const { headers, rows } = parseCsv('﻿nom,tel,ville\nJulie,0612345678');
    expect(headers).toEqual(['nom', 'tel', 'ville']);
    expect(rows[0]).toEqual({ nom: 'Julie', tel: '0612345678' });
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
    expect(rows[0]).toEqual({ nom: 'Julie', tel: '0612345678' });
  });

  it('🔴 un en-tête de plus de 16 384 colonnes est refusé en 400, où qu’il commence', () => {
    // Mesuré le 2026-09-30 : une ligne unique de 8 Mo (4 millions de champs) occupait l'API 6 à 13 secondes, le
    // temps que papaparse traite chaque en-tête. Ni des lignes vides, ni un saut de ligne entre guillemets placés
    // devant ne doivent le faire passer, ni une rangée de séparateurs seuls : papaparse renomme les doublons de la
    // première rangée (`_1`, `_2`...) avant de sauter les vides, et c'est elle qui devient l'en-tête.
    const ligne = (n: number): string => Array(n).fill('a').join(';');
    expect(parseCsv(`${ligne(16_384)}\nx`).headers).toHaveLength(16_384);
    for (const csv of [`${ligne(16_385)}\nx`, `\n\n${ligne(16_385)}\nx`, `"a\nb";${ligne(16_384)}\nx`, `${';'.repeat(16_384)}\nnom;tel\nJulie;06`]) {
      expect(() => parseCsv(csv)).toThrow(expect.objectContaining({ statusCode: 400, message: expect.stringContaining('16385 colonnes') }));
    }
  });

  it('🔴 une rangée plus courte que l’en-tête n’est pas complétée jusqu’à sa largeur', () => {
    // Relevé le 2026-09-30 : compléter chaque rangée par des cellules vides coûtait en-têtes x rangées, 10 s et
    // 900 Mo de tas pour 1 000 rangées d'un caractère sous 16 384 colonnes, soit un fichier de 34 Ko.
    const csv = `${Array.from({ length: 1_000 }, (_, i) => `c${i}`).join(';')}\n${Array(100).fill('x').join('\n')}`;
    const { headers, rows } = parseCsv(csv);
    expect(headers).toHaveLength(1_000);
    expect(rows).toHaveLength(100);
    expect(rows.every((r) => Object.keys(r).length === 1 && r.c0 === 'x')).toBe(true);
  });

  it('une rangée ne porte que les colonnes nommées de l’en-tête, jamais ses cellules en trop', () => {
    expect(parseCsv('a;;b\nx;y;z;t').rows[0]).toEqual({ a: 'x', b: 'z' });
  });
});
