import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { refusDeBase, exigerBaseJetable } from '../scripts/garde-banc';

/**
 * LA GARDE DES BANCS EST POSITIVE (plan avant la bascule, lot 2a). Après la bascule, la production est une base
 * Scaleway jointe par une adresse IP, qu'une garde « refuser supabase » laisserait passer : seule une base qui se
 * déclare jetable (« banc » ou « jetable » dans son hôte ou son nom) est acceptée.
 */
describe('la garde des bancs : seule une base qui se déclare jetable passe', () => {
  it.each([
    ['le pooler de Supabase (la production d’avant la bascule)', 'postgres://postgres.x:pw@aws-1-eu-west-2.pooler.supabase.com:6543/postgres'],
    ['une base Scaleway jointe par son IP, nom par défaut (la production d’après)', 'postgres://admin:pw@172.16.0.3:5432/rdb'],
    ['une base sans aucun marqueur', 'postgres://u:pw@db.example.com:5432/app'],
    ['Supabase, même avec une base nommée banc', 'postgres://u:pw@db.abcdef.supabase.co:5432/banc'],
  ])('🔴 refuse %s', (_cas, url) => {
    expect(refusDeBase(url)).not.toBeNull();
    expect(() => exigerBaseJetable(url)).toThrow(/base jetable/);
  });

  it('refuse une adresse vide ou illisible, en le disant', () => {
    expect(refusDeBase('')).toMatch(/manquant/);
    expect(refusDeBase('pas une adresse')).toMatch(/illisible/);
  });

  it.each([
    ['le Postgres du banc de l’API', 'postgres://postgres:pw@banc14-postgres:5432/postgres'],
    ['celui des deux copies', 'postgres://postgres:pw@banc-postgres:5432/postgres'],
    ['celui des trente espaces', 'postgres://postgres:pw@banc30-postgres:5432/postgres'],
    ['une base Scaleway nommée banc', 'postgres://admin:pw@172.16.0.3:5432/banc'],
    ['un hôte qui se dit jetable', 'postgres://u:pw@pg-jetable:5432/x'],
  ])('accepte %s', (_cas, url) => {
    expect(refusDeBase(url)).toBeNull();
    expect(() => exigerBaseJetable(url)).not.toThrow();
  });

  it.each(['banc-api.mts', 'banc-charge.mts', 'banc-deux-api.mts', 'banc-deux-api-2.mts', 'banc-trente-espaces.mts'])(
    '🔴 %s passe par la garde commune, et plus par l’ancienne garde « supabase »',
    (fichier) => {
      const texte = readFileSync(resolve(__dirname, '..', 'scripts', fichier), 'utf8');
      expect(texte).toContain("import { exigerBaseJetable } from './garde-banc';");
      expect(texte).toMatch(/exigerBaseJetable\((URL_BASE|url)\);/);
      expect(texte).not.toMatch(/\/supabase[^/]*\/i\.test\(/);
    },
  );
});
