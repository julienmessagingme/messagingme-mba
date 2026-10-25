import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgContactStore } from '../src/crm/contact-store.pg';
import { LimiteOffreError } from '../src/offres/refus';
import type { LimiteContacts } from '../src/offres/offres';

/**
 * LA FREE NE GÈRE JAMAIS PLUS DE CONTACTS QUE SA LIMITE, QUELLE QUE SOIT LEUR ORIGINE (décision de Julien du 2026-10-25,
 * plan `docs/superpowers/plans/2026-10-25-free-100-contacts.md`), sur un faux pool.
 *
 * Le faux compte comme la base compterait D'APRÈS LE PRÉDICAT QUE PORTE LA REQUÊTE : 100 fiches vivantes, dont 40 nées
 * d'un message entrant, donc 60 si la requête exclut `ne_entrant`. Ce que la vraie base fait de ces requêtes est dans
 * `tests/integration/contacts-limite.integration.test.ts`, en CI.
 */
const T = '11111111-1111-4111-8111-111111111111';
const VIVANTES = 100;
const NEES_D_UN_ENTRANT = 40;

/** `offreEnBase` : ce que `offre_de_l_espace` rend, que la porte relit dans sa requête (le cache peut retarder). */
function pool(connus: string[] = [], vivantes = VIVANTES, offreEnBase = 'base') {
  const appels: Array<{ sql: string; params: unknown[] }> = [];
  const compte = (sql: string) => (sql.includes('not x.ne_entrant') ? vivantes - NEES_D_UN_ENTRANT : vivantes);
  const p = {
    query: async (sql: string, params: unknown[] = []) => {
      appels.push({ sql, params });
      if (sql.includes('as connus')) {
        const lot = params[1] as string[];
        const offre = sql.includes('offre_de_l_espace($1::uuid) as offre') ? offreEnBase : undefined;
        return { rows: [{ offre, comptees: compte(sql), connus: lot.filter((w) => connus.includes(w)) }], rowCount: 1 };
      }
      if (sql.includes('as presents')) return { rows: [{ comptees: compte(sql), presents: [] }], rowCount: 1 };
      return { rows: [{ crees: compte(sql), nouveaux: 1 }], rowCount: 1 };
    },
  };
  return { p: p as unknown as Pool, appels };
}

const limite = (l: LimiteContacts | null) => async () => l;

describe('🔴 le compte de la limite dépend de l’offre (`contactsToutesOrigines`)', () => {
  it('Free à 100 fiches dont 40 nées d’un entrant : la 101e création est refusée, et le refus dit ce qui compte', async () => {
    const { p } = pool();
    const store = new PgContactStore(p, undefined, limite({ max: 100, offre: 'base' }));
    const refus = await store.verifierPlaceContacts(T, ['+33600000101']).catch((e: unknown) => e);
    expect(refus).toBeInstanceOf(LimiteOffreError);
    expect((refus as LimiteOffreError).max).toBe(100);
    expect((refus as LimiteOffreError).message).toMatch(/100 contacts, ceux qui vous écrivent compris\. Passez en Pro/);
  });

  it('le Pro dans le même état accepte : ses 40 fiches nées d’un entrant ne comptent pas', async () => {
    const { p } = pool();
    // Une limite basse, pour que seul le prédicat décide : 60 fiches créées sur 100 places.
    await expect(new PgContactStore(p, undefined, limite({ max: 100, offre: 'pro' })).verifierPlaceContacts(T, ['+33600000101'])).resolves.toBeUndefined();
    await expect(new PgContactStore(p, undefined, limite({ max: 5000, offre: 'pro' })).verifierPlaceContacts(T, ['+33600000101'])).resolves.toBeUndefined();
  });

  it('les places que l’import Shopify annonce comptent comme le refus : toutes les fiches en Free, les créées en Pro', async () => {
    const { p } = pool();
    expect(await new PgContactStore(p, undefined, limite({ max: 100, offre: 'base' })).placesContacts(T, ['+33600000101']))
      .toEqual({ limite: 100, comptees: 100, presents: new Set() });
    expect(await new PgContactStore(p, undefined, limite({ max: 5000, offre: 'pro' })).placesContacts(T, ['+33600000101']))
      .toEqual({ limite: 5000, comptees: 60, presents: new Set() });
  });

  it('sans limite, rien n’est lu ni refusé', async () => {
    const { p, appels } = pool();
    await expect(new PgContactStore(p, undefined, limite(null)).verifierPlaceContacts(T, ['+33600000101'])).resolves.toBeUndefined();
    await expect(new PgContactStore(p).verifierPlaceContacts(T, ['+33600000101'])).resolves.toBeUndefined();
    expect(appels).toHaveLength(0);
  });
});

