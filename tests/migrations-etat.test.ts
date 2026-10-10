import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { etatMigrations } from '../src/db/migrations-etat';

/** Le numéro d'une migration se LIT (`npm run migrations`) : le dossier pour ce qui est pris, la base pour l'appliqué. */
describe('etatMigrations', () => {
  const fichiers = ['0001_init.sql', '0062_email.sql', '0227_oauth.sql', '0226_x.sql', 'README.md'];

  it('le dernier pris est le dernier fichier du dossier, le prochain libre le suit sur quatre chiffres', () => {
    expect(etatMigrations(fichiers, null)).toEqual({
      dernierPris: '0227_oauth.sql', prochainLibre: '0228', dernierApplique: null, enAttente: [], sansFichier: [],
    });
  });

  it('la base dit l’appliqué, ce qui attend, et ce qui est appliqué sans fichier (0060, voulu)', () => {
    const e = etatMigrations(fichiers, ['0001_init.sql', '0060_email.sql', '0062_email.sql', '0226_x.sql']);
    expect(e.dernierApplique).toBe('0226_x.sql');
    expect(e.enAttente).toEqual(['0227_oauth.sql']);
    expect(e.sansFichier).toEqual(['0060_email.sql']);
  });

  it('le vrai dossier : un prochain libre bien formé, au-delà du dernier fichier', () => {
    const vrais = readdirSync(join(__dirname, '..', 'db', 'migrations'));
    const e = etatMigrations(vrais, null);
    expect(e.prochainLibre).toMatch(/^\d{4}$/);
    expect(Number(e.prochainLibre)).toBe(Number(e.dernierPris!.slice(0, 4)) + 1);
  });
});
