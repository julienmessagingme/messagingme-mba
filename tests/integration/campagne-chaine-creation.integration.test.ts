import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCampaignRepo } from '../../src/campaign/store.pg';
import type { EtageEntrant } from '../../src/campaign/etages';

/**
 * LA CRÉATION SAIT ÉCRIRE UNE CHAÎNE, pas seulement l'afficher.
 *
 * 🔴 CE QUE SEULE UNE BASE PEUT PROUVER, ET POURQUOI CE FICHIER EXISTE. `insertCampaignRow` était le SEUL
 * écrivain de `campaign_etages` et n'écrivait que le rang 1 : l'assistant montrait trois étages, le moteur
 * de bascule savait les parcourir, la ventilation par canal savait les compter, et RIEN entre les deux ne
 * savait les enregistrer. Un test unitaire ne voit pas ce trou, puisque le défaut est dans la requête.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et ce
 * fichier crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('la creation d une chaine d etages', () => {
  let pool: Pool;
  let repo: PgCampaignRepo;
  let tenantId = '';
  let modeleId = '';

  const base = () => ({
    tenantId, phoneNumberId: 'pn-chaine-creation', name: 'chaine-creation', category: 'marketing' as const,
    templateName: 'promo', templateLanguage: 'fr', paramMapping: [],
  });

  /** Les étages tels qu'ils sont EN BASE, sans passer par une couche qui les inventerait. */
  const etagesEnBase = async (campaignId: string) => {
    const { rows } = await pool.query<{
      rang: number; canal: string; template_name: string | null; template_language: string | null;
      rcs_message: unknown; email_template_id: string | null; workflow_id: string | null;
    }>(
      `select rang, canal, template_name, template_language, rcs_message, email_template_id, workflow_id
         from campaign_etages where campaign_id = $1 order by rang`,
      [campaignId],
    );
    return rows;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    repo = new PgCampaignRepo(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-chaine-creation') returning id`,
    )).rows[0]!.id;
    // Un vrai modèle de mail : `campaign_etages.email_template_id` porte une clé étrangère, donc un
    // identifiant inventé rendrait une 23503 et le test mesurerait la contrainte au lieu de l'écriture.
    modeleId = (await pool.query<{ id: string }>(
      `insert into email_templates (tenant_id, name, format, subject, body)
       values ($1, 'modele-chaine', 'text', 'sujet', 'corps') returning id`,
      [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await pool.query('delete from campaigns where tenant_id = $1', [tenantId]);
      await pool.query('delete from email_templates where tenant_id = $1', [tenantId]);
      await pool.query('delete from tenants where id = $1', [tenantId]);
    }
    await pool.end();
  });

  it('une chaine a trois etages ecrit TROIS lignes, dans leur ordre', async () => {
    const id = await repo.insertCampaign({
      ...base(),
      chaine: [
        { rang: 1, canal: 'whatsapp', templateName: 'promo', templateLanguage: 'fr' },
        { rang: 2, canal: 'rcs', rcsMessage: { kind: 'text', text: 'coucou' } },
        { rang: 3, canal: 'email', emailTemplateId: modeleId },
      ],
    });
    const rows = await etagesEnBase(id);
    expect(rows.map((r) => ({ rang: r.rang, canal: r.canal }))).toEqual([
      { rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' }, { rang: 3, canal: 'email' },
    ]);
    // ⚠️ LE CONTENU AUSSI, pas seulement le canal : trois lignes vides seraient trois étages qui ne
    // sauraient rien envoyer, et le compte serait pourtant juste.
    expect(rows[1]?.rcs_message).toEqual({ kind: 'text', text: 'coucou' });
    expect(rows[2]?.email_template_id).toBe(modeleId);
  });

  /**
   * 🔴 LE CAS QUI PROTÈGE L'EXISTANT. Une création SANS chaîne continue d'écrire exactement un étage,
   * comme avant ce lot : c'est le comportement de l'API publique, des clients existants et de tout le
   * parc. C'est ce test qui casserait si quelqu'un rendait `chaine` obligatoire.
   */
  it('une creation sans chaine ecrit UN etage, comme avant', async () => {
    const id = await repo.insertCampaign(base());
    const rows = await etagesEnBase(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rang: 1, canal: 'whatsapp', template_name: 'promo', template_language: 'fr' });
  });

  // ⚠️ Les rangs viennent du client : ils se NORMALISENT, ils ne se croient pas. Écrits tels quels, un
  // couple (1, 3) laisserait un trou que `rangSuivant` sait franchir mais que le CHECK borne à 3.
  it('des rangs troues ou desordonnes sont renumerotes 1, 2, 3', async () => {
    const id = await repo.insertCampaign({
      ...base(),
      chaine: [{ rang: 3, canal: 'rcs' }, { rang: 1, canal: 'whatsapp' }],
    });
    const rows = await etagesEnBase(id);
    expect(rows.map((r) => ({ rang: r.rang, canal: r.canal }))).toEqual([
      { rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' },
    ]);
  });

  /**
   * 🔴 LE RANG 1 VIENT DES COLONNES DE `campaigns`, JAMAIS DE LA CHAÎNE REÇUE, et c'est l'invariant que
   * la migration 0134 pose (« une seule source pour le contenu d'un étage »). Le moteur construit son run
   * sur ces colonnes et ne sert que le rang 1 (`etageServable`) : si l'étage disait autre chose, le
   * message parti serait celui de la campagne et le journal dirait celui de l'étage.
   */
  it('le contenu du rang 1 est celui de la campagne, meme si le client en propose un autre', async () => {
    const id = await repo.insertCampaign({
      ...base(),
      chaine: [
        { rang: 1, canal: 'whatsapp', templateName: 'PAS-CELUI-LA', templateLanguage: 'en' },
        { rang: 2, canal: 'rcs' },
      ],
    });
    const rows = await etagesEnBase(id);
    expect(rows[0]).toMatchObject({ template_name: 'promo', template_language: 'fr' });
    const { rows: campagne } = await pool.query<{ template_name: string; template_language: string }>(
      `select template_name, template_language from campaigns where id = $1`, [id],
    );
    expect(rows[0]?.template_name).toBe(campagne[0]?.template_name);
    expect(rows[0]?.template_language).toBe(campagne[0]?.template_language);
  });

  /**
   * 🔴 L'ÉCRITURE DES ÉTAGES ET CELLE DE LA CAMPAGNE SONT DANS LA MÊME TRANSACTION. Une campagne
   * enregistrée sans ses étages est une campagne qu'aucun run ne peut servir (`getCampaign` lit la chaîne
   * pour décider ce qui part) : mieux vaut aucune campagne qu'une campagne morte.
   *
   * ⚠️ LE CANAL INVALIDE EST LE MOYEN, PAS LE SUJET. Il fait échouer le SECOND insert (le CHECK de
   * `campaign_etages.canal`) après que le premier a réussi, ce qui est exactement la fenêtre qu'on veut
   * fermer. La route, elle, refuse ce canal en 422 bien avant (`problemeDeChaine`) : on passe ici par le
   * dépôt pour atteindre la fenêtre que la validation d'entrée rend inaccessible.
   */
  it('un etage refuse par la base ne laisse AUCUNE campagne orpheline', async () => {
    const nom = `chaine-orpheline-${Date.now()}`;
    const chaine = [
      { rang: 1, canal: 'whatsapp' },
      { rang: 2, canal: 'sms' },
    ] as unknown as EtageEntrant[];
    await expect(repo.insertCampaign({ ...base(), name: nom, chaine })).rejects.toThrow();
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from campaigns where tenant_id = $1 and name = $2`, [tenantId, nom],
    );
    expect(rows[0]?.n, 'une campagne sans ses etages a survecu a l echec').toBe(0);
  });

  /**
   * 🔴 LES QUATRE RÉGLAGES DE L'ASSISTANT, ÉCRITS OU RIEN NE LES ÉCRIT. Ces colonnes de 0134 sont LUES
   * (`listCandidatsBascule` lit `reessayer` et `rattrapage_hors_horaires` ; l'assignation d'une réponse
   * lit `assignation` et `assignation_user_id`) et n'étaient écrites par aucun chemin : elles gardaient
   * leur défaut de table quoi que l'opérateur ait coché, ce qui rendait le tour de rôle inatteignable.
   */
  it('les reglages de l assistant arrivent en base, pas seulement a l ecran', async () => {
    const userId = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role) values ($1, $2, 'admin') returning id`,
      [tenantId, `chaine-${Date.now()}@example.test`],
    )).rows[0]!.id;
    const id = await repo.insertCampaign({
      ...base(), reessayer: false, rattrapageHorsHoraires: true,
      assignation: 'personne', assignationUserId: userId,
    });
    const { rows } = await pool.query<{
      reessayer: boolean; rattrapage_hors_horaires: boolean; assignation: string | null;
      assignation_user_id: string | null; tour_de_role_rang: number;
    }>(
      `select reessayer, rattrapage_hors_horaires, assignation, assignation_user_id, tour_de_role_rang
         from campaigns where id = $1`, [id],
    );
    expect(rows[0]).toMatchObject({
      reessayer: false, rattrapage_hors_horaires: true, assignation: 'personne',
      assignation_user_id: userId, tour_de_role_rang: 0,
    });
  });

  // ⚠️ L'AUTRE SENS, et il vaut autant : une création qui ne dit rien de ces réglages retrouve le défaut
  // de la table, pas une valeur que ce lot aurait décidée à sa place.
  it('une creation muette garde les defauts de la table', async () => {
    const id = await repo.insertCampaign(base());
    const { rows } = await pool.query<{ reessayer: boolean; rattrapage_hors_horaires: boolean; assignation: string | null }>(
      `select reessayer, rattrapage_hors_horaires, assignation from campaigns where id = $1`, [id],
    );
    expect(rows[0]).toEqual({ reessayer: true, rattrapage_hors_horaires: false, assignation: null });
  });

  // ⚠️ `assignation_user_id` NE SURVIT QU'AVEC `personne` : le garder sur un tour de rôle laisserait en
  // base une personne désignée que plus rien ne lit, donc une seconde vérité sur le même réglage.
  it('le tour de role n emporte aucune personne designee', async () => {
    const userId = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role) values ($1, $2, 'admin') returning id`,
      [tenantId, `chaine-tdr-${Date.now()}@example.test`],
    )).rows[0]!.id;
    const id = await repo.insertCampaign({
      ...base(), assignation: 'tour_de_role', assignationUserId: userId,
    });
    const { rows } = await pool.query<{ assignation: string; assignation_user_id: string | null }>(
      `select assignation, assignation_user_id from campaigns where id = $1`, [id],
    );
    expect(rows[0]).toEqual({ assignation: 'tour_de_role', assignation_user_id: null });
  });
});
