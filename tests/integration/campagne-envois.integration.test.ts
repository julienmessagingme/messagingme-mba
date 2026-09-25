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
import type { CampaignSender } from '../../src/campaign/sender';
import type { SendResult, MarketingParams, TemplateSpec } from '../../src/meta/types';

/**
 * LE JOURNAL DES TENTATIVES D'ENVOI (migration 0134), rempli par le MOTEUR RÉEL.
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT. Le journal existe pour répondre à une question que
 * `campaign_recipients` ne pourra jamais trancher : par quel canal la tentative est-elle passée, et
 * combien y en a-t-il eu ? Ce qui ne se vérifie qu'ici, c'est que le moteur l'écrit SUR TOUS SES
 * CHEMINS (succès, échec, écarté) et que ce faisant il n'a RIEN changé au grain des destinataires : une
 * ligne par contact, garantie par `unique (campaign_id, contact_id)`, qui est le dédoublonnage du
 * produit. Un journal qui aurait coûté cette unicité serait un très mauvais marché.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et
 * ce fichier crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

/** Sender qui réussit, et qui rend un identifiant de message reconnaissable. */
class SenderQuiPasse implements MessageSender {
  async sendMarketing(p: MarketingParams): Promise<SendResult> {
    return { messageId: `wamid-${p.to ?? p.recipient ?? ''}` };
  }
  async sendTemplate(to: string, _tpl: TemplateSpec): Promise<SendResult> {
    return { messageId: `wamid-${to}` };
  }
}

/** Sender qui refuse, pour exercer le chemin d'échec du moteur (le plus important du lot). */
class SenderQuiRefuse implements MessageSender {
  async sendMarketing(): Promise<SendResult> {
    throw new Error('refus simule de Meta');
  }
  async sendTemplate(): Promise<SendResult> {
    throw new Error('refus simule de Meta');
  }
}

