import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0223 : les webhooks sortants (lot 12, livraison A). Deux tables NEUVES que seul le code neuf écrit et lit : elle passe
 * AVANT le `up`. Ce que la base en fait (unicité, tentative périmée, purges, cascade) : `tests/integration/evenements.
 * integration.test.ts`, en CI.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0223_evenements_sortants.sql');
const sansCommentaires = SQL.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');

describe('migration 0223', () => {
  it('🔴 aucune clé en restrict : la suppression d’un espace passe par la cascade (RC8)', () => {
    expect(sansCommentaires).not.toMatch(/on delete restrict|on delete no action/i);
    expect(sansCommentaires).toMatch(/tenant_id\s+uuid not null references tenants \(id\) on delete cascade,\n\s+url/);
    expect(sansCommentaires).toMatch(/adresse_id\s+uuid not null references adresses_evenements \(id\) on delete cascade/);
    expect(sansCommentaires).toMatch(/contact_id\s+uuid references contacts \(id\) on delete set null/);
  });

  it('🔴 le corps est du texte, pas du jsonb : la signature porte sur les octets envoyés, dans l’ordre écrit', () => {
    expect(sansCommentaires).toMatch(/corps\s+text not null/);
    expect(sansCommentaires).not.toMatch(/corps\s+jsonb/);
  });

  it('🔴 un envoi par (adresse, événement) : un message redélivré ou une distribution rejouée n’envoie pas deux fois', () => {
    expect(sansCommentaires).toMatch(/constraint envois_evenements_un_par_adresse unique \(adresse_id, evenement_id\)/);
  });

  it('les trois statuts, HTTPS imposé, la paire de la rotation, et l’index que lit la purge RGPD', () => {
    expect(sansCommentaires).toMatch(/check \(statut in \('en_cours', 'livre', 'echec'\)\)/);
    expect(sansCommentaires).toMatch(/check \(url ~ '\^https:\/\/'/);
    expect(sansCommentaires).toMatch(/check \(\(secret_precedent_chiffre is null\) = \(secret_precedent_jusqua is null\)\)/);
    expect(sansCommentaires).toMatch(/envois_evenements_contact_idx on envois_evenements \(contact_id\) where contact_id is not null/);
  });

  it('dans une transaction ordinaire, et sans accent grave (le runner lit le fichier dans un gabarit de chaîne)', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
  });

  it('🔴 la purge RGPD d’un contact et la purge par l’offre nomment cette table', () => {
    expect(lire('../src/crm/contact-store.pg.ts')).toMatch(/delete from envois_evenements where tenant_id = \$1 and contact_id = any\(\$2::uuid\[\]\)/);
    expect(lire('../src/evenements/store.pg.ts')).toMatch(/delete from envois_evenements e using espaces s/);
  });
});
