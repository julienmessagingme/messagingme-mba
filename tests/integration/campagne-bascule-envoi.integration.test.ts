import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { campaignRunJob } from '../../src/campaign/run-job';
import {
  PgCampaignRepo,
  PgCampaignStore,
  PgRecipientStore,
  PgFrequencyStore,
  PgQualityProvider,
} from '../../src/campaign/store.pg';
import { creerNoteurEnvois } from '../../src/campaign/envois.pg';
import type { MessageSender } from '../../src/campaign/engine';
import type { SendResult, MarketingParams, TemplateSpec } from '../../src/meta/types';

/**
 * LA BASCULE PUIS L'ENVOI, DE BOUT EN BOUT, SUR UNE VRAIE BASE (lot 6).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT, ET QUI NE SE PROUVE PAS SANS BASE. Les tests unitaires du moteur lui
 * DONNENT sa chaîne et sa table de canaux : ils ne peuvent donc rien dire du chemin qui les produit. Or
 * c'est là qu'est le risque, et il est en trois morceaux que seule une base relie : `campaign_etages`
 * garde-t-elle le message du rang 2 ? `basculerEtage` pose-t-elle vraiment `etage_courant` ? Et le job de
 * run relit-il l'un et l'autre pour construire le sender du BON canal ?
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et
 * ce fichier crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 *
 * ⚠️ Il a besoin des migrations 0133 à 0136 (colonne `etage_courant`, table `campaign_etages`, journal
 * `campaign_envois`).
 */
const url = process.env.DATABASE_URL ?? '';

/** Sender Meta qui réussit, et qui retient ce qu'on lui a demandé d'envoyer. */
class SenderMeta implements MessageSender {
  readonly modeles: string[] = [];
  async sendMarketing(p: MarketingParams): Promise<SendResult> {
    this.modeles.push(p.template.name);
    return { messageId: `wamid-${p.to ?? p.recipient ?? ''}` };
  }
  async sendTemplate(to: string, tpl: TemplateSpec): Promise<SendResult> {
    this.modeles.push(tpl.name);
    return { messageId: `wamid-${to}` };
  }
}

const MESSAGE_DU_REPLI = { kind: 'text', text: 'le message de l etage 2' };

