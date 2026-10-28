import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0261 : le chiffre d'affaires attribué (plan docs/superpowers/plans/2026-10-28-revenus-attribues-lots-0-1.md, tâche 1).
 * Deux tables neuves que l'ancien code ne nomme pas ; la purge RGPD nommera la première, donc la migration part SEULE.
 */
const SQL = readFileSync(new URL('../db/migrations/0261_ventes_attribuees.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');
const table = instructions.find((i) => i.startsWith('create table if not exists ventes_attribuees')) ?? '';

describe('migration 0261', () => {
  it('🔴 effacer une personne n’efface pas le fait : commande_id nullable, contact_id et campaign_id en SET NULL', () => {
    expect(table).toContain('commande_id text,');
    expect(table).toContain('contact_id uuid references contacts(id) on delete set null');
    expect(table).toContain('campaign_id uuid references campaigns(id) on delete set null');
  });

  it('les sources, les preuves et la devise sont fermées ; le montant n’est jamais un flottant', () => {
    expect(table).toContain("source text not null check (source in ('campagne', 'relance_panier', 'scenario', 'agent', 'agent_meta'))");
    expect(table).toContain("preuve text check (preuve is null or preuve in ('panier', 'utm'))");
    expect(table).toContain("devise text not null check (devise ~ '^[A-Z]{3}$')");
    expect(table).toContain('montant numeric(18,3) not null check (montant >= 0)');
  });

  it('une date de relance pour une relance, et pour elle seule', () => {
    expect(table).toContain("constraint ventes_attribuees_relance_chk check ((source = 'relance_panier') = (relance_le is not null))");
  });

  it('🔴 orders/paid reçu deux fois : l’unicité par commande, partielle (une ligne anonymisée n’a plus de numéro)', () => {
    expect(instructions).toContain(
      'create unique index if not exists ventes_attribuees_commande_uidx on ventes_attribuees (tenant_id, commande_id) where commande_id is not null',
    );
  });

  it('le compteur des relances est anonyme : un espace, un jour, un nombre', () => {
    expect(instructions).toContain(
      'create table if not exists relances_panier_jour ( tenant_id uuid not null references tenants(id) on delete cascade, jour date not null, n integer not null default 0 check (n >= 0), primary key (tenant_id, jour) )',
    );
  });

  it('le lock_timeout d’abord (clés étrangères vers des tables chaudes), en transaction ordinaire, sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(instructions[0]).toBe("set local lock_timeout = '5s'");
    expect(instructions).toHaveLength(6);
    expect(SQL).not.toContain('`');
  });
});
