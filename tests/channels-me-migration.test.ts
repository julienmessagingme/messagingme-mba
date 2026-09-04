import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { veutHorsTransaction } from '../src/db/migration-directives';

/**
 * La migration 0114 (Channels Me), reduite au SQL seul.
 *
 * Perimetre de cette tache (1/11) : le schema de base uniquement. Les lecteurs cote automations
 * (`COLS`, `HORS_WEBHOOK`, `AutomationRow.maxFiresPerHour`, `runner.ts`) appartiennent a une autre
 * tache du plan et ne sont PAS touches ici : ce fichier ne lit et n'atteste donc que le texte SQL de
 * la migration, jamais `src/automation/*`.
 */
const migration = readFileSync(new URL('../db/migrations/0114_channelsme.sql', import.meta.url), 'utf8');

describe('migration 0114 : les trois tables Channels Me', () => {
  it('cree exactement les trois tables attendues, toutes prefixees `channelsme_`', () => {
    const tables = [...migration.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]!);
    // Le prefixe n'est pas cosmetique : `channel` designe deja le tuyau (whatsapp | rcs) dans ce depot.
    expect(tables).toEqual(['channelsme_connections', 'channelsme_links', 'channelsme_posts']);
  });

  it('le lien n a PAS de colonne `enabled` : son etat EST celui de son automation', () => {
    const bloc = migration.slice(
      migration.indexOf('create table if not exists channelsme_links'),
      migration.indexOf('create table if not exists channelsme_posts'),
    );
    // Deux copies du meme etat divergeraient au premier chemin qui n'en ecrit qu'une.
    expect(bloc).not.toContain('enabled');
    expect(bloc).toContain('automation_id');
  });

  it('le jeton est unique GLOBALEMENT, pas par tenant', () => {
    // Il circule dans des messages publics et il est cherche sur le chemin chaud, ou le tenant est deduit du
    // NUMERO et pas du jeton : deux tenants portant le meme jeton feraient partir le mauvais scenario.
    expect(migration).toContain(
      'create unique index if not exists channelsme_links_token_key on channelsme_links (token)',
    );
  });

  it('transactionnelle ordinaire : aucune directive, donc aucune migration sans filet', () => {
    expect(veutHorsTransaction(migration)).toBe(false);
    // La directive n'existe que pour `CREATE INDEX CONCURRENTLY`. Le mot n'apparait nulle part ici, pas meme
    // en commentaire : c'est ce qui rend l'absence de directive volontaire et verifiable.
    expect(/concurrently/i.test(migration)).toBe(false);
  });

  it('ajoute les deux colonnes additives, sans backfill', () => {
    expect(migration).toContain('alter table automations add column if not exists possede_par text');
    expect(migration).toContain('alter table automations add column if not exists max_fires_per_hour integer');
    // Additif au sens strict : aucune ecriture de donnees, donc rien a rejouer ni a defaire.
    expect(/^\s*update automations/mi.test(migration)).toBe(false);
  });
});
