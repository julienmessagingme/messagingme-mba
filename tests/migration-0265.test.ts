import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0265 : les conversions envoyées à Meta (lot 2 du plan pixel). Ce que la migration doit tenir, et que seul son texte
 * peut dire avant qu'elle ne passe en production : le dédoublonnage en base (la clé, qui est aussi l'event_id), la
 * cascade avec l'espace et l'identité (la suppression d'un espace ne la nomme pas), aucune adresse en clair, et l'index
 * partiel de la reprise.
 */
const SQL = readFileSync(new URL('../db/migrations/0265_conversions_meta.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL).map(sansCommentaires).map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()).filter((i) => i !== '');
const table = instructions.find((i) => i.startsWith('create table if not exists conversions_meta ')) ?? '';

describe('migration 0265', () => {
  it('🔴 dans une transaction, sous un délai de verrou, sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
    expect(instructions[0]).toBe("set local lock_timeout = '5s'");
  });

  it('🔴 l’accord, les identifiants de Meta et la preuve d’adresse : des colonnes nullables, sans défaut', () => {
    for (const c of ['pub_consenti_le timestamptz', 'pub_fbc text', 'pub_fbp text', 'adresse_prouvee_le timestamptz', 'pub_navigateur text']) {
      expect(instructions).toContain(`alter table identities add column if not exists ${c}`);
    }
    expect(instructions).toContain('alter table identities add constraint identities_pub_fbc_check check (pub_fbc is null or char_length(pub_fbc) between 1 and 500)');
    expect(instructions).toContain('alter table identities add constraint identities_pub_fbp_check check (pub_fbp is null or char_length(pub_fbp) between 1 and 500)');
  });

  it('🔴 le journal : une ligne par fait, effacée avec l’espace et l’identité, sans adresse', () => {
    expect(table).toContain('constraint conversions_meta_cle_unique unique (cle)');
    expect(table).toContain('identity_id uuid not null references identities(id) on delete cascade');
    expect(table).toContain('tenant_id uuid references tenants(id) on delete cascade');
    expect(table).toContain("check (evenement in ('CompleteRegistration', 'NumeroConnecte', 'Subscribe'))");
    expect(table).toContain("check (statut in ('a_envoyer', 'envoye', 'echec', 'ignore'))");
    expect(table).toContain('prochain_essai_le timestamptz');
    expect(table).not.toMatch(/\bemail\b/);
  });

  it('🔴 la reprise a son index partiel, l’identité et l’espace les leurs', () => {
    expect(instructions).toContain("create index if not exists conversions_meta_a_envoyer_idx on conversions_meta (cree_le) where statut = 'a_envoyer'");
    expect(instructions).toContain('create index if not exists conversions_meta_identite_idx on conversions_meta (identity_id)');
    expect(instructions).toContain('create index if not exists conversions_meta_espace_idx on conversions_meta (tenant_id) where tenant_id is not null');
  });

  it('🔴 pas de rattrapage : les numéros et les offres déjà là sont réservés en ignore, par l’admin actif le plus ancien', () => {
    const reprises = instructions.filter((i) => i.startsWith('insert into conversions_meta '));
    expect(reprises).toHaveLength(2);
    const [numero, offre] = reprises as [string, string];
    expect(numero).toContain("select distinct on (u.tenant_id) 'numero:' || u.tenant_id, 'NumeroConnecte', u.identity_id, u.tenant_id, 'ignore', 'anterieur'");
    expect(numero).toContain('select tenant_id from phone_numbers union select tenant_id from comptes_application where relie_le is not null union select tenant_id from credits_offerts');
    expect(offre).toContain("select distinct on (u.tenant_id) 'pro:' || u.tenant_id, 'Subscribe', u.identity_id, u.tenant_id, 'ignore', 'anterieur'");
    expect(offre).toContain('select tenant_id from abonnements_offre');
    for (const r of reprises) {
      // La même personne que la réservation du code (`roleAdminEffectifSql`), et un rejeu qui ne double rien.
      expect(r).toContain("(u.role = 'admin' or offre_de_l_espace(u.tenant_id) = 'pro') and u.disabled_at is null and u.identity_id is not null");
      expect(r).toContain('order by u.tenant_id, u.created_at');
      expect(r).toContain('on conflict on constraint conversions_meta_cle_unique do nothing');
    }
  });
});
