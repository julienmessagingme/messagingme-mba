import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgRisqueStore } from '../../src/engagement/risque.pg';
import { calculerRisque, debutFenetre } from '../../src/engagement/risque';
import { balayerRisqueEspace, debutDuJour, type DepsBalayageRisque } from '../../src/engagement/balayage';
import { PgContactStore } from '../../src/crm/contact-store.pg';
import type { Signal } from '../../src/signaux/types';

const url = process.env.DATABASE_URL ?? '';

/**
 * LE RISQUE DE DÉSENGAGEMENT contre un VRAI Postgres (lot 7 de l'API publique, migration 0178).
 *
 * Ce qu'un double ne peut pas dire : que la lecture groupée retrouve bien chaque fait (livraison, lecture,
 * réponse sur un fil rattaché par `wa_id` seulement, clic attribué, analyse, cache RCS de l'agent de l'espace),
 * que l'écriture rend les changements de niveau, que la contrainte de cohérence tient, et surtout qu'un espace
 * n'évalue ni n'écrit la fiche d'un autre.
 *
 * ⚠️ Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION) : joué par le job `integration`.
 */
describe.skipIf(!url)('risque de désengagement (Postgres)', () => {
  let pool: Pool;
  let store: PgRisqueStore;
  let A: string;
  let B: string;
  const ids: Record<string, string> = {};
  const maintenant = new Date();
  const ilYa = (jours: number): Date => new Date(maintenant.getTime() - jours * 86_400_000);

  async function contact(tenant: string, cle: string, phone: string, over: { optIn?: string } = {}): Promise<string> {
    const id = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, $3) returning id`,
      [tenant, phone, over.optIn ?? 'opted_in'],
    )).rows[0]!.id;
    ids[cle] = id;
    return id;
  }

  /** Un message de campagne délivré : une campagne par envoi (unique (campagne, contact)). */
  async function delivre(tenant: string, contactId: string, phone: string, jours: number, lu = false): Promise<void> {
    const k = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category, status) values ($1, 'itest-risque', 'marketing', 'completed') returning id`,
      [tenant],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, status, sent_at, delivery_status, delivery_updated_at)
       values ($1, $2, $3, 'sent', $4, $5, $6)`,
      [k, contactId, phone, ilYa(jours), lu ? 'read' : 'delivered', ilYa(jours - 0.01)],
    );
  }
  const quatreEnvois = async (tenant: string, id: string, phone: string): Promise<void> => {
    await delivre(tenant, id, phone, 85, true);
    for (const j of [70, 65, 62]) await delivre(tenant, id, phone, j);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgRisqueStore(pool);
    A = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-risque-a') returning id`)).rows[0]!.id;
    B = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-risque-b') returning id`)).rows[0]!.id;

    // Décroche : 80 jours sans rien, trois derniers non lus, et il lit d'habitude.
    await quatreEnvois(A, await contact(A, 'decroche', '+33600000901'), '+33600000901');
    // Désabonné, sans aucun historique.
    await contact(A, 'stop', '+33600000902', { optIn: 'opted_out' });
    // Jamais sollicité : il n'est pas évalué.
    await contact(A, 'jamais', '+33600000903');
    // Répond, sur un fil que RIEN ne rattache à sa fiche que son numéro (`contact_id` null).
    const repond = await contact(A, 'repond', '+33600000904');
    await quatreEnvois(A, repond, '+33600000904');
    const fil = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id) values ($1, '33600000904', null) returning id`, [A],
    )).rows[0]!.id;
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body, created_at) values ($1, 'in', 'text', 'oui', $2)`, [fil, ilYa(20)]);
    // Clique un lien suivi il y a 10 jours : l'allègement.
    const clique = await contact(A, 'clique', '+33600000905');
    await quatreEnvois(A, clique, '+33600000905');
    await pool.query(
      `insert into tracked_links (code, tenant_id, template_name, template_language, button_index, destination, confirmed_at)
       values ('itestrisque01', $1, 'promo', 'fr', 0, 'https://client.fr/promo', now())`, [A],
    );
    await pool.query(`insert into tracked_link_clicks (code, tenant_id, contact_id, at) values ('itestrisque01', $1, $2, $3)`, [A, clique, ilYa(10)]);
    // Réclamation non résolue, négative, satisfaction 2, sur un fil rattaché par `contact_id`.
    const mecontent = await contact(A, 'mecontent', '+33600000906');
    await delivre(A, mecontent, '+33600000906', 5, true);
    const filM = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id) values ($1, '33600000906', $2) returning id`, [A, mecontent],
    )).rows[0]!.id;
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body, created_at) values ($1, 'in', 'text', 'inadmissible', $2)`, [filM, ilYa(4)]);
    await pool.query(
      `insert into conversation_analysis (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by,
         exchanges_count, action_suggestion, confidence, justification, llm_provider, llm_model, satisfaction, created_at)
       values ($1, $2, 'negatif', 'reclamation', 'livraison', false, 'humain', 4, 'rappeler', 0.9, 'j', 'test', 'test', 2, $3)`,
      // Datée AVANT l'instant du calcul : `now()` serait postérieur à `maintenant`, donc hors de la fenêtre.
      [filM, A, ilYa(3)],
    );
    // Injoignable en RCS, pour l'agent DE L'ESPACE, sous la forme « chiffres seuls » du cache.
    const rcs = await contact(A, 'rcs', '+33600000907');
    await delivre(A, rcs, '+33600000907', 5, true);
    await pool.query(
      `insert into rcs_agents (tenant_id, agent_id, brand_name, webhook_code, client_token_enc) values ($1, 'itest-agent-a', 'A', 'itest-risque-wh-a', 'x')`, [A],
    );
    await pool.query(
      `insert into rcs_capabilities_cache (agent_id, phone_e164, reachable, checked_at) values ('itest-agent-a', '33600000907', false, $1)
       on conflict (agent_id, phone_e164) do update set reachable = excluded.reachable, checked_at = excluded.checked_at`,
      [ilYa(1)],
    );
    // L'autre espace : une fiche sollicitée.
    await quatreEnvois(B, await contact(B, 'autre', '+33600000908'), '+33600000908');
  });

  afterAll(async () => {
    await pool.query(`delete from rcs_capabilities_cache where agent_id = 'itest-agent-a'`);
    for (const t of [A, B]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  it('les fiches à évaluer : sollicitées sur la fenêtre, désabonnées ; jamais celles d’un autre espace', async () => {
    const aEvaluer = await store.contactsAEvaluer(A, debutFenetre(maintenant));
    expect(new Set(aEvaluer)).toEqual(new Set([ids.decroche, ids.stop, ids.repond, ids.clique, ids.mecontent, ids.rcs]));
    expect(await store.contactsAEvaluer(B, debutFenetre(maintenant))).toEqual([ids.autre]);
  });

  it('🔴 la lecture groupée retrouve chaque fait, et les règles en tirent le bon niveau', async () => {
    const lot = await store.faits(A, await store.contactsAEvaluer(A, debutFenetre(maintenant)), debutFenetre(maintenant), maintenant);
    const par = Object.fromEntries(lot.map((c) => [c.contactId, calculerRisque(c.faits, maintenant)]));
    expect(par[ids.decroche!]).toEqual({ niveau: 'eleve', score: 70, raisons: ['silence_60j', 'sans_reponse', 'non_lu'] });
    expect(par[ids.stop!]).toEqual({ niveau: 'eleve', score: 100, raisons: ['stop'] });
    // La réponse du fil sans `contact_id` est trouvée par le numéro : sans elle, ce serait « élevé ».
    expect(par[ids.repond!]).toEqual({ niveau: 'faible', score: 15, raisons: ['non_lu'] });
    // Le clic attribué allège de 25.
    expect(par[ids.clique!]).toEqual({ niveau: 'faible', score: 0, raisons: ['non_lu'] });
    expect(par[ids.mecontent!]).toEqual({ niveau: 'faible', score: 15, raisons: ['reclamation', 'negatif', 'insatisfait'] });
    expect(lot.find((c) => c.contactId === ids.rcs)?.faits.joignableRcs).toBe(false);
    expect(lot.every((c) => c.niveauStocke === null)).toBe(true);
  });

  it('🔴 le balayage écrit, rend les changements de niveau, publie UN passage en élevé ; rejoué, il ne voit plus rien', async () => {
    const publies: string[] = [];
    const signaux: Signal[] = [];
    const deps: DepsBalayageRisque = {
      espaces: async () => [A],
      contactsAEvaluer: (t, d) => store.contactsAEvaluer(t, d),
      faits: (t, i, d, m) => store.faits(t, i, d, m),
      ecrire: (t, l, c) => store.ecrire(t, l, c),
      declenchablesDepuis: (t, d) => store.declenchablesDepuis(t, d),
      automationRisqueActive: async () => true,
      horairesOuvres: async () => null,
      publierRisqueEleve: async (_t, waId) => { publies.push(waId); },
      emettreSignaux: async (_t, s) => { signaux.push(...s); },
      maintenant: () => maintenant,
    };
    const b1 = await balayerRisqueEspace(A, deps);
    expect(b1).toMatchObject({ evalues: 6, transitions: 6, declenches: 1, sansDeclencheur: 1 });
    // Le décrocheur, pas le désabonné.
    expect(publies).toEqual(['33600000901']);
    expect(signaux).toHaveLength(6);

    const fiche = await new PgContactStore(pool).lireFicheApi(A, ids.decroche!);
    expect(fiche).toMatchObject({ risqueNiveau: 'eleve', risqueScore: 70, risqueRaisons: ['silence_60j', 'sans_reponse', 'non_lu'] });
    expect(fiche?.risqueCalculeLe).toBe(maintenant.toISOString());

    // 🔴 LE PLAFOND DU JOUR relit ce passage : le décrocheur compte, le désabonné non (STOP), l'autre espace non plus.
    expect(await store.declenchablesDepuis(A, debutDuJour(maintenant))).toBe(1);
    expect(await store.declenchablesDepuis(A, new Date(maintenant.getTime() + 1))).toBe(0);
    expect(await store.declenchablesDepuis(B, debutDuJour(maintenant))).toBe(0);

    const b2 = await balayerRisqueEspace(A, { ...deps, maintenant: () => new Date(maintenant.getTime() + 1000) });
    // Le second passage du jour sait que le premier a déjà déclenché.
    expect(b2).toMatchObject({ evalues: 6, transitions: 0, declenches: 0, dejaDeclenches: 1 });
    expect(publies).toHaveLength(1);
    // 🔴 INCHANGÉE, ELLE N'EST PAS RÉÉCRITE : la date reste celle du passage à ce niveau (« depuis le »).
    expect((await new PgContactStore(pool).lireFicheApi(A, ids.decroche!))?.risqueCalculeLe).toBe(maintenant.toISOString());
  });

  it('🔴 un espace ne lit ni n’écrit la fiche d’un autre', async () => {
    expect(await store.faits(B, [ids.decroche!], debutFenetre(maintenant), maintenant)).toEqual([]);
    expect(await store.ecrire(B, [{ contactId: ids.decroche!, risque: { niveau: 'faible', score: 0, raisons: [] } }], maintenant)).toEqual([]);
    const lu = await pool.query<{ risque_niveau: string }>('select risque_niveau from contacts where id = $1', [ids.decroche]);
    expect(lu.rows[0]!.risque_niveau).toBe('eleve');
    expect((await new PgContactStore(pool).lireFicheApi(B, ids.autre!))?.risqueNiveau).toBeNull();
  });

  /**
   * LE FILTRE DE LA CONSOLE ET LA FICHE DE LA CONSOLE (tâche 8 du lot 7), sur ce que le balayage ci-dessus vient
   * d'écrire. ⚠️ Dépend de l'ordre des cas : il lit l'état laissé par le balayage (deux fiches en élevé dans A).
   */
  it('🔴 le filtre par niveau ne rend que ce niveau, dans l’espace ; une fiche jamais calculée n’est pas « inconnu »', async () => {
    const contacts = new PgContactStore(pool);
    const eleves = await contacts.query(A, { risque: 'eleve' });
    expect(new Set(eleves.map((c) => c.id))).toEqual(new Set([ids.decroche, ids.stop]));
    expect(await contacts.count(A, { risque: 'eleve' })).toBe(2);
    expect(await contacts.query(B, { risque: 'eleve' })).toEqual([]);
    // `jamais` n'a jamais été calculé : il n'est dans AUCUN niveau, `inconnu` compris.
    expect((await contacts.query(A, { risque: 'inconnu' })).map((c) => c.id)).not.toContain(ids.jamais);
    // La ligne de la console porte le risque, et la fiche jamais calculée le porte à null.
    expect(eleves.find((c) => c.id === ids.decroche)?.risque).toEqual({
      niveau: 'eleve', score: 70, raisons: ['silence_60j', 'sans_reponse', 'non_lu'], calculeLe: expect.any(String),
    });
    expect((await contacts.getById(A, ids.jamais!))?.risque).toBeNull();
  });

  it('🔴 la cohérence tient en base : « inconnu » sans score, un niveau jamais sans sa date', async () => {
    await expect(pool.query(`update contacts set risque_niveau = 'inconnu', risque_score = 10, risque_calcule_le = now() where id = $1`, [ids.jamais]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`update contacts set risque_niveau = 'faible', risque_score = 10 where id = $1`, [ids.jamais]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`update contacts set risque_niveau = 'critique', risque_score = 10, risque_calcule_le = now() where id = $1`, [ids.jamais]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`update contacts set risque_niveau = 'eleve', risque_score = 101, risque_calcule_le = now() where id = $1`, [ids.jamais]))
      .rejects.toMatchObject({ code: '23514' });
  });

  /**
   * 🔴 LA GARDE DE L'ÉCRITURE (relecture du lot 7) : seule une fiche dont la VALEUR change est réécrite, et la date
   * ne bouge qu'avec le NIVEAU. Joué sur une fiche que rien ne relit ensuite (`repond`, en faible depuis le
   * balayage), pour ne pas changer l'état dont dépendent les cas précédents.
   */
  it('🔴 un score qui change au même niveau est réécrit SANS toucher la date ; un changement de niveau la déplace et reste une transition', async () => {
    const lire = async () => (await pool.query<{ risque_niveau: string; risque_score: number; risque_raisons: string[]; risque_calcule_le: Date; xmin: string }>(
      'select risque_niveau, risque_score, risque_raisons, risque_calcule_le, xmin::text as xmin from contacts where id = $1', [ids.repond],
    )).rows[0]!;
    const avant = await lire();
    // L'état laissé par le balayage (cf. la lecture groupée plus haut).
    expect([avant.risque_niveau, avant.risque_score, avant.risque_raisons]).toEqual(['faible', 15, ['non_lu']]);
    const t1 = new Date(maintenant.getTime() + 60_000);
    const t2 = new Date(maintenant.getTime() + 120_000);
    const t3 = new Date(maintenant.getTime() + 180_000);

    // Même valeur : pas réécrite (`xmin`, la transaction qui a écrit la version courante de la ligne, ne bouge pas).
    expect(await store.ecrire(A, [{ contactId: ids.repond!, risque: { niveau: 'faible', score: 15, raisons: ['non_lu'] } }], t1)).toEqual([]);
    expect((await lire()).xmin).toBe(avant.xmin);

    // Même niveau, score et raisons différents : réécrite, date inchangée, aucune transition.
    expect(await store.ecrire(A, [{ contactId: ids.repond!, risque: { niveau: 'faible', score: 25, raisons: ['sans_reponse'] } }], t2)).toEqual([]);
    const apres = await lire();
    expect([apres.risque_score, apres.risque_raisons, apres.risque_calcule_le.toISOString()]).toEqual([25, ['sans_reponse'], avant.risque_calcule_le.toISOString()]);

    // Changement de niveau : la transition est rendue, et la date devient celle de ce passage.
    expect(await store.ecrire(A, [{ contactId: ids.repond!, risque: { niveau: 'moyen', score: 40, raisons: ['silence_30j', 'sans_reponse'] } }], t3))
      .toEqual([{ contactId: ids.repond, waId: '33600000904', ancien: 'faible', nouveau: 'moyen', score: 40, raisons: ['silence_30j', 'sans_reponse'] }]);
    expect((await lire()).risque_calcule_le.toISOString()).toBe(t3.toISOString());
  });

  it('l’index du filtre existe, valide, avec son prédicat', async () => {
    const r = await pool.query<{ indisvalid: boolean; def: string }>(
      `select i.indisvalid, pg_get_indexdef(i.indexrelid) as def from pg_index i
        where i.indexrelid = 'contacts_tenant_risque_idx'::regclass`,
    );
    expect(r.rows[0]?.indisvalid).toBe(true);
    expect(r.rows[0]?.def).toMatch(/\(tenant_id, risque_niveau\) WHERE \(deleted_at IS NULL\)/);
  });
});
