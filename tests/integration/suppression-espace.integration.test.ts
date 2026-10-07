import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgToolCatalog } from '../../src/agent/catalog.pg';
import { PgSuppressionEspaceStore } from '../../src/ops/suppression-espace.pg';
import { creerPierreTombale } from '../../src/ops/espaces-supprimes.pg';
import { PgLiberationStore } from '../../src/numero/liberation.pg';
import { PgSalesforceStore } from '../../src/salesforce/store.pg';

/**
 * LA PURGE D'UN ESPACE (RC8), SUR UNE VRAIE BASE.
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : l'ordre de la cascade n'est pas garanti, et six clés en `restrict` ou
 * `no action` (liens de chaîne et leurs publications vers les scénarios, outils vers requêtes et sources, requêtes vers
 * sources) la font échouer selon l'ordre. Un espace peuplé de toutes ces tables doit se supprimer sans erreur, et un
 * espace VOISIN, peuplé des mêmes tables, doit sortir intact : chaque requête de la purge porte l'espace.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const s = randomBytes(4).toString('hex');
/** Des chiffres au hasard pour les numéros (CHECK `^[1-9][0-9]{6,14}$`) : la base de CI est partagée par les fichiers. */
const chiffres = (): string => `4499${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`;
const ORG = (): string => `00D${randomBytes(8).toString('hex').slice(0, 15)}`;
const ADRESSE_OPS = `exploitant-${s}@exemple.test`;

