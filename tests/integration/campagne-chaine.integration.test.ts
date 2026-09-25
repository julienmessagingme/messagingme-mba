import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCampaignRepo } from '../../src/campaign/store.pg';
import { rangSuivant } from '../../src/campaign/etages';

/**
 * LA CHAÎNE D'ÉTAGES EN BASE (migration 0134).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT, ET QUI NE SE PROUVE PAS SANS BASE. Ce lot ne doit RIEN changer de
 * visible : la chaîne existe, elle a un seul étage, donc personne ne bascule nulle part. Ce qui ne se
 * vérifie qu'ici, c'est (1) que la REPRISE range les campagnes d'avant au bon canal plutôt que toutes en
 * WhatsApp, (2) que le chemin de création neuf écrit lui aussi son étage, et (3) que les CHECK de la
 * migration refusent VRAIMENT ce qu'ils annoncent, exécutés par Postgres et pas lus dans un fichier.
 *
 * ⚠️ La table et les colonnes viennent de la migration 0134 : ce fichier échoue tant qu'elle n'est pas
 * appliquée, et c'est voulu (elle est bloquante, elle passe AVANT le déploiement).
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et ce
 * fichier crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

/**
 * L'INSTRUCTION DE REPRISE, LUE DANS LA MIGRATION ELLE-MÊME, jamais recopiée.
 *
 * 🔴 UNE COPIE AURAIT TESTÉ LA COPIE. C'est le seul montage qui fasse échouer le test le jour où
 * quelqu'un modifie la reprise dans le fichier SQL, ce qui est exactement l'événement contre lequel il
 * est écrit. Même doctrine que le test qui LIT le SQL de 0127 pour vérifier la forme d'une clé.
 *
 * ⚠️ Elle est REJOUABLE parce qu'elle porte `on conflict (campaign_id, rang) do nothing` : la relancer
 * ici ne fait que reprendre les campagnes créées depuis, et ne touche à aucune ligne déjà écrite.
 */
function sqlDeReprise(): string {
  const fichier = readFileSync(new URL('../../db/migrations/0134_campagne_chaine.sql', import.meta.url), 'utf8');
  const debut = fichier.indexOf('insert into campaign_etages');
  expect(debut, 'la reprise a disparu de la migration 0134').toBeGreaterThan(-1);
  const fin = fichier.indexOf(';', debut);
  expect(fin, 'la reprise de 0134 ne se termine pas').toBeGreaterThan(debut);
  return fichier.slice(debut, fin + 1);
}

