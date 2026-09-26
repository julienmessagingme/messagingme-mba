// tests/contacts-consentement-store.test.ts
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgContactStore } from '../src/crm/contact-store.pg';

/**
 * LE CONSENTEMENT ÉCRIT PAR L'API PUBLIQUE, sur une fiche désignée par son IDENTIFIANT.
 *
 * 🔴 IL N'ÉCRIT QUE SI LE STATUT CHANGE. Un outil qui renvoie `opted_out` à chaque appel ne doit ni repousser
 * la date du désabonnement (elle répond à « depuis quand ? »), ni annoncer dix fois le même refus au connecteur
 * du client, ni écrire une ligne d'audit par appel.
 */
const T = '11111111-1111-4111-8111-111111111111';
const ID = '00000000-0000-4000-8000-000000000001';

function monter(opts: { touche: boolean; existe: boolean; statut?: 'opted_in' | 'opted_out' | 'unknown' }) {
  const evenements: string[] = [];
  const sqls: string[] = [];
  const annonces: string[][] = [];
  const pool = {
    query: async (sql: string) => {
      sqls.push(sql);
      if (/^\s*update contacts set opt_in_status/i.test(sql)) {
        evenements.push('ecriture');
        return opts.touche ? { rows: [{ phone_e164: '+33600000001', bsuid: null }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/select opt_in_status from contacts/i.test(sql)) {
        return opts.existe ? { rows: [{ opt_in_status: opts.statut ?? 'unknown' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const store = new PgContactStore(pool, async (_t, waIds) => { evenements.push('annonce'); annonces.push(waIds); });
  return { store, evenements, sqls, annonces };
}

describe('ecrireConsentementParId', () => {
  it('🔴 un désabonnement qui CHANGE le statut s’écrit PUIS s’annonce', async () => {
    const { store, evenements, annonces } = monter({ touche: true, existe: true });
    expect(await store.ecrireConsentementParId(T, ID, 'opted_out', 'api')).toBe('change');
    expect(evenements).toEqual(['ecriture', 'annonce']);
    expect(annonces).toEqual([['33600000001']]);
  });

  it('⚠️ un statut identique n’écrit rien et n’annonce rien', async () => {
    const { store, evenements } = monter({ touche: false, existe: true });
    expect(await store.ecrireConsentementParId(T, ID, 'opted_out', 'api')).toBe('inchange');
    expect(evenements).toEqual(['ecriture']);
  });

  it('une fiche absente ou supprimée rend « absente »', async () => {
    const { store, sqls } = monter({ touche: false, existe: false });
    expect(await store.ecrireConsentementParId(T, ID, 'opted_in', 'api')).toBe('absente');
    // 🔴 La RELECTURE aussi est filtrée : sans `deleted_at is null`, une fiche purgée rendrait « inchange »,
    // et l'appelant croirait un consentement enregistré.
    expect(sqls[1]).toMatch(/where tenant_id = \$1 and id = \$2 and deleted_at is null/);
  });

  it('un `opted_in` sur une fiche au statut inconnu s’écrit et n’annonce rien : ce n’est pas un refus', async () => {
    const { store, evenements } = monter({ touche: true, existe: true });
    expect(await store.ecrireConsentementParId(T, ID, 'opted_in', 'formulaire-site')).toBe('change');
    expect(evenements).toEqual(['ecriture']);
  });

  /**
   * 🔴 UN STOP NE SE LÈVE PAS PAR MACHINE (décision de Julien du 2026-09-24) : la garde est DANS la requête,
   * pas seulement dans le service, pour tenir une écriture concurrente. La relecture dit pourquoi rien n'a bougé.
   */
  it('🔴 un `opted_in` sur une fiche `opted_out` rend « refuse » et n’écrit rien', async () => {
    const { store, evenements, sqls } = monter({ touche: false, existe: true, statut: 'opted_out' });
    expect(await store.ecrireConsentementParId(T, ID, 'opted_in', 'formulaire-site')).toBe('refuse');
    expect(evenements).toEqual(['ecriture']);
    expect(sqls[0]).toMatch(/and not \(\$3 = 'opted_in' and opt_in_status = 'opted_out'\)/);
  });

  it('🔴 la requête ne touche la ligne QUE si le statut change, dans l’espace, sur une fiche active', async () => {
    const { store, sqls } = monter({ touche: true, existe: true });
    await store.ecrireConsentementParId(T, ID, 'opted_out', 'api');
    expect(sqls[0]).toMatch(/where tenant_id = \$1 and id = \$2 and deleted_at is null and opt_in_status is distinct from \$3/);
    expect(sqls[0]).toMatch(/opt_out_at = case when \$3 = 'opted_out' then now\(\) else null end/);
  });
});

/**
 * 🔴 UN STOP NE SE LÈVE PAS PAR UPSERT (2026-09-26). Les deux upserts servent l'import HubSpot, l'import CSV, le
 * webhook entrant et la création à la main : un `opted_in` y réabonnait quelqu'un qui avait dit STOP, et
 * effaçait la source et la date de son refus. Seul l'import CSV case cochée le peut encore (décision de Julien
 * du 2026-09-26), et il le dit par `peutLeverStop`.
 *
 * ⚠️ Ces tests lisent le SQL ENVOYÉ : ils prouvent que la garde part, pas qu'elle est juste. Sa sémantique est
 * tenue par `tests/integration/stores.integration.test.ts`, sur une vraie base, en CI.
 */
describe('les upserts ne lèvent pas un STOP', () => {
  function capturer() {
    const appels: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        appels.push({ sql: sql.replace(/\s+/g, ' '), params });
        return { rows: [{ id: ID, created: false, phone_e164: '+33600000001' }], rowCount: 1 };
      },
    } as unknown as Pool;
    return { store: new PgContactStore(pool), appels };
  }
  /** L'expression affectée à une colonne dans le `do update set`, entre `case` et son `end`. */
  const affectation = (sql: string, colonne: string): string => sql.match(new RegExp(` ${colonne} = case (.*?) end`))?.[1] ?? '';

  it('🔴 l’upsert unitaire (webhook entrant, création à la main) garde le statut, la date ET la source d’un STOP', async () => {
    const { store, appels } = capturer();
    await store.upsertByPhoneReturningId({ tenantId: T, phoneE164: '+33600000001', profileName: null, fields: {}, optInStatus: 'opted_in', optInSource: 'webhook:crm' });
    const sql = appels[0]!.sql;
    expect(affectation(sql, 'opt_in_status')).toMatch(/and contacts\.opt_in_status <> 'opted_out' then 'opted_in'/);
    expect(affectation(sql, 'opt_out_at')).toMatch(/and contacts\.opt_in_status <> 'opted_out' then null/);
    // La source dit le canal du STOP au signal (`completerSignal`) : l'écraser ferait mentir l'outil du client.
    expect(affectation(sql, 'opt_in_source')).toMatch(/when contacts\.opt_in_status = 'opted_out' then contacts\.opt_in_source/);
  });

  it('🔴 l’upsert en lot ne lève un STOP que si le lot le dit (`peutLeverStop`, l’import CSV case cochée)', async () => {
    const { store, appels } = capturer();
    const lot = { tenantId: T, optInStatus: 'opted_in' as const, optInSource: 'hubspot_list', contacts: [{ phoneE164: '+33600000001', profileName: null, fields: {} }] };
    await store.upsertManyByPhone(lot);
    await store.upsertManyByPhone({ ...lot, optInSource: 'csv_import', peutLeverStop: true });
    const [hubspot, csv] = appels;
    expect(affectation(hubspot!.sql, 'opt_in_status')).toMatch(/and \(contacts\.opt_in_status <> 'opted_out' or \$6::boolean\) then 'opted_in'/);
    expect(affectation(hubspot!.sql, 'opt_out_at')).toMatch(/and \(contacts\.opt_in_status <> 'opted_out' or \$6::boolean\) then null/);
    expect(affectation(hubspot!.sql, 'opt_in_source')).toMatch(/when contacts\.opt_in_status = 'opted_out' and not \$6::boolean then contacts\.opt_in_source/);
    // $6 : absent vaut NON, c'est le défaut sûr (un appelant qui l'oublie garde le STOP).
    expect(hubspot!.params[5]).toBe(false);
    expect(csv!.params[5]).toBe(true);
  });
});
