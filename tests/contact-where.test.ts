import { describe, it, expect } from 'vitest';
import { buildContactWhere, buildBulkSelector } from '../src/crm/contact-store.pg';
import { PEREMPTION_WHATSAPP_MS } from '../src/contacts/joignabilite';

// Fonctions PURES (aucune DB) : on vérifie le SQL + les params générés. C'est le GATE testable de la boucle
// mini-CRM (les nouveaux opérateurs de filtre + le sélecteur d'action en masse), sans toucher Postgres.

describe('buildContactWhere — base', () => {
  it('inclut TOUJOURS tenant_id = $1 ET deleted_at is null (anti-fuite + soft-delete)', () => {
    const { where, params } = buildContactWhere('t1', {});
    expect(where).toBe('tenant_id = $1 and deleted_at is null');
    expect(params).toEqual(['t1']);
  });
});

describe('buildContactWhere — opérateurs de champ', () => {
  it('empty : posé MÊME sans valeur (n\'est pas sauté), placeholder clé réutilisé (1 seul param)', () => {
    const { where, params } = buildContactWhere('t1', { fieldFilters: [{ key: 'email', op: 'empty', value: '' }] });
    expect(where).toContain("(fields ->> $2 is null or fields ->> $2 = '')");
    expect(params).toEqual(['t1', 'email']); // la clé est PARAMÉTRÉE, pas interpolée
  });

  it('not_empty : posé sans valeur', () => {
    const { where, params } = buildContactWhere('t1', { fieldFilters: [{ key: 'email', op: 'not_empty', value: '' }] });
    expect(where).toContain("(fields ->> $2 is not null and fields ->> $2 <> '')");
    expect(params).toEqual(['t1', 'email']);
  });

  it('not_contains : négation du ilike, clé + valeur paramétrées', () => {
    const { where, params } = buildContactWhere('t1', { fieldFilters: [{ key: 'ville', op: 'not_contains', value: 'paris' }] });
    expect(where).toContain("coalesce(fields ->> $2, '') not ilike '%' || $3 || '%'");
    expect(params).toEqual(['t1', 'ville', 'paris']);
  });

  it('contains : ilike positif', () => {
    const { where, params } = buildContactWhere('t1', { fieldFilters: [{ key: 'ville', op: 'contains', value: 'lyon' }] });
    expect(where).toContain("coalesce(fields ->> $2, '') ilike '%' || $3 || '%'");
    expect(params).toEqual(['t1', 'ville', 'lyon']);
  });

  it('eq : égalité stricte', () => {
    const { where, params } = buildContactWhere('t1', { fieldFilters: [{ key: 'segment', op: 'eq', value: 'vip' }] });
    expect(where).toContain('fields ->> $2 = $3');
    expect(params).toEqual(['t1', 'segment', 'vip']);
  });

  it('eq/contains/not_contains SANS valeur -> filtre non posé (sauté)', () => {
    for (const op of ['eq', 'contains', 'not_contains'] as const) {
      const { where, params } = buildContactWhere('t1', { fieldFilters: [{ key: 'x', op, value: '' }] });
      expect(where).toBe('tenant_id = $1 and deleted_at is null');
      expect(params).toEqual(['t1']);
    }
  });

  it('clé vide -> ignorée', () => {
    const { where } = buildContactWhere('t1', { fieldFilters: [{ key: '  ', op: 'not_empty', value: '' }] });
    expect(where).toBe('tenant_id = $1 and deleted_at is null');
  });

  it('la clé n\'est JAMAIS interpolée dans le SQL (injection)', () => {
    const evil = "x'); drop table contacts; --";
    const { where, params } = buildContactWhere('t1', { fieldFilters: [{ key: evil, op: 'not_empty', value: '' }] });
    expect(where).not.toContain('drop table');
    expect(params).toContain(evil); // la clé malveillante finit en paramètre, inoffensive
  });
});

describe('buildContactWhere — tags', () => {
  it('tagsExclude : « ne possède pas » -> not (tags && $)', () => {
    const { where, params } = buildContactWhere('t1', { tagsExclude: ['spam', 'junk'] });
    expect(where).toContain('not (tags && $2::text[])');
    expect(params).toEqual(['t1', ['spam', 'junk']]);
  });

  it('tags (@>) + tagsExclude cohabitent (2 clauses distinctes)', () => {
    const { where, params } = buildContactWhere('t1', { tags: ['vip'], tagsExclude: ['spam'] });
    expect(where).toContain('tags @> $2::text[]');
    expect(where).toContain('not (tags && $3::text[])');
    expect(params).toEqual(['t1', ['vip'], ['spam']]);
  });

  it('tagMode or -> && ; défaut -> @>', () => {
    expect(buildContactWhere('t1', { tags: ['a'], tagMode: 'or' }).where).toContain('tags && $2::text[]');
    expect(buildContactWhere('t1', { tags: ['a'] }).where).toContain('tags @> $2::text[]');
  });
});

