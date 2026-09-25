import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCampaignRepo } from '../../src/campaign/store.pg';
import { buildContactWhere } from '../../src/crm/contact-store.pg';
import { runRetrySweep, type RetrySweepDeps } from '../../src/campaign/retry-sweep';
import { creerNoteurJoignabilite } from '../../src/contacts/joignabilite.pg';
import { verdictWhatsApp } from '../../src/contacts/joignabilite';

/**
 * LA JOIGNABILITÉ WHATSAPP MÉMORISÉE CHEZ NOUS (migration 0133).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT, ET QUI NE SE PROUVE PAS SANS BASE. Le verdict « ce numéro n'a pas
 * WhatsApp » était DÉJÀ calculé par le balayage de relance, et il partait uniquement dans HubSpot : un
 * espace sans HubSpot le jetait, un espace avec HubSpot le rangeait chez un tiers d'où il ne revient pas.
 * Ce qu'on vérifie ici, c'est qu'il atterrit sur la ligne `contacts`, avec sa date, et que le second
 * balayage n'a PLUS besoin de HubSpot pour aller au bout.
 *
 * ⚠️ Les colonnes et l'index viennent de la migration 0133 : ce fichier échoue tant qu'elle n'est pas
 * appliquée, et c'est voulu (une migration qui AJOUTE une colonne écrite par le code passe AVANT le
 * déploiement).
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et ce
 * fichier crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

const E164 = '+33600000133';

describe.skipIf(!url)('joignabilite WhatsApp memorisee', () => {
  let pool: Pool;
  let repo: PgCampaignRepo;
  let noter: ReturnType<typeof creerNoteurJoignabilite>;
  let tenantId = '';
  let autreTenantId = '';
  let contactId = '';
  let campaignId = '';
  let recipientId = '';

  /** Les deux colonnes telles qu'elles sont EN BASE, sans passer par une couche qui pourrait les inventer. */
  const lire = async (id: string, tid: string): Promise<{ valeur: boolean | null; le: Date | null }> => {
    const { rows } = await pool.query<{ whatsapp_joignable: boolean | null; whatsapp_joignable_le: Date | null }>(
      `select whatsapp_joignable, whatsapp_joignable_le from contacts where tenant_id = $1 and id = $2`,
      [tid, id],
    );
    const r = rows[0]!;
    return { valeur: r.whatsapp_joignable, le: r.whatsapp_joignable_le };
  };

  /** Remet le destinataire dans l'état « 2e échec 131026 », le seul que le balayage clôt en injoignable. */
  const armerSecondEchec = async (): Promise<void> => {
    await pool.query(
      `update campaign_recipients
          set status = 'sent', delivery_status = 'failed', error_code = 131026, retry_count = 1
        where id = $1`,
      [recipientId],
    );
  };

  /** Le câblage RÉEL du balayage sur la base de test. `over` ne sert qu'à couper ce qu'on veut isoler. */
  const deps = (over: Partial<RetrySweepDeps> = {}): RetrySweepDeps => ({
    isMorningWindow: () => false,
    list131049: () => repo.listRetry131049(Date.now()),
    list131026: () => repo.listRetry131026(),
    list131026SecondFail: () => repo.listRetry131026SecondFail(),
    resetForRetry: (id) => repo.resetForRetry(id),
    markUnreachableDone: (id) => repo.markUnreachableDone(id),
    // Les heures d'ouverture ne sont pas le sujet de ce fichier : la fenêtre est ouverte, comme elle
    // l'est pour un espace aux horaires par défaut en pleine journée.
    fenetreOuverte: async () => true,
    // ⚠️ La passe de bascule est câblée sur le VRAI dépôt, pas sur un bouchon : la campagne de ce
    // fichier n'a qu'un étage, donc elle ne bascule rien, mais la requête est bel et bien exécutée à
    // chaque balayage. Un bouchon aurait fait passer ces tests avec un SQL qui ne compile pas.
    listCandidatsBascule: () => repo.listCandidatsBascule(),
    basculerEtage: (id, rang) => repo.basculerEtage(id, rang),
    enqueueRun: async () => {},
    // Le no-op de l'espace SANS HubSpot, tel que `src/worker.ts` le construit : il ne fait rien et il RÉUSSIT.
    flagUnreachable: async () => {},
    noterJoignabilite: noter,
    ...over,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    repo = new PgCampaignRepo(pool);
    noter = creerNoteurJoignabilite(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-joignabilite') returning id`,
    )).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-joignabilite-autre') returning id`,
    )).rows[0]!.id;
    // Le balayage ne touche QUE les espaces qui ont activé l'auto-relance : sans ça, il ne listerait rien.
    await pool.query(
      `insert into tenant_settings (tenant_id, auto_retry_enabled) values ($1, true)
       on conflict (tenant_id) do update set auto_retry_enabled = true`,
      [tenantId],
    );
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`,
      [tenantId, E164],
    )).rows[0]!.id;
    campaignId = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-joign', name: 'joignabilite', category: 'marketing',
      templateName: 't', templateLanguage: 'fr', paramMapping: [],
    });
    await repo.insertRecipients(campaignId, [{ contactId, toE164: E164, resolvedParams: ['X'] }]);
    recipientId = (await pool.query<{ id: string }>(
      `select id from campaign_recipients where campaign_id = $1`,
      [campaignId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await pool.query('delete from campaign_recipients where campaign_id in (select id from campaigns where tenant_id = $1)', [tenantId]);
      await pool.query('delete from campaigns where tenant_id = $1', [tenantId]);
      await pool.query('delete from tenant_settings where tenant_id = $1', [tenantId]);
      await pool.query('delete from tenants where id = $1', [tenantId]);
    }
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('un contact jamais sollicite est INCONNU, pas injoignable', async () => {
    const { valeur, le } = await lire(contactId, tenantId);
    // 🔴 `null`, pas `false` : c'est toute la raison d'être d'une colonne nullable. Le verdict le dit aussi,
    // et il le dit en étant exécuté sur ce que la BASE rend, pas sur des valeurs fabriquées à la main.
    expect(valeur).toBeNull();
    expect(le).toBeNull();
    expect(verdictWhatsApp(valeur, le, new Date())).toBe('inconnu');
  });

  it('le second echec 131026 ecrit la joignabilite CHEZ NOUS, pas seulement dans HubSpot', async () => {
    await armerSecondEchec();
    // Le destinataire porte bien son contact : c'est lui qui désigne la ligne à écrire.
    const listes = await repo.listRetry131026SecondFail();
    expect(listes.find((r) => r.id === recipientId)?.contactId).toBe(contactId);

    const res = await runRetrySweep(deps());
    expect(res.flagged).toBe(1);

    const { valeur, le } = await lire(contactId, tenantId);
    expect(valeur).toBe(false);
    expect(le).not.toBeNull();
    // Exécuté PAR LE VRAI CODE sur ce que la base rend : `pg` sert un `boolean` et un `Date`, qui sont
    // exactement ce que la règle attend. Une colonne rendue en texte donnerait `'oui'` sur `'false'`.
    expect(verdictWhatsApp(valeur, le, new Date())).toBe('non');
  });

  it('sans HubSpot, le destinataire est quand meme CLOS : le balayage n en depend plus', async () => {
    // La clôture (retry_count = 2) est ce qui empêche de re-traiter le même injoignable à chaque tour. Elle
    // vient de passer avec un `flagUnreachable` qui ne fait RIEN, ce qui est l'état d'un espace sans CRM.
    const { rows } = await pool.query<{ retry_count: number }>(
      `select retry_count from campaign_recipients where id = $1`,
      [recipientId],
    );
    expect(rows[0]!.retry_count).toBe(2);
    expect((await repo.listRetry131026SecondFail()).map((r) => r.id)).not.toContain(recipientId);
  });

  it('un flag HubSpot en echec ne clot rien ET ne note rien : l ordre tient sur la vraie base', async () => {
    // On repart d'un second échec, et cette fois le CRM est en panne.
    await pool.query(`update contacts set whatsapp_joignable = null, whatsapp_joignable_le = null where id = $1`, [contactId]);
    await armerSecondEchec();
    const res = await runRetrySweep(deps({ flagUnreachable: async () => { throw new Error('connecteur down'); } }));
    expect(res.flagged).toBe(0);
    // 🔴 RIEN n'a bougé, donc RIEN n'est perdu : le destinataire reste listé et repassera au tour suivant.
    const { valeur } = await lire(contactId, tenantId);
    expect(valeur).toBeNull();
    expect((await repo.listRetry131026SecondFail()).map((r) => r.id)).toContain(recipientId);
  });

  it('le noteur est SCOPÉ PAR ESPACE : le mauvais tenant n ecrit rien', async () => {
    await pool.query(`update contacts set whatsapp_joignable = null, whatsapp_joignable_le = null where id = $1`, [contactId]);
    // ⚠️ Le pooler est superuser, la RLS est contournée : `tenant_id = $1` est le SEUL contrôle d'isolation.
    // Une requête qui l'oublierait passerait ce test sans lui, et écrirait chez le voisin en production.
    await noter(autreTenantId, contactId, false);
    expect((await lire(contactId, tenantId)).valeur).toBeNull();
    await noter(tenantId, contactId, true);
    expect((await lire(contactId, tenantId)).valeur).toBe(true);
  });

  it('le filtre d audience : la TABLE DE VERITE, evaluee par Postgres et pas par une chaine', async () => {
    // 🔴 UN TEST SUR LE TEXTE DU SQL NE PROUVE PAS SON SENS. `is not false` et `is not true` se ressemblent,
    // et seule une vraie base dit lequel garde qui. Quatre contacts, les quatre etats possibles.
    const mk = async (tel: string, valeur: boolean | null, jours: number | null): Promise<string> => {
      const { rows } = await pool.query<{ id: string }>(
        `insert into contacts (tenant_id, phone_e164, opt_in_status, whatsapp_joignable, whatsapp_joignable_le)
         values ($1, $2, 'opted_in', $3, case when $4::int is null then null else now() - ($4::int * interval '1 day') end)
         returning id`,
        [tenantId, tel, valeur, jours],
      );
      return rows[0]!.id;
    };
    const jamais = await mk('+33600000201', null, null);
    const injoignableFrais = await mk('+33600000202', false, 10);
    const injoignablePerime = await mk('+33600000203', false, 91);
    const joignable = await mk('+33600000204', true, 10);
    const sansDate = await mk('+33600000205', false, null);

    const { where, params } = buildContactWhere(tenantId, { joignabiliteWhatsApp: 'connu_injoignable' });
    const { rows } = await pool.query<{ id: string }>(`select id from contacts where ${where}`, params);
    const gardes = new Set(rows.map((r) => r.id));

    // Le SEUL exclu est celui qu'on SAIT injoignable, sur une mesure encore valide.
    expect(gardes.has(injoignableFrais)).toBe(false);
    // 🔴 Les quatre autres passent, et chacun pour sa raison : jamais mesure, mesure perimee (elle redevient
    // inconnue), mesure sans instant (ce n est pas une mesure), et joignable avere.
    expect(gardes.has(jamais)).toBe(true);
    expect(gardes.has(injoignablePerime)).toBe(true);
    expect(gardes.has(sansDate)).toBe(true);
    expect(gardes.has(joignable)).toBe(true);

    await pool.query(`delete from contacts where id = any($1::uuid[])`, [[jamais, injoignableFrais, injoignablePerime, joignable, sansDate]]);
  });

  it('l index partiel de 0133 existe, avec SON predicat', async () => {
    // Un index partiel est un CONTRAT AVEC UNE REQUÊTE : « qui sait-on injoignable », jamais « qui sait-on
    // joignable ». Le créer plein coûterait pour rien, et changer son prédicat ne produirait aucune erreur.
    const { rows } = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'contacts' and indexname = 'contacts_whatsapp_injoignable_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain('WHERE (whatsapp_joignable = false)');
  });
});
