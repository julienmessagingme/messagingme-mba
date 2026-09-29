import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { PgPerformanceStore } from '../../src/stats/performance.pg';
import { addDays, todayParis } from '../../src/stats/range';
import type { DemandeBrute } from '../../src/stats/performance';

/**
 * QUANTITATIF > PERFORMANCE : ce que la base rend comme DEMANDES (migration 0194, `PgPerformanceStore.lire`).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT, ET QU'AUCUN TEST UNITAIRE NE VOIT : la définition d'une demande est écrite en SQL
 * (une ouverture n'en est une que si rien n'était ouvert ; son DÉBUT est l'ouverture si le client avait la balle,
 * sinon son premier message qui suit ; sa fin est le premier événement de fin qui suit ; sa réponse le premier
 * message d'origine `humain` entre le début et la fin). Les événements sont écrits par le VRAI dépôt de l'Inbox
 * quand c'est possible, pour prouver la chaîne entière ; directement en base pour les enchaînements que l'écriture
 * ne produit pas d'elle-même (deux passages sans fin entre eux).
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et ce fichier
 * crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`), migré juste avant :
 * la date d'application de 0194, borne basse de toute demande, précède donc tout ce que ce fichier écrit.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('les demandes du Quantitatif > Performance', () => {
  let pool: Pool;
  let inbox: PgInboxStore;
  let perf: PgPerformanceStore;
  let tenantId = '';
  let autreTenantId = '';
  let admin = '';
  let marie = '';
  let jean = '';
  // Large autour d'aujourd'hui : les écritures datées « maintenant plus quelques heures » restent dedans.
  const periode = () => ({ from: addDays(todayParis(), -1), to: addDays(todayParis(), 2) });

  const membre = async (tenant: string, email: string, nom: string, role: string) => (await pool.query<{ id: string }>(
    `insert into users (tenant_id, email, name, password_hash, role) values ($1, $2, $3, 'x', $4) returning id`,
    [tenant, email, nom, role],
  )).rows[0]!.id;

  let seq = 0;
  let msg = 0;
  /** Le contact écrit (ou tape un bouton) : un message entrant. */
  const ecrit = (waId: string, tenant = tenantId, type = 'text') => {
    msg += 1;
    return inbox.recordInbound(tenant, {
      phoneNumberId: 'pn-itest', waId, messageId: `wamid.perf-in-${msg}-${Date.now()}`, type, body: 'bonjour',
      buttonPayload: null, profileName: null, field: 'messages',
    });
  };
  const idDe = async (waId: string, tenant = tenantId): Promise<string> => (await pool.query<{ id: string }>(
    'select id from conversations where tenant_id = $1 and wa_id = $2', [tenant, waId],
  )).rows[0]!.id;
  const nouveauWaId = (): string => { seq += 1; return `3360000${String(seq).padStart(4, '0')}`; };
  /** Une conversation neuve, créée par un message du contact, et son identifiant. */
  const conversation = async (tenant = tenantId): Promise<{ waId: string; id: string }> => {
    const waId = nouveauWaId();
    await ecrit(waId, tenant);
    return { waId, id: await idDe(waId, tenant) };
  };
  /** Un envoi automatisé (campagne, scénario) : un modèle par défaut, comme le journal d'envoi l'écrit. */
  const robotEnvoie = (waId: string, origine: 'campagne' | 'scenario' | 'mba', type = 'template') => {
    msg += 1;
    return inbox.recordOutboundByWaId(tenantId, waId, { body: 'Bonjour !', messageId: `wamid.perf-out-${msg}-${Date.now()}`, type, origine });
  };

  /** Un scénario passe la main à l'équipe : l'événement `escaladee` (le geste `passerAUnHumain`). */
  const escalader = (waId: string, tenant = tenantId, escalade = true) => inbox.setControlOwner(tenant, waId, 'app_human', {
    par: { cause: 'automatique : scénario Bienvenue' }, only: ['app_workflow'], escalade, ouvreUneDemande: true,
  });
  /** L'instant de la dernière ouverture écrite, et celui du dernier message entrant, lus en base. */
  const ouvertureDe = async (id: string): Promise<Date> => (await pool.query<{ at: Date }>(
    `select at from conversation_evenements where conversation_id = $1 and type in ('escaladee', 'passee_par_mba') order by at desc, id desc limit 1`, [id],
  )).rows[0]!.at;
  const dernierEntrant = async (id: string): Promise<Date> => (await pool.query<{ created_at: Date }>(
    `select created_at from conversation_messages where conversation_id = $1 and direction = 'in' order by created_at desc limit 1`, [id],
  )).rows[0]!.created_at;
  /** Une réponse écrite dans l'Inbox par un collaborateur (origine `humain`, signée). */
  const repondre = (id: string, auteur: string) => inbox.recordOutbound(id, 'bonjour, je regarde', null, 'humain', 'text', null, null, auteur);

  const lire = async (tenant = tenantId): Promise<DemandeBrute[]> => (await perf.lire(tenant, periode())).demandes;
  const de = (demandes: DemandeBrute[], conversationId: string) => demandes.filter((d) => d.conversationId === conversationId);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    inbox = new PgInboxStore(pool);
    perf = new PgPerformanceStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-performance') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-performance-autre') returning id`)).rows[0]!.id;
    admin = await membre(tenantId, 'admin@perf.itest', 'Alice Admin', 'admin');
    marie = await membre(tenantId, 'marie@perf.itest', 'Marie', 'agent');
    jean = await membre(tenantId, 'jean@perf.itest', 'Jean', 'agent');
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  beforeEach(async () => {
    for (const t of [tenantId, autreTenantId]) {
      await pool.query('delete from conversations where tenant_id = $1', [t]);
      await pool.query('delete from contacts where tenant_id = $1', [t]);
    }
  });

  it('🔴 la mesure démarre à l’application de 0194, et la base la rend', async () => {
    const { mesureDepuis } = await perf.lire(tenantId, periode());
    expect(mesureDepuis).toBeInstanceOf(Date);
  });

  it('🔴 un scénario passe la main, Marie répond, Jean marque Traité : une demande, et les deux auteurs', async () => {
    const c = await conversation();
    expect(await escalader(c.waId)).toBe(true);
    await repondre(c.id, marie);
    await repondre(c.id, jean); // la SECONDE réponse ne compte pas
    expect(await inbox.marquerTraitee(tenantId, c.id, true, { collaborateur: jean })).toBe(true);
    const [d, ...reste] = de(await lire(), c.id);
    expect(reste).toEqual([]);
    expect(d!.repondant).toEqual({ genre: 'collaborateur', userId: marie, nom: 'Marie' });
    expect(d!.closePar).toEqual({ genre: 'collaborateur', userId: jean, nom: 'Jean' });
    expect(d!.reponduLe!.getTime()).toBeGreaterThanOrEqual(d!.debutLe.getTime());
    expect(d!.closeLe!.getTime()).toBeGreaterThanOrEqual(d!.reponduLe!.getTime());
    expect(d!.jour).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('🔴 une demande close par ARCHIVAGE sans réponse : pas de réponse, et la fin signée', async () => {
    const c = await conversation();
    await escalader(c.waId);
    expect(await inbox.archiverConversation(tenantId, c.id, true, { collaborateur: admin })).toBe(true);
    const [d] = de(await lire(), c.id);
    expect(d!.reponduLe).toBeNull();
    expect(d!.repondant).toBeNull();
    expect(d!.closePar).toEqual({ genre: 'collaborateur', userId: admin, nom: 'Alice Admin' });
  });

  it('🔴 un collaborateur qui prend le fil en ÉCRIVANT n’ouvre aucune demande', async () => {
    const c = await conversation();
    await inbox.setControlOwner(tenantId, c.waId, 'app_human', { par: { collaborateur: marie } });
    await repondre(c.id, marie);
    expect(de(await lire(), c.id)).toEqual([]);
  });

  it('🔴 DEUX passages sur la même conversation, séparés par une fin : deux demandes', async () => {
    const c = await conversation();
    await escalader(c.waId);
    await repondre(c.id, marie);
    // L'équipe rend le fil au scénario : `rendue_scenario`, une fin automatique.
    expect(await inbox.setControlOwner(tenantId, c.waId, 'app_workflow', { par: { cause: 'automatique : délai de reprise écoulé' } })).toBe(true);
    await escalader(c.waId);
    // La balle était à l'équipe (Marie avait répondu) : la seconde ne commence qu'au message suivant du client.
    expect(de(await lire(), c.id)).toHaveLength(1);
    await ecrit(c.waId);
    const ds = de(await lire(), c.id);
    expect(ds).toHaveLength(2);
    expect(ds[0]!.closePar).toEqual({ genre: 'automatique' });
    expect(ds[0]!.repondant).toEqual({ genre: 'collaborateur', userId: marie, nom: 'Marie' });
    // La seconde est encore ouverte, et la réponse de la PREMIÈRE ne lui est pas prêtée.
    expect(ds[1]!.closeLe).toBeNull();
    expect(ds[1]!.reponduLe).toBeNull();
  });

  it('🔴 un passage PENDANT une demande ouverte n’en ouvre pas une seconde', async () => {
    // L'écriture ne produit pas cet enchaînement d'elle-même (une escalade sur un fil déjà à l'équipe ne change rien) ;
    // la lecture doit pourtant le tenir, d'où des lignes posées à la main, à des instants explicites.
    const c = await conversation();
    await pool.query(
      `insert into conversation_evenements (tenant_id, conversation_id, type, cause, at) values
         ($1, $2, 'passee_par_mba', 'automatique : agent de Meta', now() + interval '1 minute'),
         ($1, $2, 'escaladee', 'automatique : scénario Bienvenue', now() + interval '2 minutes'),
         ($1, $2, 'traitee', 'automatique : test', now() + interval '10 minutes')`,
      [tenantId, c.id],
    );
    const ds = de(await lire(), c.id);
    expect(ds).toHaveLength(1);
    // Datée du PREMIER passage, close par la fin qui suit.
    expect(ds[0]!.closeLe!.getTime() - ds[0]!.debutLe.getTime()).toBe(9 * 60_000);
  });

  it('🔴 la réponse d’un assistant MCP, de l’API ou d’une campagne ne compte pas ; celle d’un collaborateur, si', async () => {
    const c = await conversation();
    await escalader(c.waId);
    await inbox.recordOutbound(c.id, 'réponse de l’assistant', null, 'mcp');
    await inbox.recordOutbound(c.id, 'réponse du système du client', null, 'api');
    await inbox.recordOutboundByWaId(tenantId, c.waId, { body: 'promo', messageId: `wamid.perf-camp-${Date.now()}`, origine: 'campagne' });
    expect(de(await lire(), c.id)[0]!.reponduLe).toBeNull();
    await repondre(c.id, jean);
    expect(de(await lire(), c.id)[0]!.repondant).toEqual({ genre: 'collaborateur', userId: jean, nom: 'Jean' });
  });

  it('une réponse écrite APRÈS la fin n’est pas la réponse de la demande', async () => {
    const c = await conversation();
    await escalader(c.waId);
    await inbox.marquerTraitee(tenantId, c.id, true, { collaborateur: marie });
    await repondre(c.id, marie);
    expect(de(await lire(), c.id)[0]!.reponduLe).toBeNull();
  });

  it('🔴 l’agent de Meta qui passe la main ouvre une demande (`passee_par_mba`)', async () => {
    const c = await conversation();
    await pool.query(`update conversations set control_owner = 'mba' where id = $1`, [c.id]);
    await inbox.marquerEscalade(tenantId, c.waId, 'automatique : agent de Meta');
    await repondre(c.id, marie);
    const ds = de(await lire(), c.id);
    expect(ds).toHaveLength(1);
    expect(ds[0]!.repondant).toEqual({ genre: 'collaborateur', userId: marie, nom: 'Marie' });
  });

  it('🔴 isolation : les demandes d’un autre espace ne remontent jamais', async () => {
    const ailleurs = await conversation(autreTenantId);
    await escalader(ailleurs.waId, autreTenantId);
    const ici = await conversation();
    await escalader(ici.waId);
    const demandes = await lire();
    expect(demandes.map((d) => d.conversationId)).toContain(ici.id);
    expect(demandes.map((d) => d.conversationId)).not.toContain(ailleurs.id);
    expect((await lire(autreTenantId)).map((d) => d.conversationId)).toEqual([ailleurs.id]);
  });

  it('🔴 une conversation de TEST n’entre dans aucun chiffre', async () => {
    const c = await conversation();
    await pool.query('update conversations set is_test = true where id = $1', [c.id]);
    await escalader(c.waId);
    expect(de(await lire(), c.id)).toEqual([]);
  });

  it('un collaborateur supprimé depuis devient « ancien », jamais « automatique »', async () => {
    const parti = await membre(tenantId, 'parti@perf.itest', 'Parti', 'agent');
    const c = await conversation();
    await escalader(c.waId);
    await repondre(c.id, parti);
    await inbox.marquerTraitee(tenantId, c.id, true, { collaborateur: parti });
    await pool.query('delete from users where id = $1', [parti]);
    const [d] = de(await lire(), c.id);
    expect(d!.repondant).toEqual({ genre: 'ancien' });
    expect(d!.closePar).toEqual({ genre: 'ancien' });
  });

  it('⚠️ une ouverture antérieure à la mesure n’est pas comptée, et une demande CLOSE hors de la période non plus', async () => {
    const c = await conversation();
    const { mesureDepuis } = await perf.lire(tenantId, periode());
    await pool.query(
      `insert into conversation_evenements (tenant_id, conversation_id, type, cause, at) values
         ($1, $2, 'escaladee', 'automatique : scénario Bienvenue', $3::timestamptz - interval '1 hour')`,
      [tenantId, c.id, mesureDepuis],
    );
    expect(de(await lire(), c.id)).toEqual([]);
    const c2 = await conversation();
    await escalader(c2.waId);
    await inbox.marquerTraitee(tenantId, c2.id, true, { collaborateur: marie });
    const hier = { from: addDays(todayParis(), -3), to: addDays(todayParis(), -2) };
    expect((await perf.lire(tenantId, hier)).demandes.map((d) => d.conversationId)).not.toContain(c2.id);
  });

  it('🔴 une demande ENCORE OUVERTE est rendue quelle que soit la période, marquée hors période', async () => {
    // « Encore ouvertes » porte sur toutes les demandes ouvertes en ce moment : une demande de 31 jours ne doit pas
    // disparaître d'une vue de 30. Ici la période est passée et la demande d'aujourd'hui, le même filtre.
    const c = await conversation();
    await escalader(c.waId);
    const hier = { from: addDays(todayParis(), -3), to: addDays(todayParis(), -2) };
    const [d, ...reste] = de((await perf.lire(tenantId, hier)).demandes, c.id);
    expect(reste).toEqual([]);
    expect(d!.dansLaPeriode).toBe(false);
    expect(d!.closeLe).toBeNull();
    expect(de(await lire(), c.id)[0]!.dansLaPeriode).toBe(true);
  });

  describe('🔴 le chrono part quand le CLIENT a écrit (décision de Julien du 2026-09-29)', () => {
    it('campagne « modèle puis passer à un humain » : rien tant que le client n’a pas répondu, puis sa réponse', async () => {
      // Sans cette règle, 2 000 destinataires faisaient 2 000 demandes à l'ENVOI, et celui qui répondait deux jours
      // plus tard donnait deux jours de temps de réponse.
      const waId = nouveauWaId();
      await robotEnvoie(waId, 'campagne');
      expect(await escalader(waId)).toBe(true);
      const id = await idDe(waId);
      expect(de(await lire(), id), 'le client n’a rien écrit : aucune demande, ni ouverte ni comptée').toEqual([]);
      await ecrit(waId);
      const [d, ...reste] = de(await lire(), id);
      expect(reste).toEqual([]);
      expect(d!.debutLe.getTime()).toBe((await dernierEntrant(id)).getTime());
      expect(d!.debutLe.getTime()).toBeGreaterThan((await ouvertureDe(id)).getTime());
    });

    it('scénario par mot-clé qui passe DIRECTEMENT la main, sans rien envoyer ni marque d’escalade : ouverte, à l’ouverture', async () => {
      const c = await conversation();
      expect(await escalader(c.waId, tenantId, false)).toBe(true);
      const [d] = de(await lire(), c.id);
      expect(d!.debutLe.getTime()).toBe((await ouvertureDe(c.id)).getTime());
    });

    it('Club Med lancé depuis l’Inbox : modèle, le client tape un bouton, le scénario répond puis passe la main : l’ouverture', async () => {
      // La réponse du scénario est celle d'un robot : elle ne rend pas la balle au client.
      const waId = nouveauWaId();
      await robotEnvoie(waId, 'scenario');
      await ecrit(waId, tenantId, 'button');
      await robotEnvoie(waId, 'scenario', 'text');
      await escalader(waId);
      const id = await idDe(waId);
      const [d] = de(await lire(), id);
      expect(d!.debutLe.getTime()).toBe((await ouvertureDe(id)).getTime());
    });

    it('campagne au devenir Inbox : le fil pris pour l’équipe à la réponse du client ouvre une demande, à cet instant', async () => {
      const waId = nouveauWaId();
      await robotEnvoie(waId, 'campagne');
      await ecrit(waId);
      // `prendrePourLEquipe` : aucune marque d'escalade, mais une demande.
      expect(await inbox.setControlOwner(tenantId, waId, 'app_human', { par: { cause: 'automatique : campagne Rentrée' }, ouvreUneDemande: true })).toBe(true);
      const id = await idDe(waId);
      const [d] = de(await lire(), id);
      expect(d!.debutLe.getTime()).toBe((await ouvertureDe(id)).getTime());
    });

    it('l’agent de Meta passe la main pendant qu’il parle au client : l’ouverture, sa propre phrase ne compte pas', async () => {
      const c = await conversation();
      await pool.query(`update conversations set control_owner = 'mba' where id = $1`, [c.id]);
      await robotEnvoie(c.waId, 'mba', 'mba');
      await inbox.marquerEscalade(tenantId, c.waId, 'automatique : agent de Meta');
      const [d] = de(await lire(), c.id);
      expect(d!.debutLe.getTime()).toBe((await ouvertureDe(c.id)).getTime());
    });

    it('un modèle envoyé par un collaborateur rend aussi la balle au client', async () => {
      const c = await conversation();
      await inbox.recordOutbound(c.id, '[template] relance', null, 'humain', 'template', 'MARKETING', 'relance', marie);
      await escalader(c.waId);
      expect(de(await lire(), c.id)).toEqual([]);
    });

    it('une réaction du client ne lance pas le chrono : il part à son premier vrai message', async () => {
      // Un 👍 à une campagne n'appelle pas de réponse : le compter ferait partir le chrono d'une équipe que personne
      // n'a sollicitée.
      const waId = nouveauWaId();
      await robotEnvoie(waId, 'campagne');
      await escalader(waId);
      const id = await idDe(waId);
      await ecrit(waId, tenantId, 'reaction');
      expect(de(await lire(), id), 'une réaction seule : aucune demande').toEqual([]);
      await ecrit(waId);
      const [d, ...reste] = de(await lire(), id);
      expect(reste).toEqual([]);
      expect(d!.debutLe.getTime()).toBe((await dernierEntrant(id)).getTime());
    });

    it('un message RCS de campagne rend la balle au client, comme un modèle WhatsApp', async () => {
      // Sans cette règle, le premier message du client, plus ancien que la campagne, ferait partir le chrono au passage.
      const c = await conversation();
      await robotEnvoie(c.waId, 'campagne', 'rcs');
      await escalader(c.waId);
      expect(de(await lire(), c.id)).toEqual([]);
    });
  });

  it('🔴 la DERNIÈRE réponse avant la fin est rendue, pour une fin automatique', async () => {
    const c = await conversation();
    await escalader(c.waId);
    await repondre(c.id, marie);
    await repondre(c.id, jean);
    const derniere = (await pool.query<{ created_at: Date }>(
      `select created_at from conversation_messages where conversation_id = $1 and origin = 'humain' order by created_at desc limit 1`, [c.id],
    )).rows[0]!.created_at;
    expect(await inbox.setControlOwner(tenantId, c.waId, 'app_workflow', { par: { cause: 'automatique : délai de reprise écoulé' } })).toBe(true);
    await repondre(c.id, marie); // après la fin : pas la dernière réponse de CETTE demande
    const [d] = de(await lire(), c.id);
    expect(d!.closePar).toEqual({ genre: 'automatique' });
    expect(d!.derniereReponseLe!.getTime()).toBe(derniere.getTime());
    expect(d!.repondant).toEqual({ genre: 'collaborateur', userId: marie, nom: 'Marie' });
  });
});