describe('buildBulkSelector', () => {
  it('par ids : dédup + scope tenant + actif', () => {
    const { where, params } = buildBulkSelector('t1', { ids: ['a', 'b', 'a'] });
    expect(where).toBe('tenant_id = $1 and deleted_at is null and id = any($2::uuid[])');
    expect(params).toEqual(['t1', ['a', 'b']]);
  });

  it('ids vide -> where « false » (jamais un UPDATE global)', () => {
    const { where, params } = buildBulkSelector('t1', { ids: [] });
    expect(where).toBe('false');
    expect(params).toEqual([]);
  });

  it('par filtres SANS exclusion : identique à buildContactWhere', () => {
    const sel = buildBulkSelector('t1', { filters: { tags: ['vip'] } });
    const base = buildContactWhere('t1', { tags: ['vip'] });
    expect(sel).toEqual(base);
    expect(sel.where).toContain('deleted_at is null');
  });

  it('par filtres AVEC exclusion : ajoute un not (id = any($N))', () => {
    const { where, params } = buildBulkSelector('t1', { filters: { tags: ['vip'] }, excludeIds: ['x', 'y'] });
    expect(where).toContain('deleted_at is null');
    expect(where).toContain('and not (id = any($3::uuid[]))');
    expect(params).toEqual(['t1', ['vip'], ['x', 'y']]);
  });
});

/**
 * LE FILTRE DE JOIGNABILITÉ (migration 0133).
 *
 * 🔴 IL EXCLUT LES INJOIGNABLES **CONNUS**, JAMAIS LES INCONNUS. C'est la transposition en SQL du même
 * piège que `verdictWhatsApp` ferme côté code : traiter `null` comme `false` ferait sortir de l'audience
 * tout le parc jamais sollicité, c'est-à-dire la quasi-totalité des contacts d'un client qui démarre.
 * `is not false` laisse passer `null` ; `is not true` l'exclurait, et rien ne le signalerait.
 */
describe('buildContactWhere — joignabilité WhatsApp', () => {
  it('le filtre exclut les injoignables CONNUS, jamais les inconnus', () => {
    const { where } = buildContactWhere('t1', { joignabiliteWhatsApp: 'connu_injoignable' });
    expect(where).toContain('whatsapp_joignable is not false');
    // ⚠️ LA CLAUSE ENTIÈRE, PAS UN MORCEAU. Un `toContain` sur le seul premier terme laisse passer une
    // altération des deux autres : la clause est un OU à trois branches, et chacune garde une population
    // différente. Un sous-ensemble d'assertions sur un OU ne contraint presque rien.
    expect(where).toContain(
      "(whatsapp_joignable is not false or whatsapp_joignable_le is null"
      + " or whatsapp_joignable_le < now() - ($2::bigint * interval '1 millisecond'))",
    );
  });

  it('une mesure PÉRIMÉE laisse repasser le contact : le SQL dit la même chose que verdictWhatsApp', () => {
    const { where, params } = buildContactWhere('t1', { joignabiliteWhatsApp: 'connu_injoignable' });
    // 🔴 La péremption n'est pas un détail d'affichage : sans elle, le filtre exclurait pour toujours sur un
    // constat vieux de deux ans, alors que la fiche contact du même contact afficherait « Jamais testé ».
    expect(where).toContain('whatsapp_joignable_le is null');
    expect(where).toContain('whatsapp_joignable_le <');
    // Le seuil est PARAMÉTRÉ depuis la constante, jamais écrit « 90 days » en SQL : deux endroits qui portent
    // le même nombre, c'est un endroit qui finira par mentir.
    expect(params).toEqual(['t1', PEREMPTION_WHATSAPP_MS]);
  });

  it('absent -> aucune clause : le filtre ne s\'invite pas dans les requêtes qui ne le demandent pas', () => {
    expect(buildContactWhere('t1', {}).where).not.toContain('whatsapp_joignable');
  });
});
