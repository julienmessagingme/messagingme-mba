import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgSourceStore } from '../../src/agent/sources.pg';
import { PgRequeteStore } from '../../src/agent/requetes.pg';
import { PgTenantSettingsStore } from '../../src/settings/store.pg';
import { PgContactStore } from '../../src/crm/contact-store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LE BRANCHEMENT « prévenir mon système à chaque désabonnement » (migration 0139), contre un VRAI Postgres.
 *
 * 🔴 POURQUOI EN INTÉGRATION, ET PAS AVEC UN DOUBLE. Tout ce qui compte ici est du SQL ou une contrainte :
 * que la clé étrangère existe et soit en `on delete set null` (sinon supprimer une requête ferait échouer la
 * suppression, ou pire, laisserait un identifiant mort que l'écran afficherait comme un branchement vivant),
 * que l'upsert n'écrase aucun autre réglage, et que les identités RÉELLEMENT touchées par une action en masse
 * remontent à l'annonce. Un faux dépôt dirait oui à tout cela.
 *
 * ⚠️ Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('poussée d’opt-out (Postgres)', () => {
  let pool: Pool;
  let settings: PgTenantSettingsStore;
  let sources: PgSourceStore;
  let requetes: PgRequeteStore;
  let tenantId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    settings = new PgTenantSettingsStore(pool);
    sources = new PgSourceStore(pool);
    requetes = new PgRequeteStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-poussee') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  async function creerRequete(label: string): Promise<string> {
    const src = await sources.creer(tenantId, { kind: 'http', label: `src-${label}`, baseUrl: 'https://crm.exemple.fr', authKind: 'none' });
    const rq = await requetes.creer(tenantId, {
      sourceId: src.id, label, methode: 'POST', chemin: '/unsubscribe',
      parametres: [], entetes: [], corps: { mode: 'json', gabarit: '{"phone":"{{tel}}"}' },
      variables: [{ nom: 'tel', type: 'string', origine: { type: 'contact', cle: 'wa_id' } }],
      outputPaths: ['ok'], valeursTest: {},
    });
    return rq.id;
  }

  it('le branchement se pose, se relit, et n’écrase aucun autre réglage', async () => {
    const rqId = await creerRequete('Desabonner');
    await settings.setMbaEnabled(tenantId, true);
    await settings.setOptoutRequestId(tenantId, rqId);

    const lu = await settings.get(tenantId);
    expect(lu.optoutRequestId).toBe(rqId);
    // L'upsert est CIBLÉ : poser le branchement ne doit pas remettre les autres réglages à leur défaut.
    expect(lu.mbaEnabled, 'un upsert non ciblé aurait rendu mbaEnabled à false').toBe(true);

    await settings.setOptoutRequestId(tenantId, null);
    expect((await settings.get(tenantId)).optoutRequestId).toBeNull();
    expect((await settings.get(tenantId)).mbaEnabled).toBe(true);
  });

  /**
   * 🔴 `on delete set null`, ET C'EST LA CEINTURE. Le refus lisible vit dans la route (409, « cette requête
   * prévient votre système à chaque désabonnement »), mais si ce refus venait à tomber, la contrainte doit
   * laisser un branchement VIDE et non un identifiant mort que l'écran afficherait comme vivant.
   *
   * ⚠️ ET SURTOUT PAS `restrict` : une contrainte qui BLOQUERAIT la suppression rendrait 500 sur un geste
   * ordinaire, en page Cloudflare, sans rien expliquer au client.
   */
  it('🔴 supprimer la requête débranche, elle ne laisse pas un identifiant mort', async () => {
    const rqId = await creerRequete('Ephemere');
    await settings.setOptoutRequestId(tenantId, rqId);
    expect((await settings.get(tenantId)).optoutRequestId).toBe(rqId);

    expect(await requetes.supprimer(tenantId, rqId)).toBe(true);
    expect((await settings.get(tenantId)).optoutRequestId, 'la ligne doit être remise à null, pas gardée').toBeNull();
  });

  /**
   * 🔴 CE QUE L'ANNONCE REÇOIT VIENT DE LA BASE, PAS D'UNE RELECTURE APRÈS COUP. Une action en masse se
   * résout sur des filtres : relire les contacts après l'écriture donnerait une photo d'APRÈS, donc
   * potentiellement d'autres personnes. Le `returning` est le seul moyen d'avoir exactement celles qu'on
   * vient de désabonner.
   */
  it('🔴 l’action en masse annonce EXACTEMENT les contacts qu’elle a touchés', async () => {
    const annonces: Array<{ tenantId: string; waIds: string[] }> = [];
    const contacts = new PgContactStore(pool, async (t, waIds) => { annonces.push({ tenantId: t, waIds }); });
    const a = await contacts.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600000101', profileName: 'A', fields: {}, optInStatus: 'opted_in' });
    const b = await contacts.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600000102', profileName: 'B', fields: {}, optInStatus: 'opted_in' });
    const c = await contacts.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600000103', profileName: 'C', fields: {}, optInStatus: 'opted_in' });

    const n = await contacts.applyEditsMany(tenantId, { ids: [a.id, b.id] }, { setOptIn: 'opted_out' });
    expect(n).toBe(2);
    expect(annonces).toHaveLength(1);
    expect([...annonces[0]!.waIds].sort()).toEqual(['33600000101', '33600000102']);
    expect(annonces[0]!.tenantId).toBe(tenantId);

    // La DATE est posée sur ceux-là et sur personne d'autre : c'est l'invariant de 0138, revérifié ici parce
    // que l'ajout du `returning` a touché cette requête.
    const dates = await pool.query<{ id: string; opt_out_at: Date | null }>(
      'select id, opt_out_at from contacts where id = any($1::uuid[]) order by phone_e164', [[a.id, b.id, c.id]],
    );
    expect(dates.rows.map((r) => r.opt_out_at !== null)).toEqual([true, true, false]);

    // ⚠️ LE TÉMOIN DANS L'AUTRE SENS : une action en masse qui ne touche PAS au consentement n'annonce rien.
    // Sans lui, ce fichier validerait un dépôt qui annonce à chaque action en masse, y compris une étiquette.
    await contacts.applyEditsMany(tenantId, { ids: [c.id] }, { addTags: ['vip'] });
    expect(annonces, 'poser une étiquette n’est pas un refus').toHaveLength(1);
  });

  /**
   * 🔴 L'INDEX PARTIEL DE 0139 EXISTE ET PORTE LE BON PRÉDICAT. Il sert la question « quelles requêtes sont
   * branchées sur le consentement ? », posée avant d'accepter une suppression. Un prédicat qui aurait dérivé
   * ne produirait AUCUNE erreur, juste un balayage complet de la table des réglages.
   */
  it('🔴 l’index partiel est là, avec son prédicat', async () => {
    const idx = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'tenant_settings' and indexname = 'tenant_settings_optout_request_idx'`,
    );
    expect(idx.rowCount, 'index absent : la migration 0139 n’a pas tout appliqué').toBe(1);
    expect(idx.rows[0]!.indexdef).toMatch(/WHERE \(optout_request_id IS NOT NULL\)/i);
  });
});
