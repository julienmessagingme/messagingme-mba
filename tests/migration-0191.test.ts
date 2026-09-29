import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 0191 : la recharge Stripe et le crédit offert au premier numéro. Elle passe AVANT le déploiement : l'ancien code
 * n'en lit rien, elle doit n'être qu'ADDITIVE (trois tables neuves, et une reprise qui n'écrit que dans la troisième).
 *
 * 🔴 Les contraintes SONT les invariants de ce lot : la clé primaire de `stripe_paiements` est l'idempotence du
 * webhook, les deux bornes de `credits_offerts` sont celles de l'offre, et le mode dans la clé de `stripe_clients`
 * empêche un client de test de servir en live. Les deux premières sont nommées ici parce que le code les suppose
 * (`on conflict`) ; leur effet en base est tenu par les tests d'intégration.
 */
const sql = readFileSync(new URL('../db/migrations/0191_stripe_recharge.sql', import.meta.url), 'utf8');
const code = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').trim();
const store = readFileSync(new URL('../src/stripe/store.pg.ts', import.meta.url), 'utf8').replace(/\s+/g, ' ');
const credits = readFileSync(new URL('../src/agent/credits.pg.ts', import.meta.url), 'utf8').replace(/\s+/g, ' ');

describe('migration 0191', () => {
  it('le client Stripe d’un espace : clé primaire (espace, mode), identifiant Stripe unique, cascade', () => {
    expect(code).toContain(
      'create table if not exists stripe_clients ( tenant_id uuid not null references tenants(id) on delete cascade, '
      + 'livemode boolean not null, customer_id text not null unique, cree_le timestamptz not null default now(), '
      + 'primary key (tenant_id, livemode) );',
    );
  });

  it('🔴 les paiements : la clé primaire est la SESSION, que le webhook désigne dans son `on conflict`', () => {
    expect(code).toContain('create table if not exists stripe_paiements ( session_id text primary key, ');
    expect(code).toContain('tenant_id uuid not null references tenants(id) on delete cascade, ');
    expect(code).toMatch(/montant_ht_centimes integer not null, montant_ttc_centimes integer, facture_id text, livemode boolean not null,/);
    expect(store).toContain('on conflict (session_id) do nothing');
  });

  it('🔴 le crédit offert : une offre par ESPACE, jamais deux pour un NUMÉRO, et aucune cascade', () => {
    expect(code).toContain(
      'create table if not exists credits_offerts ( tenant_id uuid primary key, phone_number_id text not null unique, '
      + 'montant_micro_eur bigint not null, offert_le timestamptz not null default now() );',
    );
    // Sans clé étrangère, délibérément : la supprimer avec l'espace rouvrirait l'offre au même numéro.
    expect(code).not.toMatch(/credits_offerts \([^;]*references/);
    // `on conflict do nothing` SANS cible : il doit couvrir TOUTES les contraintes (celles-ci, et le numéro affiché
    // de 0193), pas l'une d'elles.
    expect(credits).toMatch(/insert into credits_offerts \(tenant_id, phone_number_id, numero_affiche, montant_micro_eur\) select [^;]*? on conflict do nothing`/);
  });

  it('🔴 pas rétroactif : les espaces qui ont déjà un numéro sont marqués, à zéro', () => {
    expect(code).toContain(
      'insert into credits_offerts (tenant_id, phone_number_id, montant_micro_eur) '
      + 'select distinct on (tenant_id) tenant_id, id, 0 from phone_numbers order by tenant_id, id on conflict do nothing;',
    );
  });

  it('additive : aucune modification ni suppression d’un objet existant', () => {
    // `on delete cascade` est une clause de clé étrangère, pas une suppression : les instructions seules comptent.
    expect(code).not.toMatch(/\b(alter table|drop |update |delete from|truncate)/i);
  });

  it('⚠️ transactionnelle et sans accent grave dans le SQL', () => {
    expect(sql).not.toMatch(/--\s*migrate:\s*no-transaction/);
    expect(sql).not.toContain('`');
  });
});