describe.skipIf(!url)('le journal des tentatives (0134)', () => {
  let pool: Pool;
  let repo: PgCampaignRepo;
  let tenantId = '';

  const journal = async (campaignId: string) => {
    const { rows } = await pool.query<{
      rang: number; canal: string; statut: string; message_id: string | null;
      error: string | null; error_code: number | null; delivery_status: string | null; contact_id: string;
    }>(
      `select rang, canal, statut, message_id, error, error_code, delivery_status, contact_id
         from campaign_envois where campaign_id = $1 order by sent_at, id`,
      [campaignId],
    );
    return rows;
  };

  const destinataires = async (campaignId: string) => {
    const { rows } = await pool.query<{ id: string; status: string; delivery_status: string | null; message_id: string | null }>(
      `select id, status, delivery_status, message_id from campaign_recipients where campaign_id = $1`,
      [campaignId],
    );
    return rows;
  };

  /**
   * Le câblage RÉEL du job de run, sur la base de test. C'est lui qui prouve quelque chose, pas un faux.
   *
   * ⚠️ `rcsSenderFor` est INJECTÉ : le job le réclame pour toute campagne de canal RCS et met la campagne
   * en pause s'il manque. On ne teste pas ici la mécanique d'envoi RCS (couverte ailleurs), seulement ce
   * que le journal retient du canal et du verdict rendu.
   */
  const deps = (sender: MessageSender, canalSender?: CampaignSender) => ({
    getCampaign: (id: string) => repo.getCampaign(id),
    senderFor: async () => sender,
    rcsSenderFor: async () => canalSender ?? null,
    recipients: new PgRecipientStore(pool),
    campaigns: new PgCampaignStore(pool),
    frequency: new PgFrequencyStore(pool),
    quality: new PgQualityProvider(pool),
    numeroDelieEnBase: async () => false,
    moteur: { noterEnvoi: creerNoteurEnvois(pool) },
  });

  /** Une campagne d'un contact, par le chemin de création réel. */
  const campagneDUnContact = async (
    nom: string,
    tel: string,
    options: { canal?: 'whatsapp' | 'rcs' } = {},
  ): Promise<{ campaignId: string; contactId: string }> => {
    const contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, $3) returning id`,
      [tenantId, tel, 'opted_in'],
    )).rows[0]!.id;
    const { campaignId } = await repo.createWithRecipients(
      {
        tenantId, phoneNumberId: 'pn-journal', name: nom, category: 'marketing',
        templateName: 'promo', templateLanguage: 'fr', paramMapping: [],
        ...(options.canal ? { channel: options.canal } : {}),
      },
      [{ contactId, toE164: tel, resolvedParams: [] }],
    );
    return { campaignId, contactId };
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    repo = new PgCampaignRepo(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-journal-envois') returning id`,
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) {
      // `campaign_envois` et `campaign_recipients` partent en cascade avec la campagne.
      await pool.query('delete from campaigns where tenant_id = $1', [tenantId]);
      await pool.query('delete from contacts where tenant_id = $1', [tenantId]);
      await pool.query('delete from tenants where id = $1', [tenantId]);
    }
    await pool.end();
  });

  it('un envoi reussi ecrit UNE ligne de journal, et le destinataire reste UNIQUE', async () => {
    const { campaignId, contactId } = await campagneDUnContact('journal-succes', '+33600001001');
    const rapport = await campaignRunJob({ campaignId }, deps(new SenderQuiPasse()));
    expect(rapport).toMatchObject({ sent: 1, failed: 0, skipped: 0 });

    const envois = await journal(campaignId);
    const contacts = await destinataires(campaignId);
    // 🔴 LES DEUX COMPTES, CÔTE À CÔTE, PARCE QUE C'EST LEUR RAPPORT QUI EST L'INVARIANT. Une tentative
    // journalisée, un destinataire : le journal s'ajoute, il ne remplace ni ne duplique rien.
    expect(envois).toHaveLength(1);
    expect(contacts).toHaveLength(1);
    expect(envois[0]).toMatchObject({ rang: 1, canal: 'whatsapp', statut: 'sent', contact_id: contactId });
    // Le journal porte le MÊME identifiant de message que le destinataire : c'est par lui que l'accusé
    // de Meta retrouvera les deux lignes, et une divergence ici rendrait le journal inaccusable.
    expect(envois[0]?.message_id).toBe(contacts[0]?.message_id);
    expect(envois[0]?.message_id).toBe('wamid-+33600001001');
  });

  it('un echec d envoi est journalise AUSSI, avec son motif', async () => {
    const { campaignId } = await campagneDUnContact('journal-echec', '+33600001002');
    const rapport = await campaignRunJob({ campaignId }, deps(new SenderQuiRefuse()));
    expect(rapport).toMatchObject({ sent: 0, failed: 1 });

    const envois = await journal(campaignId);
    // ⚠️ C'EST LE CHEMIN LE PLUS IMPORTANT DU LOT, et c'est celui qu'on oublie le plus facilement. Un
    // journal qui ne noterait que les succès rendrait un funnel par canal où aucun canal n'échoue
    // jamais, donc où le repli n'aurait aucune raison d'exister.
    expect(envois).toHaveLength(1);
    expect(envois[0]).toMatchObject({ statut: 'failed', canal: 'whatsapp', rang: 1 });
    expect(envois[0]?.error).toContain('refus simule');
    expect(envois[0]?.message_id).toBeNull();
  });

  it('un destinataire ECARTE PAR LE CANAL est journalise en `saute`, pas en `failed`', async () => {
    const { campaignId } = await campagneDUnContact('journal-ecarte', '+33600001003', { canal: 'rcs' });
    const rapport = await campaignRunJob({ campaignId }, deps(new SenderQuiPasse(), {
      sendTo: async () => ({ skipped: 'non joignable en RCS' }),
    }));
    expect(rapport).toMatchObject({ sent: 0, skipped: 1, failed: 0 });

    const envois = await journal(campaignId);
    expect(envois).toHaveLength(1);
    // 🔴 `saute` ET PAS `failed` : personne n'a essayé de joindre cette personne. Les confondre ferait
    // apparaître un canal comme défaillant alors qu'il n'a rien tenté, et c'est sur ce chiffre-là qu'on
    // déciderait de le remplacer par un autre.
    expect(envois[0]?.statut).toBe('saute');
  });

  it('une campagne RCS journalise sur SON canal, pas sur WhatsApp', async () => {
    const { campaignId } = await campagneDUnContact('journal-rcs', '+33600001004', { canal: 'rcs' });
    await campaignRunJob({ campaignId }, deps(new SenderQuiPasse(), {
      sendTo: async () => ({ messageId: 'rcs-0001004' }),
    }));
    const envois = await journal(campaignId);
    expect(envois).toHaveLength(1);
    // ⚠️ Le canal du journal vient de la CAMPAGNE, pas d'un défaut : c'est cette colonne qui ventilera le
    // funnel, et un `whatsapp` écrit ici rangerait des envois RCS dans le mauvais seau pour toujours.
    expect(envois[0]).toMatchObject({ canal: 'rcs', statut: 'sent', message_id: 'rcs-0001004' });
  });

  it('un re-run n ajoute AUCUNE ligne : plus aucun destinataire a resoudre', async () => {
    const { campaignId } = await campagneDUnContact('journal-rerun', '+33600001005');
    await campaignRunJob({ campaignId }, deps(new SenderQuiPasse()));
    expect(await journal(campaignId)).toHaveLength(1);
    // ⚠️ Le journal est en AJOUT SEUL : si l'idempotence du run se relâchait, il grossirait sans limite
    // et le funnel par canal compterait plusieurs fois la même personne. C'est le seul endroit du dépôt
    // où cette régression serait visible en chiffres plutôt qu'en messages réellement partis.
    await campaignRunJob({ campaignId }, deps(new SenderQuiPasse()));
    expect(await journal(campaignId)).toHaveLength(1);
  });

  it('l accuse de Meta met a jour LES DEUX tables, dans la meme instruction', async () => {
    const { campaignId } = await campagneDUnContact('journal-livraison', '+33600001006');
    await campaignRunJob({ campaignId }, deps(new SenderQuiPasse()));
    const recipients = new PgRecipientStore(pool);

    const touche = await recipients.updateDeliveryByMessageId('wamid-+33600001006', 'delivered', null, null);
    // ⚠️ LE COMPTE RENDU RESTE CELUI DES DESTINATAIRES, pas la somme des deux tables : l'appelant
    // (le webhook de livraison) lit ce nombre comme « ce wamid est-il à nous ? ».
    expect(touche).toBe(1);
    expect((await destinataires(campaignId))[0]?.delivery_status).toBe('delivered');
    // 🔴 SANS CETTE SECONDE ÉCRITURE, LA COLONNE DU JOURNAL SERAIT NULLE POUR TOUJOURS, et le funnel par
    // canal annoncerait « aucun accusé » sur toutes les campagnes, ce qui est le mensonge exact que la
    // distinction « zéro contre on ne sait pas » existe pour empêcher.
    expect((await journal(campaignId))[0]?.delivery_status).toBe('delivered');

    // La monotonie vaut des deux côtés : un `delivered` en retard ne rabaisse pas un `read`.
    await recipients.updateDeliveryByMessageId('wamid-+33600001006', 'read', null, null);
    await recipients.updateDeliveryByMessageId('wamid-+33600001006', 'delivered', null, null);
    expect((await destinataires(campaignId))[0]?.delivery_status).toBe('read');
    expect((await journal(campaignId))[0]?.delivery_status).toBe('read');

    // Un wamid qui n'est pas à nous ne touche rien, et le dit.
    expect(await recipients.updateDeliveryByMessageId('wamid-inconnu', 'read', null, null)).toBe(0);
  });
});