describe('🔴 la porte d’une Free pleine : qui n’y entre pas (`inconnusRefuses`)', () => {
  it('Free pleine : l’inconnu est refusé, le contact connu entre, et la limite voyage avec le refus', async () => {
    const { p, appels } = pool(['33611111111']);
    const r = await new PgContactStore(p, undefined, limite({ max: 100, offre: 'base' })).inconnusRefuses(T, ['33611111111', '33622222222']);
    expect(r).toEqual({ waIds: new Set(['33622222222']), limite: 100 });
    // Une requête, l'espace en $1, les fiches vivantes TOUTES comptées, l'identité lue par numéro ou BSUID.
    expect(appels).toHaveLength(1);
    expect(appels[0]!.params).toEqual([T, ['33611111111', '33622222222']]);
    expect(appels[0]!.sql).toContain('x.tenant_id = $1 and x.deleted_at is null and x.anonymized_at is null');
    expect(appels[0]!.sql).not.toContain('ne_entrant');
    expect(appels[0]!.sql).toContain("x.phone_e164 = '+' || w.wa_id");
    expect(appels[0]!.sql).toContain('x.bsuid = w.wa_id');
  });

  it('une place restante va au premier inconnu du lot, dans l’ordre reçu ; les suivants sont refusés', async () => {
    const { p } = pool([], 99);
    const r = await new PgContactStore(p, undefined, limite({ max: 100, offre: 'base' })).inconnusRefuses(T, ['33622222222', '33633333333', '33622222222']);
    expect(r).toEqual({ waIds: new Set(['33633333333']), limite: 100 });
  });

  it('🔴 l’offre relue en base : un espace que le cache croit en Free, mais qui vient de passer en Pro, ne refuse personne', async () => {
    // Le paiement du Pro ou le début d'un essai n'invalide que le cache de l'API : celui du worker retarde de 30 s.
    for (const offre of ['pro', 'entreprise']) {
      const { p, appels } = pool([], VIVANTES, offre);
      expect(await new PgContactStore(p, undefined, limite({ max: 100, offre: 'base' })).inconnusRefuses(T, ['33622222222']), offre).toBeNull();
      expect(appels, offre).toHaveLength(1);
    }
    // Une offre que le code ne connaît pas se lit comme la Base, comme `offreDe` : la porte refuse.
    expect(await new PgContactStore(pool([], VIVANTES, 'inconnue').p, undefined, limite({ max: 100, offre: 'base' })).inconnusRefuses(T, ['33622222222']))
      .toEqual({ waIds: new Set(['33622222222']), limite: 100 });
  });

  it('sous la limite, ou tous connus : personne n’est refusé', async () => {
    expect(await new PgContactStore(pool([], 42).p, undefined, limite({ max: 100, offre: 'base' })).inconnusRefuses(T, ['33622222222'])).toBeNull();
    expect(await new PgContactStore(pool(['33611111111']).p, undefined, limite({ max: 100, offre: 'base' })).inconnusRefuses(T, ['33611111111'])).toBeNull();
  });

  it('🔴 le Pro plein, l’Entreprise, sans limite ou sans personne : rien n’est refusé ni même lu', async () => {
    const { p, appels } = pool([], 5000);
    expect(await new PgContactStore(p, undefined, limite({ max: 5000, offre: 'pro' })).inconnusRefuses(T, ['33622222222'])).toBeNull();
    expect(await new PgContactStore(p, undefined, limite({ max: 100, offre: 'entreprise' })).inconnusRefuses(T, ['33622222222'])).toBeNull();
    expect(await new PgContactStore(p, undefined, limite(null)).inconnusRefuses(T, ['33622222222'])).toBeNull();
    expect(await new PgContactStore(p).inconnusRefuses(T, ['33622222222'])).toBeNull();
    expect(await new PgContactStore(p, undefined, limite({ max: 100, offre: 'base' })).inconnusRefuses(T, [])).toBeNull();
    expect(appels).toHaveLength(0);
  });
});
