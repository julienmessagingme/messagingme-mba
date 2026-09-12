import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCampaignRepo } from '../../src/campaign/store.pg';
import { decider } from '../../src/campaign/bascule';

/**
 * LA FRONTIÈRE ENTRE LES DEUX POLITIQUES DE RATTRAPAGE, mesurée sur une vraie base.
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT, ET QUI NE SE PROUVE PAS SANS BASE. `runRetrySweep` est testé avec des
 * listes injectées : il ne peut donc RIEN dire de qui lui arrive, or c'est là qu'est le risque. Ce qui
 * empêche un destinataire d'être à la fois basculé ET relancé par F6 est une clause SQL
 * (`SANS_REPLI_SQL`), pas une ligne de TypeScript. Un test unitaire la verrait toujours vraie.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et
 * ce fichier crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 *
 * ⚠️ Il a besoin des migrations 0133 et 0134 (colonne `etage_courant`, table `campaign_etages`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('bascule d etage : la frontiere avec la relance F6', () => {
  let pool: Pool;
  let repo: PgCampaignRepo;
  let tenantId = '';
  let contactId = '';
  /** La campagne SANS repli (un seul étage, comme tout le parc d'aujourd'hui). */
  let campagneSimple = '';
  let destSimple = '';
  /** La campagne AVEC repli (deux étages). */
  let campagneChainee = '';
  let destChaine = '';

  /** Met un destinataire dans l'état « échec 131026 », celui que les deux politiques savent lire. */
  const armerEchec = async (id: string): Promise<void> => {
    await pool.query(
      `update campaign_recipients set status = 'failed', error_code = 131026, retry_count = 0 where id = $1`,
      [id],
    );
  };

  const etageDe = async (id: string): Promise<number> => (await pool.query<{ etage_courant: number }>(
    `select etage_courant from campaign_recipients where id = $1`, [id],
  )).rows[0]!.etage_courant;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    repo = new PgCampaignRepo(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-bascule') returning id`,
    )).rows[0]!.id;
    // Les listes de F6 ne servent que les espaces qui ont activé l'auto-relance.
    await pool.query(
      `insert into tenant_settings (tenant_id, auto_retry_enabled) values ($1, true)
       on conflict (tenant_id) do update set auto_retry_enabled = true`,
      [tenantId],
    );
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, '+33600000134', 'opted_in') returning id`,
      [tenantId],
    )).rows[0]!.id;

    const creer = async (nom: string): Promise<[string, string]> => {
      const cid = await repo.insertCampaign({
        tenantId, phoneNumberId: 'pn-bascule', name: nom, category: 'marketing',
        templateName: 't', templateLanguage: 'fr', paramMapping: [],
      });
      await repo.insertRecipients(cid, [{ contactId, toE164: '+33600000134', resolvedParams: ['X'] }]);
      const rid = (await pool.query<{ id: string }>(
        `select id from campaign_recipients where campaign_id = $1`, [cid],
      )).rows[0]!.id;
      return [cid, rid];
    };
    [campagneSimple, destSimple] = await creer('sans-repli');
    [campagneChainee, destChaine] = await creer('avec-repli');
    // 🔴 LE SECOND ÉTAGE EST POSÉ À LA MAIN, et c'est le coeur du test : `insertCampaignRow` n'écrit
    // que le rang 1, donc AUCUNE campagne créée par le produit n'a de repli aujourd'hui. Sans cette
    // ligne, les deux campagnes seraient identiques et le test ne discriminerait rien.
    await pool.query(
      `insert into campaign_etages (campaign_id, rang, canal) values ($1, 2, 'rcs')
       on conflict (campaign_id, rang) do nothing`,
      [campagneChainee],
    );
  });

  afterAll(async () => {
    if (tenantId) {
      await pool.query('delete from campaign_recipients where campaign_id in (select id from campaigns where tenant_id = $1)', [tenantId]);
      await pool.query('delete from campaign_etages where campaign_id in (select id from campaigns where tenant_id = $1)', [tenantId]);
      await pool.query('delete from campaigns where tenant_id = $1', [tenantId]);
      await pool.query('delete from tenant_settings where tenant_id = $1', [tenantId]);
      await pool.query('delete from contacts where tenant_id = $1', [tenantId]);
      await pool.query('delete from tenants where id = $1', [tenantId]);
    }
    await pool.end();
  });

  it('les deux politiques sont EXCLUSIVES : chacune ne voit que sa campagne', async () => {
    await armerEchec(destSimple);
    await armerEchec(destChaine);

    // La relance F6 ne voit QUE la campagne sans repli.
    const relances = (await repo.listRetry131026()).map((r) => r.id);
    expect(relances).toContain(destSimple);
    // 🔴 LE CAS QUI COMPTE : sans `SANS_REPLI_SQL`, ce destinataire serait ici EN PLUS d'être basculé,
    // donc relancé sur l'étage qui vient d'échouer et enfilé deux fois pour un seul échec.
    expect(relances).not.toContain(destChaine);

    // La bascule ne voit QUE la campagne à repli.
    const candidats = (await repo.listCandidatsBascule()).map((c) => c.id);
    expect(candidats).toEqual([destChaine]);
  });

  it('le candidat porte ce que la REGLE demande, lu de la base et pas fabrique', async () => {
    await armerEchec(destChaine);
    const c = (await repo.listCandidatsBascule()).find((x) => x.id === destChaine)!;
    expect(c.codeErreur).toBe(131026);
    expect(c.rangCourant).toBe(1);
    // La chaîne est celle de la base, les deux étages, pas une chaîne à un étage complétée à la main.
    expect(c.chaine.map((e) => e.rang).sort()).toEqual([1, 2]);
    // `reessayer` est le défaut `true` de la migration 0134, et il vaut un booléen, pas `undefined` :
    // `pg` rend bien un `boolean` sur une colonne `boolean not null`.
    expect(c.reessayer).toBe(true);
    expect(c.dejaReessaye).toBe(false);
    // ⚠️ `contacts` n'a PAS de colonne `email` : l'adresse vaut null tant que l'étage e-mail n'existe pas.
    expect(c.emailDuContact).toBeNull();
    // La règle, exécutée sur ce que la base rend et non sur un objet écrit à la main.
    expect(decider(c)).toEqual({ type: 'bascule', rang: 2 });
  });

  it('basculerEtage avance l etage, remet en pending, et n incremente PAS le budget de reessai', async () => {
    await armerEchec(destChaine);
    expect(await repo.basculerEtage(destChaine, 2)).toBe(true);
    const { rows } = await pool.query<{ status: string; error_code: number | null; retry_count: number; etage_courant: number }>(
      `select status, error_code, retry_count, etage_courant from campaign_recipients where id = $1`,
      [destChaine],
    );
    expect(rows[0]).toMatchObject({ status: 'pending', error_code: null, retry_count: 0, etage_courant: 2 });
  });

  it('basculerEtage est IDEMPOTENTE : la seconde ecriture ne touche rien', async () => {
    await armerEchec(destChaine);
    await pool.query(`update campaign_recipients set etage_courant = 1 where id = $1`, [destChaine]);
    expect(await repo.basculerEtage(destChaine, 2)).toBe(true);
    // 🔴 Le second balayage lit un destinataire qu'il croit encore au rang 1 : sans le verrou
    // `etage_courant < $2`, il réécrirait la ligne et un second run partirait pour le même échec.
    expect(await repo.basculerEtage(destChaine, 2)).toBe(false);
    expect(await etageDe(destChaine)).toBe(2);
  });

  it('un destinataire qui n est PAS en echec ne bascule pas', async () => {
    await pool.query(
      `update campaign_recipients set status = 'sent', error_code = null, delivery_status = 'delivered', etage_courant = 1 where id = $1`,
      [destChaine],
    );
    expect(await repo.basculerEtage(destChaine, 2)).toBe(false);
    expect(await etageDe(destChaine)).toBe(1);
    expect((await repo.listCandidatsBascule()).map((c) => c.id)).not.toContain(destChaine);
  });
});