describe.skipIf(!url)('la purge d’un espace supprimé (RC8)', () => {
  let pool: Pool;
  let magasin: PgSuppressionEspaceStore;
  const tenants: string[] = [];
  const identites: string[] = [];
  const offres: string[] = [];
  const numeros: string[] = [];

  /** Un espace peuplé de toutes les tables aux clés fragiles, et de ce que la suppression doit lire avant la cascade. */
  async function espace(nom: string): Promise<{ id: string; pn: string; waba: string }> {
    const id = (await pool.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [nom])).rows[0]!.id;
    tenants.push(id);
    const waba = `itest-sup-waba-${randomUUID()}`;
    const pn = `itest-sup-pn-${randomUUID()}`;
    await pool.query(`insert into waba (id, tenant_id, name) values ($1, $2, 'itest')`, [waba, id]);
    await pool.query(`insert into phone_numbers (id, tenant_id, waba_id, display_phone_number, status) values ($1, $2, $3, null, 'CONNECTED')`, [pn, id, waba]);

    // Les chaînes : un scénario, un lien qui le désigne (restrict), une publication qui désigne le lien (restrict).
    const wf = (await pool.query<{ id: string }>(`insert into workflows (tenant_id, name) values ($1, 'itest-sup') returning id`, [id])).rows[0]!.id;
    const lien = (await pool.query<{ id: string }>(
      `insert into channelsme_links (tenant_id, workflow_id, token, phrase) values ($1, $2, $3, $4) returning id`,
      [id, wf, `cm-${randomBytes(6).toString('hex')}`, `Phrase ${randomUUID()}`],
    )).rows[0]!.id;
    await pool.query(`insert into channelsme_posts (tenant_id, cm_message_id, link_id) values ($1, $2, $3)`, [id, `cmmsg-${randomUUID()}`, lien]);

    // Les connecteurs : une source, une requête (restrict vers la source), un outil (restrict vers la requête, no action
    // vers la source), par le vrai code qui les crée.
    const agent = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, fiche, mention_ia, modele) values ($1, 'itest', '{}'::jsonb, 'Je suis une IA.', 'test/modele') returning id`, [id],
    )).rows[0]!.id;
    const source = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status) values ($1, 'http', 'itest', 'https://exemple.test/api', 'none', 'active') returning id`, [id],
    )).rows[0]!.id;
    const requete = (await pool.query<{ id: string }>(
      `insert into connector_requests (tenant_id, source_id, label, method, path, output_paths) values ($1, $2, 'itest', 'POST', '/x', $3::text[]) returning id`,
      [id, source, ['statut']],
    )).rows[0]!.id;
    const outil = await new PgToolCatalog(pool).ajouterConnecteur(id, agent, {
      sourceId: source, requestId: requete, name: 'itest_outil', title: 'Titre', description: 'sert à ça', nePasUtiliser: 'jamais',
      params: [], risk: 'write', nature: 'integre', outputPaths: ['statut'],
    });
    expect(outil).not.toBeNull();

    // Les données d'un client, et ce qui vit hors de toute clé.
    const contact = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, $2) returning id`, [id, `+${chiffres()}`],
    )).rows[0]!.id;
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id) values ($1, $2, $3) returning id`, [id, chiffres(), contact],
    )).rows[0]!.id;
    await pool.query(`insert into conversation_messages (conversation_id, direction, body) values ($1, 'in', 'bonjour'), ($1, 'out', 'salut')`, [conv]);
    await pool.query(`insert into salesforce.orgs (tenant_id, org_id, my_domain) values ($1, $2, 'https://itest.my.salesforce.com')`, [id, ORG()]);
    await pool.query(`insert into agent_credits (tenant_id, solde_micro_eur) values ($1, 1500000)`, [id]);
    await pool.query(`insert into mba_liste (tenant_id, wa_id, phone_number_id, entree_id) values ($1, '33600000001', $2, 'e1')`, [id, pn]);
    return { id, pn, waba };
  }

  async function identite(email: string): Promise<string> {
    const id = (await pool.query<{ id: string }>(`insert into identities (email) values ($1) returning id`, [email])).rows[0]!.id;
    identites.push(id);
    return id;
  }
  const compte = (tenant: string, ident: string, email: string) => pool.query(
    `insert into users (tenant_id, email, role, identity_id) values ($1, $2, 'admin', $3)`, [tenant, email, ident],
  );
  const existe = async (sql: string, p: unknown[]): Promise<boolean> => ((await pool.query(sql, p)).rowCount ?? 0) > 0;

  let A: { id: string; pn: string; waba: string };
  let B: { id: string; pn: string; waba: string };
  let orpheline: string;
  let partagee: string;
  let exploitant: string;
  let numeroA: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    magasin = new PgSuppressionEspaceStore(pool, [ADRESSE_OPS.toUpperCase()], new PgSalesforceStore(pool, 'c'.repeat(64)));
    A = await espace(`itest-sup-a-${s}`);
    B = await espace(`itest-sup-b-${s}`);
    orpheline = await identite(`orpheline-${s}@exemple.test`);
    partagee = await identite(`partagee-${s}@exemple.test`);
    exploitant = await identite(ADRESSE_OPS);
    await compte(A.id, orpheline, `orpheline-${s}@exemple.test`);
    await compte(A.id, partagee, `partagee-${s}@exemple.test`);
    await compte(A.id, exploitant, ADRESSE_OPS);
    await compte(B.id, partagee, `partagee-${s}@exemple.test`);

    // 🔴 La mémoire « jamais deux offres pour un numéro » : sans clé étrangère, elle doit survivre à la purge.
    const pnOffert = `itest-sup-offert-${randomUUID()}`;
    await pool.query(`insert into credits_offerts (tenant_id, phone_number_id, montant_micro_eur) values ($1, $2, 5000000)`, [A.id, pnOffert]);
    offres.push(A.id);

    // Stripe, lu AVANT la cascade : le client et l'abonnement du numéro.
    await pool.query(`insert into stripe_clients (tenant_id, livemode, customer_id) values ($1, false, $2)`, [A.id, `cus_itest${s}`]);
    await pool.query(`insert into abonnements_numero (stripe_subscription_id, tenant_id, livemode) values ($1, $2, true)`, [`sub_itest${s}`, A.id]);

    // Un numéro fourni encore ATTRIBUÉ à A au moment de la purge (l'étape d'avant a échoué) : le filet le bloque.
    numeroA = chiffres();
    numeros.push(numeroA);
    await pool.query(
      `insert into numeros_fournis (numero, didww_did_id, statut, tenant_id, attribue_le) values ($1, $2, 'attribue', $3, now())`,
      [numeroA, `did-itest-${randomUUID()}`, A.id],
    );
  });

  afterAll(async () => {
    for (const t of tenants) {
      // Le nettoyage d'un test qui aurait échoué avant la purge : mêmes clés fragiles, même ordre.
      await pool.query('delete from channelsme_posts where tenant_id = $1', [t]);
      await pool.query('delete from channelsme_links where tenant_id = $1', [t]);
      await pool.query('delete from agent_tools where tenant_id = $1', [t]);
      await pool.query('delete from connector_requests where tenant_id = $1', [t]);
      await pool.query('delete from salesforce.orgs where tenant_id = $1', [t]);
      await pool.query('delete from tenants where id = $1', [t]);
      await pool.query('delete from espaces_supprimes where tenant_id = $1', [t]);
    }
    await pool.query('delete from credits_offerts where tenant_id = any($1::uuid[])', [offres]);
    await pool.query('delete from numeros_fournis where numero = any($1::text[])', [numeros]);
    await pool.query('delete from identities where id = any($1::uuid[]) and not exists (select 1 from users u where u.identity_id = identities.id)', [identites]);
    await pool.end();
  });

  it('le bilan lit ce que la cascade emportera : Stripe et ses liens, les adresses effacées et gardées, le numéro fourni', async () => {
    const b = await magasin.bilan(A.id);
    expect(b).not.toBeNull();
    expect(b!.comptes).toEqual({ utilisateurs: 3, contacts: 1, conversations: 1, scenarios: 1 });
    expect(b!.soldeMicroEur).toBe(1_500_000);
    expect(b!.stripe.clients).toEqual([{ customerId: `cus_itest${s}`, livemode: false, lien: `https://dashboard.stripe.com/test/customers/cus_itest${s}` }]);
    expect(b!.stripe.abonnements).toEqual([{
      id: `sub_itest${s}`, produit: 'numero', statut: 'actif', livemode: true, vivant: true, lien: `https://dashboard.stripe.com/subscriptions/sub_itest${s}`,
    }]);
    // L'orpheline sera effacée ; la partagée (un compte dans B) et l'exploitant (sa casse ignorée) gardés.
    expect(b!.adresses.effacees).toEqual([`orpheline-${s}@exemple.test`]);
    expect(b!.adresses.gardees.sort()).toEqual([ADRESSE_OPS, `partagee-${s}@exemple.test`].sort());
    // Relié sans chiffres connus : vu de Meta (la même définition que la libération).
    expect(b!.numeroFourni).toEqual({ numero: numeroA, vuDeMeta: true });
    expect(b!.meta).toMatchObject({ phoneNumberId: A.pn, wabaId: A.waba, partage: false, mbaAllume: false, contactsSurLaListe: 1 });
    expect(b!.salesforce).toBe(true);
    expect(b!.cleVercel).toBe(false);
    expect(await magasin.bilan(randomUUID())).toBeNull();
  });

  it('🔴 un numéro d’un AUTRE espace sous le compte WhatsApp de A : partagé, rien ne se fera chez Meta', async () => {
    const pn = `itest-sup-pn-${randomUUID()}`;
    await pool.query(`insert into phone_numbers (id, tenant_id, waba_id, status) values ($1, $2, $3, 'CONNECTED')`, [pn, B.id, A.waba]);
    try {
      expect((await magasin.bilan(A.id))!.meta.partage).toBe(true);
    } finally {
      await pool.query('delete from phone_numbers where id = $1', [pn]);
    }
    expect((await magasin.bilan(A.id))!.meta.partage).toBe(false);
  });

  it('🔴 une clé Vercel rouverte depuis la révocation : la purge refuse, et RIEN n’est touché', async () => {
    await pool.query(`insert into agent_gateway_keys (tenant_id, cle_id, cle_chiffree, plafond_micro_eur) values ($1, 'key_itest', 'x', 0)`, [A.id]);
    try {
      expect(await magasin.purger(A.id, { par: 'x', etapes: [] })).toEqual({ fait: false, raison: 'cle_rouverte' });
      expect(await existe('select 1 from tenants where id = $1', [A.id])).toBe(true);
      expect(await existe('select 1 from espaces_supprimes where tenant_id = $1', [A.id])).toBe(false);
    } finally {
      await pool.query('delete from agent_gateway_keys where tenant_id = $1', [A.id]);
    }
  });

  it('🔴 la purge : l’espace et ses données partent, les clés fragiles ne la font pas échouer, la trace est écrite', async () => {
    const etapes = [{ etape: 'verrou' as const, etat: 'fait' as const, detail: null }];
    const r = await magasin.purger(A.id, { par: 'exploitant@exemple.test', etapes });
    expect(r).toEqual({
      fait: true,
      comptes: { utilisateurs: 3, contacts: 1, conversations: 1, messages: 2, scenarios: 1, identitesEffacees: 1, identitesGardees: 2 },
    });
    for (const table of ['users', 'contacts', 'conversations', 'workflows', 'channelsme_links', 'channelsme_posts', 'agent_tools', 'connector_requests', 'agent_tool_sources', 'agents', 'waba', 'phone_numbers', 'stripe_clients', 'abonnements_numero', 'agent_credits', 'mba_liste']) {
      expect(await existe(`select 1 from ${table} where tenant_id = $1`, [A.id]), table).toBe(false);
    }
    expect(await existe('select 1 from tenants where id = $1', [A.id])).toBe(false);
    // La purge ne nomme pas le schéma `salesforce` (il doit pouvoir partir sur sa propre base) : c'est l'étape
    // `salesforce`, par son propre magasin, qui délie l'org avant la purge.
    expect(await existe('select 1 from salesforce.orgs where tenant_id = $1', [A.id])).toBe(true);

    // La trace, sans aucune donnée client, et la pierre tombale qui la lit.
    const trace = (await pool.query<{ nom: string; par: string; etapes: unknown; comptes: { identitesEffacees: number } }>(
      'select nom, par, etapes, comptes from espaces_supprimes where tenant_id = $1', [A.id],
    )).rows[0]!;
    expect(trace).toMatchObject({ nom: `itest-sup-a-${s}`, par: 'exploitant@exemple.test', etapes, comptes: { identitesEffacees: 1 } });
    expect(await creerPierreTombale(pool)(A.id)).toBe(true);
    expect(await creerPierreTombale(pool)(B.id)).toBe(false);
  });

  it('🔴 les identités : l’orpheline effacée, la partagée et celle de l’exploitation gardées', async () => {
    expect(await existe('select 1 from identities where id = $1', [orpheline])).toBe(false);
    expect(await existe('select 1 from identities where id = $1', [partagee])).toBe(true);
    expect(await existe('select 1 from identities where id = $1', [exploitant])).toBe(true);
  });

  it('🔴 `credits_offerts` reste, et le numéro fourni encore attribué sort en `bloque`, jamais attribué à personne', async () => {
    expect(await existe('select 1 from credits_offerts where tenant_id = $1', [A.id])).toBe(true);
    const n = (await pool.query<{ statut: string; tenant_id: string | null }>('select statut, tenant_id from numeros_fournis where numero = $1', [numeroA])).rows[0]!;
    expect(n).toEqual({ statut: 'bloque', tenant_id: null });
  });

  it('🔴 l’espace VOISIN, peuplé des mêmes tables, est intact', async () => {
    for (const table of ['users', 'contacts', 'conversations', 'workflows', 'channelsme_links', 'channelsme_posts', 'agent_tools', 'connector_requests', 'agent_tool_sources', 'agents', 'waba', 'phone_numbers', 'agent_credits', 'mba_liste']) {
      expect(await existe(`select 1 from ${table} where tenant_id = $1`, [B.id]), table).toBe(true);
    }
    expect(await existe('select 1 from salesforce.orgs where tenant_id = $1', [B.id])).toBe(true);
    expect((await magasin.bilan(B.id))!.comptes).toEqual({ utilisateurs: 1, contacts: 1, conversations: 1, scenarios: 1 });
  });

  it('une seconde purge du même espace : `disparu`, rien n’est écrit', async () => {
    expect(await magasin.purger(A.id, { par: 'x', etapes: [] })).toEqual({ fait: false, raison: 'disparu' });
  });
});

