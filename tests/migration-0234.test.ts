import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0234 : les e-mails du produit (lot 7). Ce que la migration doit tenir, et que seul son texte peut dire avant qu'elle ne
 * passe en production : le dédoublonnage en base, la cascade avec l'espace et l'identité (la suppression d'un espace ne
 * la nomme pas), et l'index partiel de la reprise.
 */
const SQL = readFileSync(new URL('../db/migrations/0234_emails_produit.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL).map(sansCommentaires).map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()).filter((i) => i !== '');
const table = (nom: string): string => instructions.find((i) => i.startsWith(`create table if not exists ${nom} `)) ?? '';

describe('migration 0234', () => {
  it('🔴 dans une transaction, sous un délai de verrou, sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
    expect(instructions[0]).toBe("set local lock_timeout = '5s'");
  });

  it('🔴 la langue de la personne : fr par défaut, fr ou en seulement', () => {
    expect(instructions).toContain("alter table identities add column if not exists langue text not null default 'fr'");
    expect(instructions).toContain("alter table identities add constraint identities_langue_check check (langue in ('fr', 'en'))");
  });

  it('🔴 le journal : une ligne par personne et par occasion, effacée avec l’espace et l’identité', () => {
    const envois = table('emails_produit_envois');
    expect(envois).toContain('constraint emails_produit_envois_une_par_occasion unique (tenant_id, cle, identity_id, occasion)');
    expect(envois).toContain('tenant_id uuid not null references tenants(id) on delete cascade');
    expect(envois).toContain('identity_id uuid not null references identities(id) on delete cascade');
    expect(envois).toContain("check (statut in ('a_envoyer', 'envoye', 'echec', 'ignore'))");
    expect(envois).toContain('prochain_essai_le timestamptz');
    // Aucune adresse en clair : la personne seulement.
    expect(envois).not.toMatch(/\bemail\b/);
  });

  it('🔴 la reprise a son index partiel, et la cascade de l’identité le sien', () => {
    expect(instructions).toContain(
      "create index if not exists emails_produit_envois_a_envoyer_idx on emails_produit_envois (cree_le) where statut = 'a_envoyer'",
    );
    expect(instructions).toContain('create index if not exists emails_produit_envois_identite_idx on emails_produit_envois (identity_id)');
  });

  it('les textes : un bouton a son libellé ET son lien, ou ni l’un ni l’autre ; les désinscriptions, deux catégories', () => {
    expect(table('emails_produit_textes')).toContain('check ((bouton_libelle is null) = (bouton_lien is null))');
    expect(table('emails_produit_desinscriptions')).toContain("check (categorie in ('commercial', 'transfert'))");
    expect(table('emails_produit_desinscriptions')).toContain('references identities(id) on delete cascade');
  });
});