describe.skipIf(!url)('la bascule mene a un envoi sur le canal de l etage', () => {
  let pool: Pool;
  let repo: PgCampaignRepo;
  let tenantId = '';

  const journal = async (campaignId: string) => {
    const { rows } = await pool.query<{ rang: number; canal: string; statut: string; message_id: string | null }>(
      `select rang, canal, statut, message_id from campaign_envois where campaign_id = $1 order by sent_at, id`,
      [campaignId],
    );
    return rows;
  };

  const etageDe = async (id: string): Promise<number> => (await pool.query<{ etage_courant: number }>(
    `select etage_courant from campaign_recipients where id = $1`, [id],
  )).rows[0]!.etage_courant;

  /**
   * Une campagne WhatsApp AVEC un repli RCS, par le chemin de création réel.
   *
   * ⚠️ Le rang 1 ne porte PAS de contenu dans ce qu'on envoie : `insertCampaignRow` le réécrit depuis les
   * colonnes de la campagne (invariant de la migration 0134). Le rang 2, lui, porte le sien, et c'est
   * exactement ce que ces tests vérifient qu'on retrouve.
   */
  const campagneAvecRepli = async (nom: string, tel: string): Promise<{ campaignId: string; recipientId: string }> => {
    const contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`,
      [tenantId, tel],
    )).rows[0]!.id;
    const { campaignId } = await repo.createWithRecipients(
      {
        tenantId, phoneNumberId: 'pn-multicanal', name: nom, category: 'marketing',
        templateName: 'promo', templateLanguage: 'fr', paramMapping: [],
        channel: 'whatsapp', rcsAgentId: 'agent-multicanal',
        chaine: [
          { rang: 1, canal: 'whatsapp' },
          { rang: 2, canal: 'rcs', rcsMessage: MESSAGE_DU_REPLI },
        ],
      },
      [{ contactId, toE164: tel, resolvedParams: [] }],
    );
    const recipientId = (await pool.query<{ id: string }>(
      `select id from campaign_recipients where campaign_id = $1`, [campaignId],
    )).rows[0]!.id;
    return { campaignId, recipientId };
  };

  /** Le câblage RÉEL du job de run, plus deux espions : le modèle WhatsApp, et le message RCS reçu. */
  const deps = (meta: SenderMeta, vu: { message?: unknown; envoye: string[] }) => ({
    getCampaign: (id: string) => repo.getCampaign(id),
    senderFor: async (): Promise<MessageSender> => meta,
    // 🔴 C'EST ICI QUE SE JOUE LE LOT : le message passé au sender de canal doit être celui de l'ÉTAGE,
    // pas `campaign.rcsMessage`, qui vaut `null` sur une campagne WhatsApp.
    rcsSenderFor: async (_c: unknown, message: unknown) => {
      vu.message = message;
      return { sendTo: async (r: { toE164: string }) => { vu.envoye.push(r.toE164); return { messageId: `rcs-${r.toE164}` }; } };
    },
    recipients: new PgRecipientStore(pool),
    campaigns: new PgCampaignStore(pool),
    frequency: new PgFrequencyStore(pool),
    quality: new PgQualityProvider(pool),
    numeroDelieEnBase: async () => false,
    moteur: { noterEnvoi: creerNoteurEnvois(pool) },
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    repo = new PgCampaignRepo(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-bascule-envoi') returning id`,
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await pool.query('delete from campaign_etages where campaign_id in (select id from campaigns where tenant_id = $1)', [tenantId]);
      await pool.query('delete from campaigns where tenant_id = $1', [tenantId]);
      await pool.query('delete from contacts where tenant_id = $1', [tenantId]);
      await pool.query('delete from tenants where id = $1', [tenantId]);
    }
    await pool.end();
  });

  /**
   * 🔴 LE CONTENU DE L'ÉTAGE 2 SURVIT À L'ALLER-RETOUR EN BASE. Tout le reste du lot en dépend : si
   * `campaign_etages.rcs_message` ne revenait pas dans `Campaign.chaine`, le repli partirait vide, et
   * aucun test unitaire du moteur ne le verrait, puisqu'ils lui DONNENT sa chaîne.
   */
  it('la chaine relue porte le message de l etage 2, et le rang 1 le contenu de la campagne', async () => {
    const { campaignId } = await campagneAvecRepli('chaine-relue', '+33600002001');
    const campagne = await repo.getCampaign(campaignId);
    expect(campagne?.chaine).toHaveLength(2);
    expect(campagne?.chaine?.[1]).toMatchObject({ rang: 2, canal: 'rcs', rcsMessage: MESSAGE_DU_REPLI });
    // ⚠️ Et le rang 1 porte le modèle de la CAMPAGNE, recopié par `insertCampaignRow` : c'est l'invariant
    // « une seule source pour le contenu d'un étage », et le moteur s'appuie dessus.
    expect(campagne?.chaine?.[0]).toMatchObject({ rang: 1, canal: 'whatsapp', templateName: 'promo' });
  });

  /**
   * 🔴 LE CŒUR DU LOT, DE BOUT EN BOUT. Avant lui, un destinataire basculé au rang 2 était REFUSÉ par le
   * run, avec sa raison : la chaîne était décorative. Ici, il part vraiment, sur le canal de son étage,
   * avec le contenu de son étage.
   */
  it('un destinataire bascule au rang 2 part en RCS, avec le message de l etage 2', async () => {
    const { campaignId, recipientId } = await campagneAvecRepli('bascule-puis-envoi', '+33600002002');
    // L'échec du premier étage, puis la bascule, exactement comme le balayage les enchaîne.
    await pool.query(
      `update campaign_recipients set status = 'failed', error_code = 131026 where id = $1`,
      [recipientId],
    );
    expect(await repo.basculerEtage(recipientId, 2)).toBe(true);
    expect(await etageDe(recipientId)).toBe(2);

    const meta = new SenderMeta();
    const vu: { message?: unknown; envoye: string[] } = { envoye: [] };
    const rapport = await campaignRunJob({ campaignId }, deps(meta, vu));

    expect(rapport).toMatchObject({ sent: 1, failed: 0, paused: false });
    // 🔴 AUCUN MODÈLE WHATSAPP N'EST REPARTI : c'est ce qui distingue la bonne implémentation de celle qui
    // renvoie le message du rang 1, c'est-à-dire EXACTEMENT celui qui vient d'échouer.
    expect(meta.modeles).toEqual([]);
    expect(vu.envoye).toEqual(['+33600002002']);
    expect(vu.message).toEqual(MESSAGE_DU_REPLI);

    const envois = await journal(campaignId);
    expect(envois).toHaveLength(1);
    // Le journal note le canal RÉELLEMENT utilisé : c'est la seule source de l'analytique par canal.
    expect(envois[0]).toMatchObject({ rang: 2, canal: 'rcs', statut: 'sent', message_id: 'rcs-+33600002002' });
  });

  /**
   * ⚠️ L'AUTRE SENS, ET SANS LUI UNE IMPLÉMENTATION QUI ENVERRAIT TOUJOURS EN RCS PASSERAIT LE CAS DU
   * DESSUS. Un destinataire resté au rang 1 part par le canal de la campagne, avec son modèle.
   */
  it('un destinataire reste au rang 1 part toujours en WhatsApp, avec le modele de la campagne', async () => {
    const { campaignId } = await campagneAvecRepli('rang-1-inchange', '+33600002003');
    const meta = new SenderMeta();
    const vu: { message?: unknown; envoye: string[] } = { envoye: [] };
    const rapport = await campaignRunJob({ campaignId }, deps(meta, vu));

    expect(rapport).toMatchObject({ sent: 1, failed: 0, paused: false });
    expect(meta.modeles).toEqual(['promo']);
    expect(vu.envoye).toEqual([]);

    const envois = await journal(campaignId);
    expect(envois).toHaveLength(1);
    expect(envois[0]).toMatchObject({ rang: 1, canal: 'whatsapp', statut: 'sent' });
  });
});
