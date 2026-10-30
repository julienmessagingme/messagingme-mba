import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0264 : le Crédit WhatsApp, lot 1 (plan docs/superpowers/plans/2026-10-30-credit-whatsapp-notre-cote.md, tâche 1).
 * La garde de la fabrique d'envoi lit `lignes_credit_whatsapp` à chaque envoi : la migration part SEULE, avant le code.
 * Le CHECK des motifs de pause est tenu par tests/numero-suspendu.test.ts.
 */
const SQL = readFileSync(new URL('../db/migrations/0264_credit_whatsapp.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');
const table = (nom: string): string => instructions.find((i) => i.startsWith(`create table if not exists ${nom} (`)) ?? '';
const CATEGORIES = "check (categorie in ('marketing', 'utility', 'authentication', 'authentication_international', 'service'))";

describe('migration 0264', () => {
  it('le solde est en micro-euros signés : une régularisation peut le rendre négatif', () => {
    expect(table('credits_whatsapp')).toContain('solde_micro_eur bigint not null default 0,');
    expect(table('credits_whatsapp')).not.toContain('solde_micro_eur >=');
  });

  it('une provision : montant jamais négatif, catégories et états fermés, pays ISO ou inconnu', () => {
    const t = table('credit_whatsapp_provisions');
    expect(t).toContain('montant_micro_eur bigint not null check (montant_micro_eur >= 0)');
    expect(t).toContain(`categorie text not null ${CATEGORIES}`);
    expect(t).toContain("etat text not null default 'provisionne' check (etat in ('provisionne', 'rendu', 'ajuste'))");
    expect(t).toContain("pays text check (pays is null or pays ~ '^[A-Z]{2}$')");
    expect(t).not.toContain('references phone_numbers');
  });

  it('🔴 un wamid ne porte qu’une provision, un paiement ne crédite qu’une fois, une régularisation par jour', () => {
    expect(instructions).toContain(
      'create unique index if not exists credit_whatsapp_provisions_wamid_uidx on credit_whatsapp_provisions (tenant_id, wamid) where wamid is not null',
    );
    expect(instructions).toContain(
      'create unique index if not exists credit_whatsapp_mouvements_reference_uidx on credit_whatsapp_mouvements (tenant_id, reference) where reference is not null',
    );
    expect(instructions).toContain(
      "create unique index if not exists credit_whatsapp_mouvements_regularisation_uidx on credit_whatsapp_mouvements (tenant_id, jour) where raison = 'regularisation'",
    );
  });

  it('🔴 la franchise d’un numéro se compte par un index PARTIEL (sa requête le reprend : tests/credit-whatsapp-inventaire.test.ts)', () => {
    expect(instructions).toContain(
      "create index if not exists credit_whatsapp_provisions_service_idx on credit_whatsapp_provisions (phone_number_id, cree_le) where categorie = 'service' and etat <> 'rendu'",
    );
  });

  it('🔴 la marque « sur la ligne » survit au numéro : aucune clé étrangère vers phone_numbers, une en cours par numéro', () => {
    const t = table('lignes_credit_whatsapp');
    expect(t).not.toContain('phone_numbers');
    expect(t).toContain("origine text not null check (origine in ('ops', 'option'))");
    expect(t).toContain('arretee_le timestamptz,');
    expect(t).toContain('retiree_le timestamptz,');
    // Une ligne arrêtée bloque encore le numéro (elle paie chez Meta) : seule une ligne retirée libère la place.
    expect(instructions).toContain(
      'create unique index if not exists lignes_credit_whatsapp_numero_uidx on lignes_credit_whatsapp (phone_number_id) where retiree_le is null',
    );
  });

  it('la grille de Meta : en euros, par marché, catégorie et palier', () => {
    expect(table('grilles_meta')).toContain("devise text not null default 'EUR' check (devise = 'EUR')");
    const t = table('grille_meta_tarifs');
    expect(t).toContain(`categorie text not null ${CATEGORIES}`);
    expect(t).toContain('primary key (grille_id, marche, categorie, palier)');
  });

  it('la commission des messages : une seule ligne garantie par le schéma, 5 % par défaut', () => {
    const t = table('credit_whatsapp_reglages');
    expect(t).toContain('id boolean primary key default true check (id)');
    expect(t).toContain('commission_pct integer not null default 5 check (commission_pct between 0 and 100)');
    expect(instructions).toContain('insert into credit_whatsapp_reglages (id) values (true) on conflict (id) do nothing');
  });

  it('l’Entreprise : open bar éteint par défaut, commission négociée bornée sous un nom connu', () => {
    expect(instructions).toContain(
      'alter table tenants add column if not exists entreprise_open_bar_whatsapp boolean not null default false, '
        + 'add column if not exists entreprise_commission_messages_pct integer',
    );
    const i = instructions.indexOf(
      'alter table tenants add constraint tenants_entreprise_commission_messages_pct_chk check '
        + '(entreprise_commission_messages_pct is null or entreprise_commission_messages_pct between 0 and 100)',
    );
    expect(i).toBeGreaterThan(0);
    expect(instructions[i - 1]).toBe('alter table tenants drop constraint if exists tenants_entreprise_commission_messages_pct_chk');
  });

  it('le lock_timeout d’abord (tenants et campaigns sont chaudes), en transaction ordinaire, sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(instructions[0]).toBe("set local lock_timeout = '5s'");
    expect(instructions).toHaveLength(23);
    expect(SQL).not.toContain('`');
  });
});