describe.skipIf(!url)('la chaine d etages en base (0134)', () => {
  let pool: Pool;
  let repo: PgCampaignRepo;
  let tenantId = '';
  let contactId = '';

  /** Les étages d'une campagne, tels qu'ils sont EN BASE, sans passer par une couche qui les inventerait. */
  const etagesEnBase = async (campaignId: string) => {
    const { rows } = await pool.query<{
      rang: number; canal: string; template_name: string | null; template_language: string | null;
      rcs_message: unknown; workflow_id: string | null;
    }>(
      `select rang, canal, template_name, template_language, rcs_message, workflow_id
         from campaign_etages where campaign_id = $1 order by rang`,
      [campaignId],
    );
    return rows;
  };

  /**
   * Une campagne écrite DIRECTEMENT en SQL, c'est-à-dire sans son étage : c'est l'état exact d'une ligne
   * antérieure à 0134, et le seul moyen d'exercer la reprise après coup (le chemin de création, lui,
   * écrit désormais son étage tout seul, donc il ne prouverait rien de la reprise).
   */
  const campagneDAvant = async (
    c: { canal: string; templateName: string | null; langue: string | null; rcsMessage: unknown; workflowId: string | null },
  ): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, phone_number_id, name, category, template_name, template_language, channel, rcs_message, workflow_id)
       values ($1, 'pn-chaine', 'avant-0134', 'marketing', $2, $3, $4, $5::jsonb, $6) returning id`,
      [tenantId, c.templateName, c.langue, c.canal, c.rcsMessage === null ? null : JSON.stringify(c.rcsMessage), c.workflowId],
    );
    return rows[0]!.id;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    repo = new PgCampaignRepo(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-chaine') returning id`,
    )).rows[0]!.id;
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, '+33600000134', 'opted_in') returning id`,
      [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) {
      // `campaign_etages`, `campaign_envois` et `campaign_recipients` partent en cascade avec la campagne.
      await pool.query('delete from campaigns where tenant_id = $1', [tenantId]);
      await pool.query('delete from contacts where tenant_id = $1', [tenantId]);
      await pool.query('delete from tenants where id = $1', [tenantId]);
    }
    await pool.end();
  });

  it('la reprise place les campagnes existantes au rang 1 avec LEUR canal, pas WhatsApp par defaut', async () => {
    const rcs = await campagneDAvant({ canal: 'rcs', templateName: null, langue: null, rcsMessage: { kind: 'text', text: 'coucou' }, workflowId: null });
    const wa = await campagneDAvant({ canal: 'whatsapp', templateName: 'promo', langue: 'fr', rcsMessage: null, workflowId: null });
    // Point de départ : ces deux lignes n'ont AUCUN étage, comme toute campagne d'avant la migration.
    expect(await etagesEnBase(rcs)).toHaveLength(0);
    expect(await etagesEnBase(wa)).toHaveLength(0);

    await pool.query(sqlDeReprise());

    const [etageRcs] = await etagesEnBase(rcs);
    // 🔴 LE CANAL, C'EST TOUT L'ENJEU DE LA REPRISE. Une reprise qui écrirait 'whatsapp' pour tout le monde
    // passerait sur la campagne WhatsApp juste en dessous et ne se verrait QUE sur celle-ci.
    expect(etageRcs?.rang).toBe(1);
    expect(etageRcs?.canal).toBe('rcs');
    expect(etageRcs?.rcs_message).toEqual({ kind: 'text', text: 'coucou' });

    const [etageWa] = await etagesEnBase(wa);
    expect(etageWa?.canal).toBe('whatsapp');
    // ⚠️ Le CONTENU est repris aussi, pas seulement le canal : un étage sans son template ne saurait rien
    // envoyer le jour où le moteur lira la chaîne au lieu des colonnes de `campaigns`.
    expect(etageWa?.template_name).toBe('promo');
    expect(etageWa?.template_language).toBe('fr');
  });

  it('la reprise est IDEMPOTENTE : la rejouer ne duplique ni n ecrase rien', async () => {
    const id = await campagneDAvant({ canal: 'rcs', templateName: null, langue: null, rcsMessage: { kind: 'text', text: 'un' }, workflowId: null });
    await pool.query(sqlDeReprise());
    // On change le canal de la CAMPAGNE, puis on rejoue : l'étage déjà écrit ne doit pas bouger. C'est ce
    // que `on conflict do nothing` garantit, et c'est ce qui rend une migration rejouable sans dégât.
    await pool.query(`update campaigns set channel = 'whatsapp' where id = $1`, [id]);
    await pool.query(sqlDeReprise());
    const etages = await etagesEnBase(id);
    expect(etages).toHaveLength(1);
    expect(etages[0]?.canal).toBe('rcs');
  });

  it('le chemin de CREATION ecrit lui aussi son etage 1, et getCampaign rend la chaine', async () => {
    const campaignId = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-chaine', name: 'chaine-neuve', category: 'marketing',
      templateName: 'bienvenue', templateLanguage: 'fr', paramMapping: [],
    });
    const etages = await etagesEnBase(campaignId);
    expect(etages).toHaveLength(1);
    expect(etages[0]).toMatchObject({ rang: 1, canal: 'whatsapp', template_name: 'bienvenue', template_language: 'fr' });

    const campagne = await repo.getCampaign(campaignId);
    expect(campagne?.chaine).toEqual([{ rang: 1, canal: 'whatsapp', templateName: 'bienvenue', templateLanguage: 'fr' }]);
    // 🔴 L'INVARIANT DE TOUT LE LOT, exécuté par le VRAI code sur ce que la base rend : une chaîne à un
    // seul étage n'a pas de suivant, donc aucune bascule n'est possible, donc rien ne change.
    expect(rangSuivant(campagne!.chaine!, 1)).toBeNull();
  });

  it('une campagne RCS creee maintenant porte un etage RCS, pas un etage WhatsApp', async () => {
    const campaignId = await repo.insertCampaign({
      tenantId, phoneNumberId: '', name: 'chaine-rcs', category: 'marketing',
      templateName: '', templateLanguage: '', paramMapping: [],
      channel: 'rcs', rcsAgentId: 'agent-x', rcsMessage: { kind: 'text', text: 'rcs neuf' },
    });
    const etages = await etagesEnBase(campaignId);
    expect(etages[0]?.canal).toBe('rcs');
    expect(etages[0]?.rcs_message).toEqual({ kind: 'text', text: 'rcs neuf' });
    // ⚠️ Le contenu de l'étage est CELUI QUI EST PARTI DANS `campaigns`, calculé une seule fois. Deux
    // expressions recopiées auraient pu donner deux valeurs, et c'est la seule façon de s'en apercevoir.
    const { rows } = await pool.query<{ rcs_message: unknown; channel: string }>(
      `select rcs_message, channel from campaigns where id = $1`, [campaignId],
    );
    expect(rows[0]?.rcs_message).toEqual(etages[0]?.rcs_message);
    expect(rows[0]?.channel).toBe(etages[0]?.canal);
  });

  it('une campagne a SCENARIO reprend son workflow dans l etage, et pas de template', async () => {
    const workflowId = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'wf-chaine') returning id`, [tenantId],
    )).rows[0]!.id;
    const campaignId = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-chaine', name: 'chaine-wf', category: 'utility',
      templateName: 'ignore', templateLanguage: 'fr', paramMapping: [], workflowId,
    });
    const etages = await etagesEnBase(campaignId);
    // ⚠️ `template_name` est null, exactement comme dans `campaigns` : une campagne à scénario n'a pas de
    // template propre, et laisser le nom ici aurait recréé la « campagne bâtarde » que l'insert évite.
    expect(etages[0]).toMatchObject({ canal: 'whatsapp', template_name: null, template_language: null, workflow_id: workflowId });
  });

  it('un destinataire nait au premier etage', async () => {
    const campaignId = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-chaine', name: 'chaine-etage-courant', category: 'marketing',
      templateName: 't', templateLanguage: 'fr', paramMapping: [],
    });
    await repo.insertRecipients(campaignId, [{ contactId, toE164: '+33600000134', resolvedParams: [] }]);
    const { rows } = await pool.query<{ etage_courant: number }>(
      `select etage_courant from campaign_recipients where campaign_id = $1`, [campaignId],
    );
    expect(rows[0]?.etage_courant).toBe(1);
  });

  it('les CHECK de 0134 refusent VRAIMENT, executes par Postgres et pas lus dans un fichier', async () => {
    const campaignId = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-chaine', name: 'chaine-checks', category: 'marketing',
      templateName: 't', templateLanguage: 'fr', paramMapping: [],
    });
    // 🔴 UN TEST SUR LE TEXTE DU SQL NE PROUVE PAS SON SENS. On tente les écritures interdites.
    await expect(pool.query(
      `insert into campaign_etages (campaign_id, rang, canal) values ($1, 4, 'whatsapp')`, [campaignId],
    )).rejects.toThrow(/rang/);
    await expect(pool.query(
      `insert into campaign_etages (campaign_id, rang, canal) values ($1, 2, 'sms')`, [campaignId],
    )).rejects.toThrow(/canal/);
    // La clé primaire (campaign_id, rang) : c'est elle qui interdit deux étages au même rang, donc qui
    // rend la chaîne déterministe.
    await expect(pool.query(
      `insert into campaign_etages (campaign_id, rang, canal) values ($1, 1, 'email')`, [campaignId],
    )).rejects.toThrow(/campaign_etages_pkey/);

    // Le journal des tentatives porte les mêmes exigences de forme.
    await repo.insertRecipients(campaignId, [{ contactId, toE164: '+33600000134', resolvedParams: [] }]);
    const recipientId = (await pool.query<{ id: string }>(
      `select id from campaign_recipients where campaign_id = $1`, [campaignId],
    )).rows[0]!.id;
    await expect(pool.query(
      `insert into campaign_envois (campaign_id, recipient_id, contact_id, rang, canal, statut)
       values ($1, $2, $3, 1, 'whatsapp', 'envoye')`,
      [campaignId, recipientId, contactId],
    )).rejects.toThrow(/statut/);
    await expect(pool.query(
      `insert into campaign_envois (campaign_id, recipient_id, contact_id, rang, canal, statut, delivery_status)
       values ($1, $2, $3, 1, 'whatsapp', 'sent', 'lu')`,
      [campaignId, recipientId, contactId],
    )).rejects.toThrow(/delivery_status/);
  });

  it('l index du funnel par canal existe, avec les colonnes dans le bon ordre', async () => {
    // ⚠️ L'ORDRE DES COLONNES EST LE POINT. `(campaign_id, canal)` sert l'égalité sur la campagne PUIS
    // rend les lignes déjà triées par canal ; `(canal, campaign_id)` porterait le même nom, le même coût
    // d'écriture, et ne servirait pas la requête du funnel.
    const { rows } = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'public' and indexname = 'campaign_envois_campagne_idx'`,
    );
    expect(rows[0]?.indexdef).toMatch(/\(campaign_id, canal\)/);
  });
});
