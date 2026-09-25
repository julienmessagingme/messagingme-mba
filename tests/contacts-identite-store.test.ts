// tests/contacts-identite-store.test.ts
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgContactStore } from '../src/crm/contact-store.pg';

/**
 * LES MÉTHODES D'IDENTITÉ DU DÉPÔT (API publique, lot 1), sur un faux pool.
 *
 * Ce qui se vérifie ici sans base : la FORME des requêtes (l'espace en $1, les fiches supprimées exclues,
 * l'index visé par chaque `on conflict`) et la traduction des refus de la base (`23505` -> « conflit », jamais
 * une 500 que Cloudflare remplacerait par sa page). Ce que la base fait vraiment de ces requêtes est dans
 * `tests/integration/contacts-identite.integration.test.ts`, en CI.
 */
const T = '11111111-1111-4111-8111-111111111111';
const ID = '00000000-0000-4000-8000-000000000001';

function pool(reponse: (sql: string) => { rows: unknown[]; rowCount: number } | Error) {
  const appels: Array<{ sql: string; params: unknown[] }> = [];
  const p = {
    query: async (sql: string, params: unknown[] = []) => {
      appels.push({ sql, params });
      const r = reponse(sql);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { p: p as unknown as Pool, appels };
}
const unicite = (): Error => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

describe('chercherParCles', () => {
  it('sans aucune clé, ne va même pas en base', async () => {
    const { p, appels } = pool(() => ({ rows: [], rowCount: 0 }));
    expect(await new PgContactStore(p).chercherParCles(T, {})).toEqual([]);
    expect(appels).toHaveLength(0);
  });

  it('🔴 l’espace est en $1, les fiches supprimées sont exclues, et chaque clé a son paramètre', async () => {
    const { p, appels } = pool(() => ({ rows: [{ id: ID, external_id: 'crm-7781', phone_e164: '+33612345678', bsuid: null }], rowCount: 1 }));
    const r = await new PgContactStore(p).chercherParCles(T, { externalId: 'crm-7781', phoneE164: '+33612345678' });
    expect(r).toEqual([{ id: ID, externalId: 'crm-7781', phoneE164: '+33612345678', bsuid: null }]);
    expect(appels[0]!.sql).toMatch(/where tenant_id = \$1 and deleted_at is null/);
    expect(appels[0]!.params).toEqual([T, null, 'crm-7781', '+33612345678', null]);
  });

  it('⚠️ une clé VIDE vaut absence dans les paramètres comme dans la garde : jamais une chaîne vide envoyée à la base', async () => {
    const { p, appels } = pool(() => ({ rows: [], rowCount: 0 }));
    const s = new PgContactStore(p);
    expect(await s.chercherParCles(T, { contactId: '', externalId: '', phoneE164: '', bsuid: '' })).toEqual([]);
    expect(appels).toHaveLength(0);
    await s.chercherParCles(T, { contactId: '', externalId: '', phoneE164: '+33612345678', bsuid: '' });
    // Un `contactId` vide jusqu'au cast `::uuid` lèverait 22P02, donc une 500.
    expect(appels[0]!.params).toEqual([T, null, null, '+33612345678', null]);
  });
});

describe('creerFicheApi', () => {
  it('par numéro, le conflit vise l’index du NUMÉRO ; sans numéro, celui du BSUID', async () => {
    const { p, appels } = pool(() => ({ rows: [{ id: ID, created: true, external_id: null, phone_e164: '+33612345678', bsuid: null }], rowCount: 1 }));
    const s = new PgContactStore(p);
    await s.creerFicheApi(T, { phoneE164: '+33612345678' });
    await s.creerFicheApi(T, { bsuid: 'BSUID-1' });
    expect(appels[0]!.sql).toMatch(/on conflict \(tenant_id, phone_e164\) where phone_e164 is not null/);
    expect(appels[1]!.sql).toMatch(/on conflict \(tenant_id, bsuid\) where bsuid is not null/);
  });

  it('🔴 la fiche retrouvée par l’index n’est touchée (ni ressuscitée) que si ses autres clés TIENNENT ; sinon « conflit »', async () => {
    const { p, appels } = pool(() => ({ rows: [], rowCount: 0 }));
    // Aucune ligne rendue : le `where` du `do update` a refusé, rien n'a été écrit.
    expect(await new PgContactStore(p).creerFicheApi(T, { phoneE164: '+33612345678', externalId: 'crm-7781', bsuid: 'B' })).toBe('conflit');
    expect(appels[0]!.sql).toMatch(/do update set[\s\S]*deleted_at = null[\s\S]*where \(contacts\.external_id is null or excluded\.external_id is null or contacts\.external_id = excluded\.external_id\)\s+and \(contacts\.bsuid is null or excluded\.bsuid is null or contacts\.bsuid = excluded\.bsuid\)\s+returning/);
  });

  it('⚠️ un numéro VIDE vaut absence : l’index visé est celui du BSUID, et aucun numéro vide n’est inséré', async () => {
    const { p, appels } = pool(() => ({ rows: [{ id: ID, created: true, external_id: null, phone_e164: null, bsuid: 'B' }], rowCount: 1 }));
    await new PgContactStore(p).creerFicheApi(T, { phoneE164: '', bsuid: 'B', externalId: '' });
    expect(appels[0]!.sql).toMatch(/on conflict \(tenant_id, bsuid\) where bsuid is not null/);
    expect(appels[0]!.params).toEqual([T, null, 'B', null]);
  });

  it('🔴 une violation d’unicité (identifiant externe ou BSUID pris par une autre fiche) rend « conflit »', async () => {
    const { p } = pool(() => unicite());
    expect(await new PgContactStore(p).creerFicheApi(T, { phoneE164: '+33612345678', externalId: 'crm-7781' })).toBe('conflit');
  });

  it('une autre panne remonte telle quelle', async () => {
    const { p } = pool(() => new Error('connexion perdue'));
    await expect(new PgContactStore(p).creerFicheApi(T, { phoneE164: '+33612345678' })).rejects.toThrow('connexion perdue');
  });

  it('refuse d’être appelée sans numéro ni BSUID : la base exige l’un des deux', async () => {
    const { p } = pool(() => ({ rows: [], rowCount: 0 }));
    await expect(new PgContactStore(p).creerFicheApi(T, { externalId: 'crm-7781' })).rejects.toThrow(/numéro ou un BSUID/);
  });
});

describe('rattacherCles', () => {
  it('🔴 une clé que la fiche porte déjà AUTREMENT rend « conflit » : on rattache, on ne remplace pas', async () => {
    const { p } = pool(() => ({ rows: [{ external_id: 'crm-autre', phone_e164: '+33612345678', bsuid: null }], rowCount: 1 }));
    expect(await new PgContactStore(p).rattacherCles(T, ID, { externalId: 'crm-7781' })).toBe('conflit');
  });

  it('🔴 TOUT OU RIEN : chaque clé demandée est gardée DANS le `where`, et une fiche existante non touchée est un « conflit »', async () => {
    // La mise à jour ne touche rien (une clé portée autrement), la relecture dit que la fiche existe.
    const { p, appels } = pool((sql) => (/^select 1 from contacts/.test(sql) ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 }));
    expect(await new PgContactStore(p).rattacherCles(T, ID, { externalId: 'crm-7781', bsuid: 'B' })).toBe('conflit');
    expect(appels[0]!.sql).toMatch(/where tenant_id = \$1 and id = \$2 and deleted_at is null\s+and \(\$3::text is null or external_id is null or external_id = \$3\)\s+and \(\$4::text is null or phone_e164 is null or phone_e164 = \$4\)\s+and \(\$5::text is null or bsuid is null or bsuid = \$5\)/);
    expect(appels[1]!.sql).toMatch(/where tenant_id = \$1 and id = \$2 and deleted_at is null/);
    expect(appels[1]!.params).toEqual([T, ID]);
  });

  it('⚠️ une clé VIDE vaut absence : ni envoyée à la base, ni exigée au retour', async () => {
    const { p, appels } = pool(() => ({ rows: [{ external_id: null, phone_e164: '+33612345678', bsuid: 'B' }], rowCount: 1 }));
    expect(await new PgContactStore(p).rattacherCles(T, ID, { externalId: '', phoneE164: '', bsuid: 'B' })).toBe('ok');
    expect(appels[0]!.params).toEqual([T, ID, null, null, 'B']);
  });

  it('clé posée : « ok » ; fiche disparue : « absente » ; unicité violée : « conflit »', async () => {
    const pose = pool(() => ({ rows: [{ external_id: 'crm-7781', phone_e164: null, bsuid: 'B' }], rowCount: 1 }));
    expect(await new PgContactStore(pose.p).rattacherCles(T, ID, { externalId: 'crm-7781' })).toBe('ok');
    expect(pose.appels[0]!.sql).toMatch(/where tenant_id = \$1 and id = \$2 and deleted_at is null/);
    expect(await new PgContactStore(pool(() => ({ rows: [], rowCount: 0 })).p).rattacherCles(T, ID, { externalId: 'crm-7781' })).toBe('absente');
    expect(await new PgContactStore(pool(() => unicite()).p).rattacherCles(T, ID, { externalId: 'crm-7781' })).toBe('conflit');
  });
});

describe('poserExternalId', () => {
  it('remplace ; fiche absente : « absente » ; déjà porté ailleurs : « conflit »', async () => {
    const pose = pool(() => ({ rows: [], rowCount: 1 }));
    expect(await new PgContactStore(pose.p).poserExternalId(T, ID, 'crm-9')).toBe('ok');
    // Dans l'espace, et jamais sur une fiche supprimée : une fiche purgée ne regagne pas d'identifiant.
    expect(pose.appels[0]!.sql).toMatch(/where tenant_id = \$1 and id = \$2 and deleted_at is null/);
    expect(pose.appels[0]!.params).toEqual([T, ID, 'crm-9']);
    expect(await new PgContactStore(pool(() => ({ rows: [], rowCount: 0 })).p).poserExternalId(T, ID, 'crm-9')).toBe('absente');
    expect(await new PgContactStore(pool(() => unicite()).p).poserExternalId(T, ID, 'crm-9')).toBe('conflit');
  });
});

describe('editerFicheApi', () => {
  it('🔴 UNE requête, dans l’espace, sur une fiche ACTIVE : pas de transaction ni de client dédié par élément', async () => {
    const { p, appels } = pool(() => ({ rows: [], rowCount: 1 }));
    const e = { fields: { ville: 'Lyon' }, removeFields: ['age'], addTags: ['vip'], removeTags: ['froid'], profileName: 'Camille' };
    expect(await new PgContactStore(p).editerFicheApi(T, ID, e)).toBe(true);
    expect(appels).toHaveLength(1);
    expect(appels[0]!.sql).toMatch(/where tenant_id = \$1 and id = \$2 and deleted_at is null/);
    expect(appels[0]!.params).toEqual([T, ID, '{"ville":"Lyon"}', ['age'], ['vip'], ['froid'], true, 'Camille']);
  });

  it('🔴 fiche absente, supprimée ou purgée entre la résolution et l’écriture : `false`, et rien n’est réécrit', async () => {
    const { p, appels } = pool(() => ({ rows: [], rowCount: 0 }));
    expect(await new PgContactStore(p).editerFicheApi(T, ID, { fields: {}, removeFields: [], addTags: ['a'], removeTags: [] })).toBe(false);
    // Nom non fourni : le drapeau dit « on n'y touche pas », la valeur est nulle et n'est pas lue.
    expect(appels[0]!.params.slice(6)).toEqual([false, null]);
  });
});

describe('lireFicheApi', () => {
  it('🔴 exclut les fiches supprimées et rend les dates en ISO', async () => {
    const { p, appels } = pool(() => ({
      rows: [{
        id: ID, external_id: 'crm-7781', phone_e164: '+33612345678', bsuid: null, profile_name: 'Camille Roy',
        fields: { ville: 'Lyon' }, tags: ['prospect'], opt_in_status: 'opted_out', opt_in_source: 'api',
        opt_out_at: new Date('2026-09-24T10:00:00.000Z'), rcs_optout_at: null, blocked_at: null,
        whatsapp_joignable: null, whatsapp_joignable_le: null, created_at: new Date('2026-09-01T00:00:00.000Z'),
      }],
      rowCount: 1,
    }));
    const f = await new PgContactStore(p).lireFicheApi(T, ID);
    expect(appels[0]!.sql).toMatch(/where tenant_id = \$1 and id = \$2 and deleted_at is null/);
    expect(f).toMatchObject({ id: ID, externalId: 'crm-7781', optInStatus: 'opted_out', optOutAt: '2026-09-24T10:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', blockedAt: null });
    // Jamais calculé : rien d'inventé.
    expect(f).toMatchObject({ risqueNiveau: null, risqueScore: null, risqueRaisons: [], risqueCalculeLe: null });
  });

  it('lit le risque de désengagement (migration 0178), date en ISO', async () => {
    const { p, appels } = pool(() => ({
      rows: [{
        id: ID, external_id: null, phone_e164: '+33612345678', bsuid: null, profile_name: null, fields: {}, tags: [],
        opt_in_status: 'opted_in', opt_in_source: null, opt_out_at: null, rcs_optout_at: null, blocked_at: null,
        whatsapp_joignable: null, whatsapp_joignable_le: null, created_at: new Date('2026-09-01T00:00:00.000Z'),
        risque_niveau: 'moyen', risque_score: 40, risque_raisons: ['silence_60j'], risque_calcule_le: new Date('2026-09-25T03:05:00.000Z'),
      }],
      rowCount: 1,
    }));
    const f = await new PgContactStore(p).lireFicheApi(T, ID);
    expect(appels[0]!.sql).toMatch(/risque_niveau, risque_score, risque_raisons, risque_calcule_le/);
    expect(f).toMatchObject({ risqueNiveau: 'moyen', risqueScore: 40, risqueRaisons: ['silence_60j'], risqueCalculeLe: '2026-09-25T03:05:00.000Z' });
  });
});

describe('ContactRow porte l’identifiant externe', () => {
  it('lu par getById ; absent de la ligne, il vaut null et non undefined', async () => {
    const ligne = {
      id: ID, phone_e164: '+33612345678', bsuid: null, profile_name: null, opt_in_status: 'unknown', fields: {},
      tags: [], created_at: new Date('2026-09-01T00:00:00.000Z'), blocked_at: null, whatsapp_joignable: null, whatsapp_joignable_le: null,
    };
    const avec = await new PgContactStore(pool(() => ({ rows: [{ ...ligne, external_id: 'crm-7781' }], rowCount: 1 })).p).getById(T, ID);
    expect(avec?.externalId).toBe('crm-7781');
    const sans = await new PgContactStore(pool(() => ({ rows: [ligne], rowCount: 1 })).p).getById(T, ID);
    expect(sans?.externalId).toBeNull();
  });
});

describe('la purge', () => {
  it('🔴 efface l’identifiant externe avec le numéro et le nom', async () => {
    const sqls: string[] = [];
    const client = { query: async (sql: string) => { sqls.push(sql); return { rows: [], rowCount: 0 }; }, release: () => {} };
    const store = new PgContactStore({ connect: async () => client } as unknown as Pool);
    await store.purgeMany(T, [ID]);
    const anonymisation = sqls.find((s) => /anonymized_at = now\(\)/.test(s));
    expect(anonymisation, 'la requête d’anonymisation').toBeDefined();
    expect(anonymisation).toMatch(/external_id = null/);
  });
});