/**
 * LA SORTIE DU NUMÉRO FOURNI d'un espace qu'on supprime : la décision de la libération (vu de Meta ou non), sans ses
 * conditions d'abonnement.
 */
describe.skipIf(!url)('la sortie du numéro fourni d’un espace supprimé (RC8)', () => {
  let pool: Pool;
  let liberation: PgLiberationStore;
  const tenants: string[] = [];
  const numeros: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    liberation = new PgLiberationStore(pool);
  });
  afterAll(async () => {
    await pool.query('delete from numeros_fournis where numero = any($1::text[])', [numeros]);
    for (const t of tenants) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  /** Un espace et son numéro attribué ; `vu` : un code de Meta capté pour lui. */
  async function avecNumero(vu: boolean): Promise<{ tenant: string; numero: string }> {
    const tenant = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-sortie') returning id`)).rows[0]!.id;
    tenants.push(tenant);
    const numero = chiffres();
    numeros.push(numero);
    const id = (await pool.query<{ id: string }>(
      `insert into numeros_fournis (numero, didww_did_id, statut, tenant_id, attribue_le) values ($1, $2, 'attribue', $3, now()) returning id`,
      [numero, `did-itest-${randomUUID()}`, tenant],
    )).rows[0]!.id;
    if (vu) await pool.query(`insert into codes_verification (numero_id, appel_id, code) values ($1, $2, '123456')`, [id, `appel-${randomUUID()}`]);
    return { tenant, numero };
  }
  const ligne = async (numero: string) => (await pool.query<{ statut: string; tenant_id: string | null }>(
    'select statut, tenant_id from numeros_fournis where numero = $1', [numero],
  )).rows[0]!;

  it('jamais vu de Meta : rendu à la réserve, sans appeler DIDWW', async () => {
    const { tenant, numero } = await avecNumero(false);
    let appels = 0;
    expect(await liberation.sortirDeLEspaceSupprime(tenant, async () => { appels += 1; })).toEqual({ fait: 'libre', numero });
    expect(await ligne(numero)).toEqual({ statut: 'libre', tenant_id: null });
    expect(appels).toBe(0);
  });

  it('vu de Meta : résilié chez DIDWW, puis `resilie`', async () => {
    const { tenant, numero } = await avecNumero(true);
    const resilies: string[] = [];
    expect(await liberation.sortirDeLEspaceSupprime(tenant, async (did) => { resilies.push(did); })).toEqual({ fait: 'resilie', numero });
    expect(resilies).toHaveLength(1);
    expect(await ligne(numero)).toEqual({ statut: 'resilie', tenant_id: null });
  });

  it('🔴 vu de Meta, DIDWW absent ou qui refuse : `bloque`, la cause rendue, jamais attribué à personne', async () => {
    const sans = await avecNumero(true);
    expect(await liberation.sortirDeLEspaceSupprime(sans.tenant, null)).toMatchObject({ fait: 'bloque', numero: sans.numero });
    expect(await ligne(sans.numero)).toEqual({ statut: 'bloque', tenant_id: null });
    const refus = await avecNumero(true);
    expect(await liberation.sortirDeLEspaceSupprime(refus.tenant, async () => { throw new Error('DIDWW 503'); }))
      .toEqual({ fait: 'bloque', numero: refus.numero, cause: 'DIDWW 503' });
    expect(await ligne(refus.numero)).toEqual({ statut: 'bloque', tenant_id: null });
  });

  it('aucun numéro attribué : rien', async () => {
    const tenant = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-sortie-vide') returning id`)).rows[0]!.id;
    tenants.push(tenant);
    expect(await liberation.sortirDeLEspaceSupprime(tenant, null)).toEqual({ fait: 'aucun' });
  });
});
