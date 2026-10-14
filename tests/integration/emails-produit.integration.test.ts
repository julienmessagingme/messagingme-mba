import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgEmailsProduitStore } from '../../src/emails-produit/store.pg';
import { PgInboxStore } from '../../src/inbox/store.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION.
const url = process.env.DATABASE_URL ?? '';

/**
 * LE JOURNAL DES E-MAILS DU PRODUIT EN BASE (lot 7, migration 0234) : ce que les tests unitaires ne peuvent qu'affirmer.
 *
 *  - 🔴 le dédoublonnage : plusieurs copies qui réservent la même occasion en même temps n'en créent qu'UNE par personne
 *    (le cas 5 de la revue du répondeur, porté depuis le lot 7 par ce journal) ;
 *  - 🔴 les destinataires : les admins actifs DÉJÀ connectés de l'espace, et eux seuls ;
 *  - 🔴 l'isolation : un envoi ne se relit pas depuis un autre espace ;
 *  - la prise d'une tentative, unique ; le balayage et l'index partiel ; le webhook ; la cascade avec l'espace.
 */
describe.skipIf(!url)('le journal des e-mails du produit (Postgres réel)', () => {
  let pool: Pool;
  let store: PgEmailsProduitStore;
  let tenantId = '';
  let autreTenantId = '';
  /** Les espaces que la livraison C crée dans ses propres cas, effacés à la fin. */
  const espacesC: string[] = [];
  const identites: Record<string, string> = {};
  const suffixe = randomUUID().slice(0, 8);

  const identite = async (nom: string): Promise<string> => {
    const id = (await pool.query<{ id: string }>(`insert into identities (email) values ($1) returning id`, [`itest-emails-${nom}-${suffixe}@example.test`])).rows[0]!.id;
    identites[nom] = id;
    return id;
  };
  const compte = async (tenant: string, ident: string, role: string, o: { connecte?: boolean; parti?: boolean } = {}) => {
    await pool.query(
      `insert into users (tenant_id, email, role, identity_id, last_login_at, disabled_at)
       values ($1, (select email from identities where id = $2), $3, $2, $4, $5)`,
      [tenant, ident, role, o.connecte === false ? null : new Date(), o.parti ? new Date() : null],
    );
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 6 });
    store = new PgEmailsProduitStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-emails-produit') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-emails-produit-autre') returning id`)).rows[0]!.id;
    await compte(tenantId, await identite('admin'), 'admin');
    await compte(tenantId, await identite('jamais'), 'admin', { connecte: false });
    await compte(tenantId, await identite('parti'), 'admin', { parti: true });
    await compte(tenantId, await identite('agent'), 'agent');
    await compte(autreTenantId, await identite('autre'), 'admin');
  });

  afterAll(async () => {
    if (pool) {
      for (const t of [tenantId, autreTenantId, ...espacesC]) if (t) await pool.query('delete from tenants where id = $1', [t]);
      await pool.query('delete from identities where id = any($1::uuid[])', [Object.values(identites)]);
      await pool.end();
    }
  });

  it('🔴 les destinataires : les admins actifs déjà connectés, ni l’invité jamais venu, ni le parti, ni l’agent', async () => {
    expect(await store.adminsConnectes(tenantId)).toEqual([identites.admin]);
    expect(await store.adminsConnectes(autreTenantId)).toEqual([identites.autre]);
  });

  it('🔴 trois copies réservent la même occasion en même temps : UNE ligne par personne ; une autre occasion, une autre', async () => {
    const reserver = () => store.reserver({ tenantId, cle: 'credit_epuise', occasion: 'jour:2026-10-05', identites: [identites.admin!], valeurs: { lien_credit: 'https://x' } });
    const prises = await Promise.all([reserver(), reserver(), reserver()]);
    expect(prises.flat()).toHaveLength(1);
    expect(await store.reserver({ tenantId, cle: 'credit_epuise', occasion: 'jour:2026-10-06', identites: [identites.admin!], valeurs: {} })).toHaveLength(1);
    // Un autre espace a sa propre occasion.
    expect(await store.reserver({ tenantId: autreTenantId, cle: 'credit_epuise', occasion: 'jour:2026-10-05', identites: [identites.autre!], valeurs: {} })).toHaveLength(1);
  });

  it('🔴 un envoi se relit dans son espace, jamais depuis un autre ; une tentative se prend une fois', async () => {
    const [id] = await store.reserver({ tenantId, cle: 'numero_libere', occasion: 'sub_x:liberation_mail', identites: [identites.admin!], valeurs: { lien_numero: 'https://n' } });
    expect(await store.pourEnvoi(autreTenantId, id!)).toBeNull();
    const e = await store.pourEnvoi(tenantId, id!);
    expect(e).toMatchObject({ statut: 'a_envoyer', tentatives: 0, langue: 'fr', espace: 'itest-emails-produit', membreActif: true, desinscriptions: [] });
    expect(e!.valeurs.lien_numero).toBe('https://n');
    const prises = await Promise.all([store.prendre(tenantId, id!, 0), store.prendre(tenantId, id!, 0)]);
    expect(prises.filter(Boolean)).toHaveLength(1);
    expect(await store.prendre(autreTenantId, id!, 1)).toBe(false);
    await store.noterEnvoye(tenantId, id!, `re_${suffixe}`);
    const apres = await store.pourEnvoi(tenantId, id!);
    expect(apres).toMatchObject({ statut: 'envoye', valeurs: {} });
    // Le webhook de Resend retrouve l'envoi par son identifiant ; une seconde ouverture ne déplace pas la date.
    expect(await store.noterEvenementResend(`re_${suffixe}`, 'email.opened', new Date('2026-10-14T10:00:00Z'))).toEqual({ identityId: identites.admin });
    await store.noterEvenementResend(`re_${suffixe}`, 'email.opened', new Date('2026-10-14T11:00:00Z'));
    const ouvert = await pool.query<{ ouvert_le: Date }>('select ouvert_le from emails_produit_envois where id = $1', [id]);
    expect(ouvert.rows[0]!.ouvert_le.toISOString()).toBe('2026-10-14T10:00:00.000Z');
    expect(await store.noterEvenementResend('re_inconnu', 'email.opened', new Date())).toBeNull();
  });

  it('le balayage : un envoi à faire depuis plus de cinq minutes revient, un envoi en bail ou à réessayer plus tard non', async () => {
    const [vieux] = await store.reserver({ tenantId, cle: 'numero_libere', occasion: 'balayage-vieux', identites: [identites.admin!], valeurs: {} });
    const [plusTard] = await store.reserver({ tenantId, cle: 'numero_libere', occasion: 'balayage-plus-tard', identites: [identites.admin!], valeurs: {} });
    await pool.query(`update emails_produit_envois set cree_le = now() - interval '10 minutes' where id = any($1::uuid[])`, [[vieux, plusTard]]);
    await store.noterEchec(tenantId, plusTard!, 'resend 500', new Date(Date.now() + 3_600_000));
    const ids = (await store.aReprendre(500)).map((l) => l.id);
    expect(ids).toContain(vieux);
    expect(ids).not.toContain(plusTard);
    // L'index partiel sert la VRAIE requête de `aReprendre` : son prédicat est le début de son `where`. Le parcours
    // séquentiel interdit le temps du plan, pour que seul l'index puisse répondre (une table de test est minuscule).
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local enable_seqscan = off');
      const vu: string[] = [];
      const espion = { query: async (sql: string, params: unknown[]) => {
        const r = await client.query<{ 'QUERY PLAN': string }>(`explain ${sql}`, params);
        vu.push(...r.rows.map((l) => l['QUERY PLAN']));
        return { rows: [], rowCount: 0 };
      } };
      await new PgEmailsProduitStore(espion as never).aReprendre(10);
      expect(vu.join(' ')).toContain('emails_produit_envois_a_envoyer_idx');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('la personne : sa langue et ses désinscriptions, relues à l’envoi', async () => {
    const [id] = await store.reserver({ tenantId, cle: 'numero_libere', occasion: 'preferences', identites: [identites.admin!], valeurs: {} });
    await store.poserLangue(identites.admin!, 'en');
    await store.desinscrire(identites.admin!, 'commercial');
    await store.desinscrire(identites.admin!, 'commercial');
    expect(await store.preferences(identites.admin!)).toEqual({ langue: 'en', desinscriptions: ['commercial'] });
    expect(await store.pourEnvoi(tenantId, id!)).toMatchObject({ langue: 'en', desinscriptions: ['commercial'] });
    await store.reabonner(identites.admin!, 'commercial');
    expect(await store.preferences(identites.admin!)).toEqual({ langue: 'en', desinscriptions: [] });
    expect(await store.identiteDuCompte(autreTenantId, 'ffffffff-ffff-4fff-8fff-ffffffffffff')).toBeNull();
  });

  it('🔴 les chiffres du mois comptent par modèle, et la suppression d’un espace emporte son journal', async () => {
    const chiffres = await store.chiffresDuMois();
    const libere = chiffres.find((c) => c.cle === 'numero_libere');
    expect(libere!.envoyes).toBeGreaterThanOrEqual(1);
    expect(libere!.ouverts).toBeGreaterThanOrEqual(1);
    const t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-emails-produit-efface') returning id`)).rows[0]!.id;
    await store.reserver({ tenantId: t, cle: 'credit_epuise', occasion: 'cascade', identites: [identites.admin!], valeurs: {} });
    await pool.query('delete from tenants where id = $1', [t]);
    const reste = await pool.query('select 1 from emails_produit_envois where tenant_id = $1', [t]);
    expect(reste.rowCount).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Livraison B (migration 0235)
  // ---------------------------------------------------------------------------------------------------------------

  it('🔴 un seuil : trois copies le franchissent ensemble, UNE gagne ; rester au-dessus ne rend rien ; relâché puis refranchi, génération 2', async () => {
    const prises = await Promise.all([1, 2, 3].map(() => store.franchir(tenantId, 'contacts_80', true)));
    expect(prises.filter((g) => g !== null)).toEqual([1]);
    expect(await store.franchir(tenantId, 'contacts_80', true)).toBeNull();
    expect(await store.franchir(tenantId, 'contacts_80', false)).toBeNull();
    expect(await store.franchir(tenantId, 'contacts_80', true)).toBe(2);
    // L'état est celui de CET espace.
    expect(await store.franchir(autreTenantId, 'contacts_80', true)).toBe(1);
  });

  it('le dernier crédit reçu : le dernier mouvement POSITIF de l’espace, jamais un débit ni un autre espace', async () => {
    expect(await store.dernierCreditRecu(tenantId)).toBeNull();
    const recharge = (await pool.query<{ id: string }>(
      `insert into agent_credit_mouvements (tenant_id, delta_micro_eur, raison, note, at) values ($1, 2000000, 'achat', 'itest', now() - interval '1 hour') returning id`,
      [tenantId],
    )).rows[0]!.id;
    await pool.query(`insert into agent_credit_mouvements (tenant_id, delta_micro_eur, raison, note) values ($1, -150000, 'conso', 'itest')`, [tenantId]);
    await pool.query(`insert into agent_credit_mouvements (tenant_id, delta_micro_eur, raison, note) values ($1, 5000000, 'achat', 'itest')`, [autreTenantId]);
    expect(await store.dernierCreditRecu(tenantId)).toBe(recharge);
  });

  it('🔴 le contexte d’un passage : le nom de profil, le dernier message WhatsApp du contact, et rien d’un autre espace', async () => {
    const wa = '33600000951';
    const contact = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, profile_name) values ($1, $2, 'Camille') returning id`, [tenantId, `+${wa}`],
    )).rows[0]!.id;
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at) values ($1, $2, $3, now()) returning id`, [tenantId, wa, contact],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, channel, body, created_at) values
         ($1, 'in', 'whatsapp', 'bonjour', timestamptz '2026-10-14 09:00:00+00'),
         ($1, 'in', 'rcs', 'rcs plus tard', timestamptz '2026-10-14 09:30:00+00'),
         ($1, 'out', 'whatsapp', 'réponse', timestamptz '2026-10-14 09:40:00+00')`,
      [conv],
    );
    const inbox = new PgInboxStore(pool);
    expect(await inbox.contexteDuPassage(tenantId, wa)).toEqual({
      conversationId: conv, nom: 'Camille', waId: wa, dernierEntrantLe: new Date('2026-10-14T09:00:00Z'),
    });
    expect(await inbox.contexteDuPassage(autreTenantId, wa)).toBeNull();
  });

  it('🔴 la passation de l’agent de Meta rend vrai quand elle est neuve, faux quand le même control_passed est redélivré', async () => {
    const inbox = new PgInboxStore(pool);
    const wa = '33600000952';
    expect(await inbox.marquerEscalade(tenantId, wa, 'automatique : agent de Meta')).toBe(true);
    expect(await inbox.marquerEscalade(tenantId, wa, 'automatique : agent de Meta')).toBe(false);
    const ev = await pool.query(
      `select 1 from conversation_evenements e join conversations c on c.id = e.conversation_id
        where c.tenant_id = $1 and c.wa_id = $2 and e.type = 'passee_par_mba'`,
      [tenantId, wa],
    );
    expect(ev.rowCount).toBe(1);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Livraison C : l'accompagnement, le récapitulatif, le plafond des transferts (aucune migration)
  // ---------------------------------------------------------------------------------------------------------------

  const espaceC = async (nom: string): Promise<string> => {
    const id = (await pool.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [`itest-emails-c-${nom}`])).rows[0]!.id;
    espacesC.push(id);
    return id;
  };

  it('les espaces récents : créés depuis moins de trente jours, avec la date de leur PREMIER numéro', async () => {
    const neuf = await espaceC('neuf');
    const avecNumero = await espaceC('numero');
    const ancien = await espaceC('ancien');
    await pool.query(`update tenants set created_at = now() - interval '40 days' where id = $1`, [ancien]);
    const waba = `waba-itest-c-${suffixe}`;
    await pool.query(`insert into waba (id, tenant_id, name) values ($1, $2, 'itest')`, [waba, avecNumero]);
    await pool.query(
      `insert into phone_numbers (id, tenant_id, waba_id, display_phone_number, status, created_at) values
         ($1, $3, $4, '+33600000961', 'CONNECTED', timestamptz '2026-10-10 08:00:00+00'),
         ($2, $3, $4, '+33600000962', 'CONNECTED', timestamptz '2026-10-12 08:00:00+00')`,
      [`pn-itest-c1-${suffixe}`, `pn-itest-c2-${suffixe}`, avecNumero, waba],
    );
    const recents = await store.espacesRecents();
    const de = (t: string) => recents.find((r) => r.tenantId === t);
    expect(de(neuf)).toMatchObject({ numeroDepuis: null });
    expect(de(neuf)!.creeLe).toBeInstanceOf(Date);
    expect(de(avecNumero)!.numeroDepuis).toEqual(new Date('2026-10-10T08:00:00Z'));
    expect(de(ancien)).toBeUndefined();
    // Un espace verrouillé (sa suppression a commencé) n'est ni récent ni ouvert ; un numéro délié ne compte plus.
    const verrouille = await espaceC('verrouille');
    await pool.query(`update tenants set status = 'locked' where id = $1`, [verrouille]);
    await pool.query(`update phone_numbers set delie_le = now() where id = $1`, [`pn-itest-c1-${suffixe}`]);
    const apres = await store.espacesRecents();
    expect(apres.find((r) => r.tenantId === verrouille)).toBeUndefined();
    expect(apres.find((r) => r.tenantId === avecNumero)!.numeroDepuis).toEqual(new Date('2026-10-12T08:00:00Z'));
    const ouverts = await store.espacesOuverts();
    expect(ouverts).toContain(neuf);
    expect(ouverts).not.toContain(verrouille);
  });

  it('🔴 le récapitulatif : la semaine de PARIS, WhatsApp seul, sans les fils de test, les demandes de Performance, et rien d’un autre espace', async () => {
    const t = await espaceC('recap');
    const voisin = await espaceC('recap-voisin');
    const conv = async (tenant: string, wa: string, test = false) => (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at, is_test) values ($1, $2, now(), $3) returning id`, [tenant, wa, test],
    )).rows[0]!.id;
    const a = await conv(t, '33600000971');
    const b = await conv(t, '33600000972');
    const essai = await conv(t, '33600000973', true);
    const ailleurs = await conv(voisin, '33600000971');
    expect(await store.aDesMessages(t)).toBe(false);
    // La semaine du 2026-10-05 au 2026-10-11 à Paris (heure d'été) : du 04 à 22:00 UTC au 11 à 22:00 UTC.
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, channel, body, created_at) values
         ($1, 'in',  'whatsapp', 'dans la semaine',          timestamptz '2026-10-05 08:00:00+00'),
         ($1, 'out', 'whatsapp', 'réponse',                  timestamptz '2026-10-05 08:01:00+00'),
         ($2, 'in',  'whatsapp', 'dimanche 23:30 à Paris',   timestamptz '2026-10-11 21:30:00+00'),
         ($2, 'out', 'rcs',      'un message RCS',           timestamptz '2026-10-06 08:00:00+00'),
         ($2, 'in',  'whatsapp', 'lundi 00:30 à Paris',      timestamptz '2026-10-11 22:30:00+00'),
         ($2, 'in',  'whatsapp', 'dimanche d''avant',        timestamptz '2026-10-04 21:30:00+00'),
         ($3, 'in',  'whatsapp', 'fil de test',              timestamptz '2026-10-06 08:00:00+00'),
         ($4, 'in',  'whatsapp', 'autre espace',             timestamptz '2026-10-06 08:00:00+00')`,
      [a, b, essai, ailleurs],
    );
    await pool.query(
      `insert into conversation_evenements (tenant_id, conversation_id, type, at) values
         ($1, $2, 'escaladee',      timestamptz '2026-10-06 09:00:00+00'),
         ($1, $3, 'passee_par_mba', timestamptz '2026-10-07 09:00:00+00'),
         ($1, $2, 'traitee',        timestamptz '2026-10-06 10:00:00+00'),
         ($1, $2, 'escaladee',      timestamptz '2026-10-12 09:00:00+00'),
         ($1, $4, 'escaladee',      timestamptz '2026-10-06 09:00:00+00')`,
      [t, a, b, essai],
    );
    await pool.query(`insert into agent_credits (tenant_id, solde_micro_eur) values ($1, 1234567)`, [t]);
    expect(await store.aDesMessages(t)).toBe(true);
    expect(await store.recapDeLaSemaine(t, '2026-10-05', '2026-10-11')).toEqual({
      messagesRecus: 2, messagesEnvoyes: 1, conversations: 2, demandes: 2, creditMicroEur: 1234567,
    });
    // Un espace sans crédit ni message rend des zéros, pas une erreur.
    const vide = await espaceC('recap-vide');
    expect(await store.recapDeLaSemaine(vide, '2026-10-05', '2026-10-11')).toEqual({
      messagesRecus: 0, messagesEnvoyes: 0, conversations: 0, demandes: 0, creditMicroEur: 0,
    });
    expect(await store.aDesMessages(vide)).toBe(false);
  });

  it('🔴 les transferts du jour : un par passage (pas par admin prévenu), depuis minuit à Paris, et dans CET espace', async () => {
    const t = await espaceC('plafond');
    const deux = [identites.admin!, identites.jamais!];
    await store.reserver({ tenantId: t, cle: 'transfert_equipe', occasion: 'attente:c1:1', identites: deux, valeurs: {} });
    await store.reserver({ tenantId: t, cle: 'transfert_equipe', occasion: 'attente:c2:1', identites: deux, valeurs: {} });
    const [hier] = await store.reserver({ tenantId: t, cle: 'transfert_equipe', occasion: 'attente:c3:1', identites: [identites.admin!], valeurs: {} });
    await pool.query(`update emails_produit_envois set cree_le = now() - interval '2 days' where id = $1`, [hier]);
    await store.reserver({ tenantId: t, cle: 'credit_epuise', occasion: 'jour:x', identites: deux, valeurs: {} });
    await store.reserver({ tenantId: autreTenantId, cle: 'transfert_equipe', occasion: 'attente:c9:1', identites: [identites.autre!], valeurs: {} });
    expect(await store.transfertsDuJour(t)).toBe(2);
    // L'occasion réservée se lit dans son espace, pour son modèle.
    expect(await store.occasionReservee(t, 'transfert_equipe', 'attente:c1:1')).toBe(true);
    expect(await store.occasionReservee(t, 'credit_epuise', 'attente:c1:1')).toBe(false);
    expect(await store.occasionReservee(autreTenantId, 'transfert_equipe', 'attente:c1:1')).toBe(false);
  });
});
