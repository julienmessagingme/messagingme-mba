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
    /**
     * 🔴 `sent_at` DU DESTINATAIRE POSÉ UNE MILLISECONDE APRÈS CELUI DE SA TENTATIVE, DÉLIBÉRÉMENT.
     *
     * Les deux colonnes décrivent le MÊME départ mais ne sont pas écrites par la même horloge :
     * `markResult` pose l'horloge JS du moteur, la ligne de journal prend le `now()` de Postgres à
     * l'INSERT qui suit. Elles diffèrent donc toujours de quelques millisecondes, dans un sens que rien ne
     * garantit. Le sens choisi ici est le DÉFAVORABLE, celui où la ligne du destinataire est postérieure à
     * sa propre tentative : c'est lui qui faisait attraper la ligne par sa propre garde anti-intercalation
     * et refuser toute attribution (`repondus` à 0 partout, CI rouge du 2026-09-12).
     *
     * ⚠️ NE PAS « SIMPLIFIER » EN POSANT LES DEUX INSTANTS ÉGAUX : l'inégalité de la garde est stricte,
     * donc à instants égaux le défaut ne se reproduit pas et ce test redeviendrait vert sur le code fautif.
     */
    await pool.query(
      `update campaign_recipients set status = 'sent', message_id = 'rcs-1', delivery_status = 'read',
              sent_at = (select sent_at + interval '1 millisecond' from campaign_envois
                          where campaign_id = $2 and canal = 'rcs')
         where id = $1`,
      [recipientId, campaignId],
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

  it('🔴 la reponse va au SEUL canal qui a livre, et le funnel GLOBAL la voit aussi', async () => {
    const f = await stats.getCampaignFunnel(tenantId, campaignId);
    // La somme des réponses par canal vaut 1, pas 2 : c'est le double-comptage que l'attribution empêche.
    expect(f.parCanal.reduce((n, l) => n + l.repondus, 0)).toBe(1);

    /**
     * 🔴 ET LE FUNNEL GLOBAL REND 1 DEPUIS LE 2026-09-12. Ce test a affirmé `0` pendant un lot, avec sa
     * raison : `entrantAttribue` comparait l'entrant à `c.channel`, le canal DÉCLARÉ de la campagne, qui
     * cesse d'être la vérité du canal dès qu'une chaîne existe. La réponse arrivait en RCS, la campagne se
     * déclarait WhatsApp, et deux chiffres du MÊME écran se contredisaient.
     *
     * ⚠️ CE QUI A ÉTÉ ÉLARGI, ET CE QUI NE L'A PAS ÉTÉ. Le terme d'origine est intact : une campagne sans
     * chaîne, ou d'avant la migration 0134 (donc sans aucune ligne de journal), compte exactement comme
     * avant. Ce qui s'ajoute, ce sont les canaux sur lesquels une tentative est RÉELLEMENT PARTIE vers CE
     * destinataire. C'est ce que le test voisin du même fichier vérifie dans l'autre sens : une suggestion
     * RCS reçue par ailleurs, sur une campagne WhatsApp qui n'a jamais écrit en RCS, ne compte toujours pas.
     */
    expect(f.replied).toBe(1);

    /**
     * 🔴 ET L'INVARIANT ENTRE LES DEUX GRAINS REDEVIENT GÉNÉRAL : la somme des réponses par canal ne
     * dépasse jamais le `replied` du funnel global. Il était borné aux campagnes mono-canal par le lot
     * précédent, précisément à cause de ce manque ; c'est ICI, sur une campagne à DEUX canaux, qu'il
     * fallait le remettre pour que sa réparation soit démontrée.
     */
    expect(f.parCanal.reduce((n, l) => n + l.repondus, 0)).toBeLessThanOrEqual(f.replied);
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

  it('🔴 DEUX tentatives sur le MEME canal ne se partagent pas la reponse : elle va a la DERNIERE', async () => {
    /**
     * LE CAS QUE `campaign_recipients` NE SAIT PAS EXPRIMER, et qui existe DEJA en production.
     *
     * L'auto-relance (`resetForRetry`) remet un destinataire en `pending` : le moteur repart, et une
     * SECONDE tentative s'inscrit au journal sur le meme canal, pour la meme personne. La table des
     * destinataires, elle, n'a toujours qu'UNE ligne : elle est incapable de dire qu'il y a eu deux
     * departs, donc sa garde anti-intercalation ne peut pas empecher les deux tentatives de reclamer la
     * meme reponse. Sans la garde lue sur le JOURNAL, `repondus` vaudrait 2 pour une personne qui a ecrit
     * une seule fois, et depasserait le `replied` du funnel global sur le meme ecran.
     *
     * ⚠️ Ce test ne depend d'AUCUNE chaine d'etages : il est vrai du produit tel qu'il tourne aujourd'hui.
     */
    const c4 = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-funnel', name: 'funnel-relance', category: 'utility',
      templateName: 't', templateLanguage: 'fr', paramMapping: [],
    });
    await repo.insertRecipients(c4, [{ contactId, toE164: TEL, resolvedParams: [] }]);
    const r4 = (await pool.query<{ id: string }>(
      `select id from campaign_recipients where campaign_id = $1`, [c4],
    )).rows[0]!.id;
    // Deux departs REELS sur le meme canal, a 20 et 10 minutes, puis la reponse a 5 minutes.
    for (const [quand, wamid] of [['20 minutes', 'wa-1'], ['10 minutes', 'wa-2']] as const) {
      await pool.query(
        `insert into campaign_envois (campaign_id, recipient_id, contact_id, rang, canal, statut, message_id, sent_at)
         values ($1, $2, $3, 1, 'whatsapp', 'sent', $4, now() - ($5::text)::interval)`,
        [c4, r4, contactId, wamid, quand],
      );
    }
    await pool.query(
      `update campaign_recipients set status = 'sent', message_id = 'wa-2', delivery_status = 'delivered',
              sent_at = (select max(sent_at) + interval '1 millisecond' from campaign_envois where campaign_id = $2)
         where id = $1`,
      [r4, c4],
    );
    await entrant('5 minutes', 'whatsapp');

    const f = await stats.getCampaignFunnel(tenantId, c4);
    /**
     * 🔴 L'INVARIANT QUI SURVIT PARTOUT, ET C'EST CELUI-CI QU'IL FAUT RETENIR : au sein d'UN canal, deux
     * tentatives ne se partagent JAMAIS une réponse. UNE ligne (même canal), DEUX tentatives parties, UNE
     * seule réponse comptée. Il ne dépend d'aucune hypothèse sur la campagne, et c'est lui que la garde
     * lue sur le journal achète.
     */
    expect(f.parCanal).toHaveLength(1);
    expect(f.parCanal[0]).toMatchObject({ canal: 'whatsapp', envois: 2, reussis: 2, repondus: 1 });

    /**
     * 🔴 L'INVARIANT ENTRE LES DEUX GRAINS : la somme des réponses par canal ne dépasse jamais le
     * `replied` du funnel global, parce que les deux chiffres sont côte à côte sur le même écran.
     *
     * ⚠️ IL A ÉTÉ BORNÉ AUX CAMPAGNES MONO-CANAL PENDANT UN LOT, et c'était honnête : il était FAUX sur
     * une campagne à chaîne (somme 1, `replied` 0), parce que les deux compteurs ne filtraient pas le
     * même canal, le global sur `c.channel` et la ventilation sur `e.canal`. Le manque a été fermé le
     * 2026-09-12 et l'invariant est redevenu GÉNÉRAL : il est de nouveau vérifié sur le test à deux
     * canaux, et le garder ici aussi n'est pas un doublon (une campagne mono-canal n'emprunte pas le
     * terme élargi de l'attribution, donc ce cas-ci l'exerce sur l'autre moitié de la disjonction).
     */
    expect(f.parCanal.reduce((n, l) => n + l.repondus, 0)).toBeLessThanOrEqual(f.replied);
    expect(f.replied).toBe(1);
    expect(f.contactsVises).toBe(1);
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
