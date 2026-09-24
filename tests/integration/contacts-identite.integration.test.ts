// tests/integration/contacts-identite.integration.test.ts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';
import { resoudreFiche } from '../../src/api/fiche';
import { creerServiceContactsV1 } from '../../src/api/contacts-v1';
import { PgUserFieldStore } from '../../src/crm/field-store.pg';

/**
 * L'IDENTITÉ D'UNE FICHE CONTRE UNE VRAIE BASE (API publique, lot 1). Espaces jetables, créés et détruits ici.
 *
 * Ce qu'un faux ne peut pas dire : que l'index partiel existe et est VALIDE, que l'unicité est bien PAR
 * ESPACE, que `coalesce` ne remplace jamais une clé portée, et qu'une fiche supprimée disparaît des lectures.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('identité des fiches : external_id et les clés de l’API publique', () => {
  let pool: Pool;
  let store: PgContactStore;
  let tenantId = '';
  let autreTenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgContactStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-identite') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-identite-voisin') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  const creer = async (t: string, cles: { phoneE164?: string; bsuid?: string; externalId?: string }) => {
    const c = await store.creerFicheApi(t, cles);
    if (c === 'conflit') throw new Error(`création refusée : ${JSON.stringify(cles)}`);
    return c;
  };

  /**
   * `updated_at` d'une fiche, en TEXTE (à la microseconde, qu'une `Date` JavaScript arrondirait) : c'est ce qui
   * prouve qu'une écriture refusée n'a RIEN touché, au lieu de seulement retrouver l'état de départ.
   */
  const majLe = async (id: string): Promise<string> =>
    (await pool.query<{ u: string }>('select updated_at::text as u from contacts where tenant_id = $1 and id = $2', [tenantId, id])).rows[0]!.u;

  it('🔴 l’index d’external_id existe, est VALIDE, et porte son prédicat partiel', async () => {
    const def = await pool.query<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = 'contacts_tenant_external_id_uidx'`);
    // Parmi les fiches ACTIVES (revue finale du 2026-09-24). La forme est celle que Postgres rend, relue en
    // production juste après `migrate` : les deux conditions parenthésées sous un AND.
    expect(def.rows[0]?.indexdef).toMatch(/UNIQUE INDEX .* \(tenant_id, external_id\) WHERE \(\(external_id IS NOT NULL\) AND \(deleted_at IS NULL\)\)/);
    const valide = await pool.query<{ indisvalid: boolean }>(`select indisvalid from pg_index where indexrelid = 'contacts_tenant_external_id_uidx'::regclass`);
    expect(valide.rows[0]?.indisvalid).toBe(true);
  });

  it('une fiche créée par numéro se retrouve par CHACUNE de ses clés, et seulement dans son espace', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000701', externalId: 'itest-ext-701' });
    expect(c.created).toBe(true);
    for (const cles of [{ contactId: c.id }, { externalId: 'itest-ext-701' }, { phoneE164: '+33600000701' }]) {
      expect((await store.chercherParCles(tenantId, cles)).map((f) => f.id)).toEqual([c.id]);
    }
    expect(await store.chercherParCles(autreTenantId, { externalId: 'itest-ext-701' })).toEqual([]);
    expect((await store.findByPhone(tenantId, '+33600000701'))?.externalId).toBe('itest-ext-701');
  });

  it('🔴 un identifiant externe est unique PAR ESPACE', async () => {
    await creer(tenantId, { phoneE164: '+33600000702', externalId: 'itest-ext-702' });
    expect(await store.creerFicheApi(tenantId, { phoneE164: '+33600000703', externalId: 'itest-ext-702' })).toBe('conflit');
    const ailleurs = await creer(autreTenantId, { phoneE164: '+33600000702', externalId: 'itest-ext-702' });
    expect(ailleurs.created).toBe(true);
  });

  it('rattacherCles pose une clé manquante et ne REMPLACE jamais une clé portée', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000704' });
    expect(await store.rattacherCles(tenantId, c.id, { externalId: 'itest-ext-704' })).toBe('ok');
    expect(await store.rattacherCles(tenantId, c.id, { externalId: 'itest-ext-autre' })).toBe('conflit');
    expect((await store.lireFicheApi(tenantId, c.id))?.externalId).toBe('itest-ext-704');
  });

  it('🔴 rattacherCles est TOUT OU RIEN : une clé portée autrement, et l’AUTRE clé demandée n’est pas posée', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000715', externalId: 'itest-ext-715' });
    const avant = await majLe(c.id);
    expect(await store.rattacherCles(tenantId, c.id, { externalId: 'itest-ext-715-autre', bsuid: 'itest-bsuid-715' })).toBe('conflit');
    expect(await store.lireFicheApi(tenantId, c.id)).toMatchObject({ externalId: 'itest-ext-715', bsuid: null });
    expect(await majLe(c.id)).toBe(avant);
    // Et une fiche SUPPRIMÉE n'est pas un conflit : elle est absente.
    await pool.query('update contacts set deleted_at = now() where tenant_id = $1 and id = $2', [tenantId, c.id]);
    expect(await store.rattacherCles(tenantId, c.id, { bsuid: 'itest-bsuid-715' })).toBe('absente');
  });

  it('🔴 creerFicheApi ne touche PAS la fiche du numéro qui porte une autre clé : « conflit », sans rien écrire', async () => {
    const vivante = await creer(tenantId, { phoneE164: '+33600000716', externalId: 'itest-ext-716' });
    const avant = await majLe(vivante.id);
    expect(await store.creerFicheApi(tenantId, { phoneE164: '+33600000716', externalId: 'itest-ext-716-autre', bsuid: 'itest-bsuid-716' })).toBe('conflit');
    expect(await store.lireFicheApi(tenantId, vivante.id)).toMatchObject({ externalId: 'itest-ext-716', bsuid: null });
    expect(await majLe(vivante.id)).toBe(avant);

    // Une fiche SUPPRIMÉE qui porte un autre identifiant externe n'est pas ressuscitée, ni par le dépôt, ni par
    // la résolution (qui répond `identity_conflict`).
    const supprimee = await creer(tenantId, { phoneE164: '+33600000717', externalId: 'itest-ext-717' });
    await pool.query('update contacts set deleted_at = now() where tenant_id = $1 and id = $2', [tenantId, supprimee.id]);
    expect(await store.creerFicheApi(tenantId, { phoneE164: '+33600000717', externalId: 'itest-ext-717-autre' })).toBe('conflit');
    expect(await resoudreFiche(store, tenantId, { phone: '+33600000717', externalId: 'itest-ext-717-autre' }, { creer: 'phone_ou_bsuid' }))
      .toEqual({ ok: false, code: 'identity_conflict' });
    const brute = await pool.query<{ deleted_at: Date | null; external_id: string | null }>(
      'select deleted_at, external_id from contacts where tenant_id = $1 and id = $2', [tenantId, supprimee.id],
    );
    expect(brute.rows[0]?.deleted_at).not.toBeNull();
    expect(brute.rows[0]?.external_id).toBe('itest-ext-717');
  });

  it('🔴 le numéro d’une fiche supprimée (sans autre clé) la RESSUSCITE : même id, `created` à faux, `deleted_at` remis à null', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000718' });
    await pool.query('update contacts set deleted_at = now() where tenant_id = $1 and id = $2', [tenantId, c.id]);
    const reprise = await creer(tenantId, { phoneE164: '+33600000718', externalId: 'itest-ext-718' });
    expect(reprise).toMatchObject({ id: c.id, created: false, externalId: 'itest-ext-718' });
    const brute = await pool.query<{ deleted_at: Date | null }>('select deleted_at from contacts where tenant_id = $1 and id = $2', [tenantId, c.id]);
    expect(brute.rows[0]?.deleted_at).toBeNull();
  });

  /**
   * 🔴 L'INDEX DE L'IDENTIFIANT EXTERNE NE COMPTE QUE LES FICHES ACTIVES (0172, revue finale du 2026-09-24) :
   * une fiche supprimée ne le retient plus, et la ressusciter alors qu'une fiche active l'a repris viole
   * l'index, que le dépôt rend en « conflit ». C'est ici que la vraie base le prouve, pas le répertoire en
   * mémoire.
   */
  it('🔴 une fiche SUPPRIMÉE libère son identifiant externe, et ne se ressuscite pas s’il a été repris', async () => {
    const ancienne = await creer(tenantId, { phoneE164: '+33600000723', externalId: 'itest-ext-723' });
    await pool.query('update contacts set deleted_at = now() where tenant_id = $1 and id = $2', [tenantId, ancienne.id]);
    const nouvelle = await creer(tenantId, { phoneE164: '+33600000724', externalId: 'itest-ext-723' });
    expect(nouvelle).toMatchObject({ created: true, externalId: 'itest-ext-723' });
    expect(nouvelle.id).not.toBe(ancienne.id);
    expect(await store.creerFicheApi(tenantId, { phoneE164: '+33600000723' })).toBe('conflit');
    const brute = await pool.query<{ deleted_at: Date | null }>('select deleted_at from contacts where tenant_id = $1 and id = $2', [tenantId, ancienne.id]);
    expect(brute.rows[0]?.deleted_at).not.toBeNull();
  });

  it('poserExternalId sur une fiche SUPPRIMÉE rend « absente », et n’écrit rien', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000719' });
    await pool.query('update contacts set deleted_at = now() where tenant_id = $1 and id = $2', [tenantId, c.id]);
    expect(await store.poserExternalId(tenantId, c.id, 'itest-ext-719')).toBe('absente');
    const brute = await pool.query<{ external_id: string | null }>('select external_id from contacts where tenant_id = $1 and id = $2', [tenantId, c.id]);
    expect(brute.rows[0]?.external_id).toBeNull();
  });

  it('🔴 un `contactId` en MAJUSCULES retrouve la fiche, et l’identifiant rendu est celui de la base', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000720' });
    expect(await resoudreFiche(store, tenantId, { contactId: c.id.toUpperCase() }, { creer: 'jamais' })).toEqual({ ok: true, contactId: c.id, cree: false });
  });

  it('poserExternalId remplace, et refuse une valeur portée par une autre fiche de l’espace', async () => {
    const a = await creer(tenantId, { phoneE164: '+33600000705', externalId: 'itest-ext-705' });
    const b = await creer(tenantId, { phoneE164: '+33600000706' });
    expect(await store.poserExternalId(tenantId, a.id, 'itest-ext-705-bis')).toBe('ok');
    expect(await store.poserExternalId(tenantId, b.id, 'itest-ext-705-bis')).toBe('conflit');
    expect((await store.lireFicheApi(tenantId, b.id))?.externalId).toBeNull();
  });

  it('🔴 editerFicheApi : fusion, retrait, étiquettes et nom en une requête ; une fiche SUPPRIMÉE n’est pas réécrite', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000714' });
    expect(await store.editerFicheApi(tenantId, c.id, { fields: { ville: 'Lyon', age: '42' }, removeFields: [], addTags: ['a', 'b'], removeTags: [], profileName: 'Camille' })).toBe(true);
    // Une étiquette ajoutée ET retirée dans le même appel n'est pas sur la fiche à la fin (ordre d'`applyEdits`).
    expect(await store.editerFicheApi(tenantId, c.id, { fields: { prenom: 'Camille' }, removeFields: ['age'], addTags: ['c', 'a'], removeTags: ['b', 'c'] })).toBe(true);
    const lue = await store.lireFicheApi(tenantId, c.id);
    expect(lue?.fields).toEqual({ ville: 'Lyon', prenom: 'Camille' });
    expect(lue?.tags).toEqual(['a']);
    expect(lue?.profileName).toBe('Camille');
    await pool.query('update contacts set deleted_at = now() where tenant_id = $1 and id = $2', [tenantId, c.id]);
    expect(await store.editerFicheApi(tenantId, c.id, { fields: { ville: 'Paris' }, removeFields: [], addTags: [], removeTags: [], profileName: 'Intrus' })).toBe(false);
    const brute = await pool.query<{ fields: Record<string, string>; profile_name: string | null }>('select fields, profile_name from contacts where tenant_id = $1 and id = $2', [tenantId, c.id]);
    expect(brute.rows[0]?.fields).toEqual({ ville: 'Lyon', prenom: 'Camille' });
    expect(brute.rows[0]?.profile_name).toBe('Camille');
  });

  it('une fiche supprimée disparaît des lectures de l’API', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000707', externalId: 'itest-ext-707' });
    await pool.query('update contacts set deleted_at = now() where tenant_id = $1 and id = $2', [tenantId, c.id]);
    expect(await store.lireFicheApi(tenantId, c.id)).toBeNull();
    expect(await store.chercherParCles(tenantId, { contactId: c.id })).toEqual([]);
  });

  it('une création BSUID seul vise l’index du BSUID', async () => {
    const c = await creer(tenantId, { bsuid: 'itest-bsuid-708', externalId: 'itest-ext-708' });
    expect(c).toMatchObject({ created: true, phoneE164: null, bsuid: 'itest-bsuid-708', externalId: 'itest-ext-708' });
    const seconde = await creer(tenantId, { bsuid: 'itest-bsuid-708' });
    expect(seconde.id).toBe(c.id);
    // `xmax = 0` ne vaut vrai que pour une ligne INSÉRÉE : la seconde est une mise à jour.
    expect(seconde.created).toBe(false);
  });

  it('🔴 le consentement par identifiant : la date du premier désabonnement est GARDÉE', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000709' });
    expect(await store.ecrireConsentementParId(tenantId, c.id, 'opted_out', 'api')).toBe('change');
    const premiere = (await store.lireFicheApi(tenantId, c.id))?.optOutAt;
    // `typeof`, pas `not.toBeNull()` : une fiche introuvable rendrait `undefined`, qui passerait ce dernier.
    expect(typeof premiere).toBe('string');
    expect(await store.ecrireConsentementParId(tenantId, c.id, 'opted_out', 'api')).toBe('inchange');
    expect((await store.lireFicheApi(tenantId, c.id))?.optOutAt).toBe(premiere);
    // 🔴 UN STOP NE SE LÈVE PAS PAR MACHINE (décision de Julien du 2026-09-24) : la garde est dans la requête.
    expect(await store.ecrireConsentementParId(tenantId, c.id, 'opted_in', 'formulaire-site')).toBe('refuse');
    expect(await store.lireFicheApi(tenantId, c.id)).toMatchObject({ optInStatus: 'opted_out', optInSource: 'api', optOutAt: premiere });
  });

  it('le consentement d’une fiche d’un AUTRE espace est « absente »', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000710' });
    expect(await store.ecrireConsentementParId(autreTenantId, c.id, 'opted_out', 'api')).toBe('absente');
  });

  it('🔴 le consentement d’une fiche PURGÉE est « absente », et son statut ne bouge pas', async () => {
    const c = await creer(tenantId, { phoneE164: '+33600000722' });
    expect(await store.ecrireConsentementParId(tenantId, c.id, 'opted_in', 'formulaire-site')).toBe('change');
    await store.purgeMany(tenantId, [c.id]);
    expect(await store.ecrireConsentementParId(tenantId, c.id, 'opted_out', 'api')).toBe('absente');
    const brute = await pool.query<{ opt_in_status: string; opt_out_at: Date | null }>(
      'select opt_in_status, opt_out_at from contacts where tenant_id = $1 and id = $2', [tenantId, c.id],
    );
    expect(brute.rows[0]).toEqual({ opt_in_status: 'opted_in', opt_out_at: null });
  });

  it('🔴 résolution contre la base : deux clés sur deux fiches, `identity_conflict`, et rien n’est écrit', async () => {
    const a = await creer(tenantId, { phoneE164: '+33600000711' });
    const b = await creer(tenantId, { phoneE164: '+33600000712', externalId: 'itest-ext-712' });
    const [avantA, avantB] = [await majLe(a.id), await majLe(b.id)];
    expect(await resoudreFiche(store, tenantId, { phone: '+33600000711', externalId: 'itest-ext-712' }, { creer: 'phone_ou_bsuid' }))
      .toEqual({ ok: false, code: 'identity_conflict' });
    // `updated_at` inchangé sur LES DEUX fiches : aucune écriture n'est partie, pas seulement « externalId toujours
    // vide » (l'état de départ de la fiche a, qu'une écriture d'une autre clé laisserait tel quel).
    expect([await majLe(a.id), await majLe(b.id)]).toEqual([avantA, avantB]);
    expect(await store.lireFicheApi(tenantId, a.id)).toMatchObject({ externalId: null, phoneE164: '+33600000711', bsuid: null });
    expect(await store.lireFicheApi(tenantId, b.id)).toMatchObject({ externalId: 'itest-ext-712', phoneE164: '+33600000712', bsuid: null });
  });

  it('résolution contre la base : une clé neuve est rattachée, et chaque clé retrouve ensuite la fiche', async () => {
    const a = await creer(tenantId, { phoneE164: '+33600000713' });
    expect(await resoudreFiche(store, tenantId, { phone: '0600000713', externalId: 'itest-ext-713' }, { creer: 'jamais' }))
      .toEqual({ ok: true, contactId: a.id, cree: false });
    expect(await resoudreFiche(store, tenantId, { externalId: 'itest-ext-713' }, { creer: 'jamais' }))
      .toEqual({ ok: true, contactId: a.id, cree: false });
  });

  it('🔴 service contre la base : écrire, chercher, modifier (null vide un champ, externalId se remplace)', async () => {
    const actions: string[] = [];
    const service = creerServiceContactsV1({
      contacts: store,
      fields: new PgUserFieldStore(pool),
      audit: async (_t, _a, action) => { actions.push(action); },
      joignabiliteRcs: async () => null,
    });
    const [r] = await service.ecrireFiches(tenantId, [{ phone: '+33600000721', externalId: 'itest-ext-721', fields: { ville: 'Lyon', age: '42' }, consent: 'opted_in' }]);
    expect(r).toMatchObject({ status: 'created' });
    const trouvee = await service.chercherFiche(tenantId, { externalId: 'itest-ext-721' });
    if (!trouvee.ok || !trouvee.fiche) throw new Error('fiche introuvable');
    const id = trouvee.fiche.contactId;
    expect(trouvee.fiche).toMatchObject({ phone: '+33600000721', fields: { ville: 'Lyon', age: '42' }, consent: { status: 'opted_in' } });
    expect(await service.modifierFiche(tenantId, id, { fields: { ville: null }, externalId: 'itest-ext-721-bis', consent: 'opted_out' })).toEqual({ ok: true, contactId: id });
    const relue = await service.lireFiche(tenantId, id);
    expect(relue).toMatchObject({ externalId: 'itest-ext-721-bis', fields: { age: '42' }, consent: { status: 'opted_out' } });
    // `toMatchObject` tolère une clé en trop : c'est l'égalité exacte qui prouve que `null` a VIDÉ « ville ».
    expect(relue?.fields).toEqual({ age: '42' });
    expect(relue?.consent.optedOutAt).not.toBeNull();
    expect(actions).toEqual(['contact.optin', 'contact.optout']);
  });
});
