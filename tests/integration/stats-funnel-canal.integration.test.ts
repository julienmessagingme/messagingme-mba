import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgStatsStore } from '../../src/stats/store.pg';
import { PgCampaignRepo } from '../../src/campaign/store.pg';

/**
 * LE FUNNEL PAR CANAL (migration 0134).
 *
 * 🔴 CE QU'IL PROTÈGE, ET QU'AUCUN TEST UNITAIRE NE PEUT PROTÉGER. Tout le sujet est un `group by` sur une
 * table jointe à deux autres, avec une attribution de réponse qui compare des instants : c'est du SQL, et
 * seul Postgres dit ce qu'il calcule. Le cas décisif est celui d'UN humain passé par DEUX canaux, où trois
 * chiffres doivent tomber juste en même temps : deux lignes de ventilation (pas une), la réponse portée au
 * SEUL canal qui a livré (pas aux deux, pas au premier), et une ligne de tête qui compte UNE personne.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et ce
 * fichier crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

const TEL = '+33600001100';
const WA = '33600001100';

describe.skipIf(!url)('le funnel par canal (0134)', () => {
  let pool: Pool;
  let stats: PgStatsStore;
  let repo: PgCampaignRepo;
  let tenantId = '';
  let autreTenant = '';
  let contactId = '';
  let campaignId = '';
  let recipientId = '';

  /**
   * Une tentative écrite DIRECTEMENT dans le journal.
   *
   * ⚠️ À LA MAIN, ET C'EST LE BON CHOIX ICI : le moteur d'aujourd'hui ne sait pas basculer de canal (c'est
   * le lot suivant), donc le scénario à deux étages est impossible à produire par le chemin réel. Ce qu'on
   * mesure est la LECTURE, pas l'écriture ; l'écriture est couverte par
   * `campagne-envois.integration.test.ts`, qui elle passe par le vrai moteur.
   */
  const tentative = async (t: {
    rang: number; canal: string; statut: string; quand: string;
    messageId?: string | null; livraison?: string | null;
  }): Promise<void> => {
    await pool.query(
      `insert into campaign_envois (campaign_id, recipient_id, contact_id, rang, canal, statut, message_id, delivery_status, sent_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now() - ($9::text)::interval)`,
      [campaignId, recipientId, contactId, t.rang, t.canal, t.statut, t.messageId ?? null, t.livraison ?? null, t.quand],
    );
  };

  /** Un message ENTRANT du contact, daté relativement à maintenant, sur un canal donné. */
  const entrant = async (quand: string, canal: string): Promise<void> => {
    const conversationId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2)
       on conflict (tenant_id, wa_id) do update set wa_id = excluded.wa_id returning id`,
      [tenantId, WA],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, channel, created_at)
       values ($1, 'in', 'text', 'merci', $2, now() - ($3::text)::interval)`,
      [conversationId, canal, quand],
    );
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    stats = new PgStatsStore(pool);
    repo = new PgCampaignRepo(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-funnel-canal') returning id`,
    )).rows[0]!.id;
    autreTenant = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-funnel-canal-autre') returning id`,
    )).rows[0]!.id;
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`,
      [tenantId, TEL],
    )).rows[0]!.id;
    campaignId = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-funnel', name: 'funnel-canal', category: 'marketing',
      templateName: 'promo', templateLanguage: 'fr', paramMapping: [],
    });
    await repo.insertRecipients(campaignId, [{ contactId, toE164: TEL, resolvedParams: [] }]);
    recipientId = (await pool.query<{ id: string }>(
      `select id from campaign_recipients where campaign_id = $1`, [campaignId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await pool.query('delete from campaigns where tenant_id = $1', [tenantId]);
      await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
      await pool.query('delete from contacts where tenant_id = $1', [tenantId]);
      await pool.query('delete from tenants where id = $1', [tenantId]);
    }
    if (autreTenant) await pool.query('delete from tenants where id = $1', [autreTenant]);
    await pool.end();
  });

  it('un contact passe par deux canaux donne DEUX lignes de funnel, pas une', async () => {
    // Destinataire : échec WhatsApp (131026) puis succès RCS, ce dernier délivré, lu, et suivi d'une
    // réponse. Le destinataire porte le résultat du DERNIER étage, comme en production.
    await tentative({ rang: 1, canal: 'whatsapp', statut: 'failed', quand: '3 hours' });
    await tentative({ rang: 2, canal: 'rcs', statut: 'sent', quand: '2 hours', messageId: 'rcs-1', livraison: 'read' });
    await pool.query(
      `update campaign_recipients set status = 'sent', message_id = 'rcs-1', sent_at = now() - interval '2 hours',
              delivery_status = 'read' where id = $1`,
      [recipientId],
    );
    await entrant('1 hour', 'rcs');

    const f = await stats.getCampaignFunnel(tenantId, campaignId);
    expect(f.parCanal).toEqual([
      { canal: 'whatsapp', envois: 1, reussis: 0, delivres: 0, lus: 0, repondus: 0, sansAccuse: 0 },
      { canal: 'rcs', envois: 1, reussis: 1, delivres: 1, lus: 1, repondus: 1, sansAccuse: 0 },
    ]);
    // 🔴 La ligne de tête reste au grain CONTACT : un seul humain a été visé.
    expect(f.contactsVises).toBe(1);
    // 🔴 ET L'ORDRE EST CELUI DE LA CHAÎNE, pas l'alphabet : WhatsApp est au rang 1, RCS au rang 2, donc
    // WhatsApp d'abord. En ordre alphabétique, RCS passerait devant et la ventilation se lirait à l'envers.
    expect(f.parCanal.map((l) => l.canal)).toEqual(['whatsapp', 'rcs']);
  });

  it('🔴 la reponse va au SEUL canal qui a livre, elle n est comptee ni deux fois ni au mauvais', async () => {
    const f = await stats.getCampaignFunnel(tenantId, campaignId);
    // La somme des réponses par canal vaut 1, pas 2 : c'est le double-comptage que l'attribution empêche.
    expect(f.parCanal.reduce((n, l) => n + l.repondus, 0)).toBe(1);
    // Et le funnel GLOBAL dit la même chose sur la même personne : les deux grains ne se contredisent pas.
    expect(f.replied).toBe(1);
  });

  it('🔴 la somme des canaux DEPASSE le nombre de personnes, et c est juste', async () => {
    const f = await stats.getCampaignFunnel(tenantId, campaignId);
    // Deux tentatives pour un humain. C'est exactement pourquoi `contactsVises` ne se déduit PAS de
    // `parCanal` : additionner les canaux répondrait à une autre question que « combien de gens ».
    expect(f.parCanal.reduce((n, l) => n + l.envois, 0)).toBe(2);
    expect(f.contactsVises).toBe(1);
  });

  it('🔴 un canal SANS AUCUN accuse se distingue d un canal a zero', async () => {
    // Une seconde campagne, à scénario : ses envois partent avec un identifiant synthétique que l'accusé
    // de Meta ne peut jamais apparier, donc `delivery_status` reste null pour toujours.
    const c2 = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-funnel', name: 'funnel-sans-accuse', category: 'utility',
      templateName: 't', templateLanguage: 'fr', paramMapping: [],
    });
    await repo.insertRecipients(c2, [{ contactId, toE164: TEL, resolvedParams: [] }]);
    const r2 = (await pool.query<{ id: string }>(
      `select id from campaign_recipients where campaign_id = $1`, [c2],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_envois (campaign_id, recipient_id, contact_id, rang, canal, statut, message_id)
       values ($1, $2, $3, 1, 'whatsapp', 'sent', 'wf-synthetique')`,
      [c2, r2, contactId],
    );

    const f = await stats.getCampaignFunnel(tenantId, c2);
    const wa = f.parCanal.find((l) => l.canal === 'whatsapp');
    // 🔴 `reussis` vaut 1 et `sansAccuse` vaut 1 : le canal a bien envoyé, et on ne sait RIEN de la suite.
    // C'est cette égalité que l'écran lit pour afficher « — » plutôt qu'un « 0 délivré » qu'on croirait.
    expect(wa).toMatchObject({ envois: 1, reussis: 1, delivres: 0, lus: 0, sansAccuse: 1 });
    expect(wa!.sansAccuse).toBe(wa!.reussis);
  });

  it('une tentative ECHOUEE ne peut pas avoir provoque de reponse', async () => {
    // Une campagne dont le seul envoi a échoué, suivie d'un message entrant du même contact.
    const c3 = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-funnel', name: 'funnel-echec-seul', category: 'utility',
      templateName: 't', templateLanguage: 'fr', paramMapping: [],
    });
    await repo.insertRecipients(c3, [{ contactId, toE164: TEL, resolvedParams: [] }]);
    const r3 = (await pool.query<{ id: string }>(
      `select id from campaign_recipients where campaign_id = $1`, [c3],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_envois (campaign_id, recipient_id, contact_id, rang, canal, statut, sent_at)
       values ($1, $2, $3, 1, 'whatsapp', 'failed', now() - interval '5 minutes')`,
      [c3, r3, contactId],
    );
    await entrant('1 minute', 'whatsapp');

    const f = await stats.getCampaignFunnel(tenantId, c3);
    // ⚠️ Sans la garde sur le statut, cette réponse serait portée au crédit du canal qui vient précisément
    // de ne pas fonctionner, et le repli paraîtrait inutile sur le chiffre qui doit le déclencher.
    expect(f.parCanal[0]).toMatchObject({ canal: 'whatsapp', envois: 1, reussis: 0, repondus: 0 });
  });

  it('🔴 la ventilation est SCOPEE A L ESPACE : campaign_envois ne porte pas de tenant_id', async () => {
    // Le pooler est superuser, la RLS est contournée : la jointure sur `campaigns` est le SEUL contrôle.
    // Une requête qui l'oublierait passerait tous les tests du dessus et rendrait les chiffres du voisin.
    const f = await stats.getCampaignFunnel(autreTenant, campaignId);
    expect(f.parCanal).toEqual([]);
    expect(f.contactsVises).toBe(0);
  });

  it('une campagne SANS journal rend une ventilation vide, pas des canaux a zero', async () => {
    // C'est l'état de toute campagne antérieure à la mise en service du journal : ses compteurs du haut
    // sont complets, sa ventilation est inconnue. L'écran doit se taire, pas annoncer « 0 envoi ».
    const ancienne = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-funnel', name: 'funnel-sans-journal', category: 'utility',
      templateName: 't', templateLanguage: 'fr', paramMapping: [],
    });
    const f = await stats.getCampaignFunnel(tenantId, ancienne);
    expect(f.parCanal).toEqual([]);
  });
});
