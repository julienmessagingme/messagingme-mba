import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgOauthStore, type NouveauxJetons } from '../../src/oauth/store.pg';
import { PgUserStore } from '../../src/user/store.pg';
import { CLIENTS_OAUTH } from '../../src/oauth/clients';
import { nouveauJeton, PREFIXE_ACCES, PREFIXE_CODE, PREFIXE_RENOUVELLEMENT } from '../../src/oauth/jetons';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier crée puis supprime des espaces. La CI monte un Postgres jetable pour
// ça (job `integration`). `describe.skipIf(!url)` le rend inerte sans DATABASE_URL, mais ne protège pas contre
// un DATABASE_URL défini qui pointerait sur la production.
const url = process.env.DATABASE_URL ?? '';

/**
 * Les autorisations OAuth (migration 0204) et `PgOauthStore`, contre un vrai Postgres.
 *
 * 🔴 POURQUOI EN INTÉGRATION. Ce qui compte ici vit dans le SQL : la consommation d'un code qui ne fait gagner
 * qu'un échange sur deux simultanés, la rotation et le rejeu qui révoque, le rôle relu dans `users` à chaque
 * appel, les cascades, la clause `tenant_id` qui isole deux clients, et les CHECK. Un faux pool dirait oui à tout.
 */
describe.skipIf(!url)('PgOauthStore (Postgres réel)', () => {
  let pool: Pool;
  let store: PgOauthStore;
  let tenantId: string;
  let autreTenantId: string;
  let adminId: string;

  const CLAUDE_CODE = CLIENTS_OAUTH[0]!.id;
  const CLAUDE_AI = CLIENTS_OAUTH[1]!.id;
  const RESSOURCE = 'https://api.exemple.test/mcp';
  const RETOUR = 'http://localhost:33418/callback';
  const DEFI = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  const creerCompte = async (tenant: string, role = 'admin'): Promise<string> =>
    (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role) values ($1, $2, $3) returning id`,
      [tenant, `itest-oauth-${randomUUID()}@exemple.test`, role],
    )).rows[0]!.id;

  /** Une autorisation et son code, comme le consentement les écrit. */
  const autoriser = async (o: { tenant?: string; user?: string; client?: string } = {}) => {
    const code = nouveauJeton(PREFIXE_CODE);
    const { autorisationId } = await store.creerAutorisation({
      tenantId: o.tenant ?? tenantId,
      userId: o.user ?? adminId,
      clientId: o.client ?? CLAUDE_CODE,
      scopes: ['mcp:read', 'mcp:write'],
      resource: RESSOURCE,
      code: { empreinte: code.empreinte, challenge: DEFI, redirectUri: RETOUR },
    });
    return { autorisationId, code };
  };

  const paire = (): NouveauxJetons & { brutAcces: string; brutRefresh: string } => {
    const acces = nouveauJeton(PREFIXE_ACCES);
    const refresh = nouveauJeton(PREFIXE_RENOUVELLEMENT);
    return {
      acces: acces.empreinte, refresh: refresh.empreinte, brutAcces: acces.brut, brutRefresh: refresh.brut,
      accesExpireLe: new Date(Date.now() + 3600_000), refreshExpireLe: new Date(Date.now() + 30 * 86_400_000),
    };
  };

  /** Une autorisation dont le code a été échangé : une paire de jetons vivante. */
  const autoriserEtEchanger = async (o: { tenant?: string; user?: string } = {}) => {
    const { autorisationId, code } = await autoriser(o);
    expect(await store.consommerCode(code.empreinte)).not.toBeNull();
    const jetons = paire();
    expect(await store.poserJetons(autorisationId, { ...jetons, refreshMaxLe: new Date(Date.now() + 90 * 86_400_000) })).toBe(true);
    return { autorisationId, jetons };
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgOauthStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-oauth') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-oauth-autre') returning id`)).rows[0]!.id;
    adminId = await creerCompte(tenantId);
  });

  afterAll(async () => {
    // Les autorisations et leurs codes partent en cascade avec l'espace et ses comptes.
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('🔴 les CHECK : un client hors de la liste, un droit de /v1, aucun droit, refusés sous leur nom', async () => {
    const tenter = (client: string, scopes: string[]) => pool.query(
      `insert into oauth_autorisations (tenant_id, user_id, client_id, scopes, resource) values ($1, $2, $3, $4, $5)`,
      [tenantId, adminId, client, scopes, RESSOURCE],
    );
    // Depuis 0227 (lot 15), une adresse https est la forme d'une fiche d'identité : seule une autre forme est refusée.
    await expect(tenter('http://evil.test/fiche', ['mcp:read'])).rejects.toMatchObject({ constraint: 'oauth_autorisations_client_chk' });
    await expect(tenter(CLAUDE_CODE, ['mcp:read', 'contacts:write'])).rejects.toMatchObject({ constraint: 'oauth_autorisations_scopes_chk' });
    await expect(tenter(CLAUDE_AI, [])).rejects.toMatchObject({ constraint: 'oauth_autorisations_scopes_chk' });
  });

  it('🔴 un code ne sert qu’une fois, même pour deux échanges simultanés', async () => {
    const { autorisationId, code } = await autoriser();
    const [a, b] = await Promise.all([store.consommerCode(code.empreinte), store.consommerCode(code.empreinte)]);
    const gagnants = [a, b].filter((x) => x !== null);
    expect(gagnants).toHaveLength(1);
    expect(gagnants[0]).toEqual({
      autorisationId, tenantId, clientId: CLAUDE_CODE, challenge: DEFI, redirectUri: RETOUR,
      scopes: ['mcp:read', 'mcp:write'], resource: RESSOURCE,
    });
    expect(await store.consommerCode(code.empreinte)).toBeNull();
  });

  it('🔴 un code échu, ou celui d’une autorisation révoquée, ne se consomme pas', async () => {
    const echu = await autoriser();
    await pool.query(`update oauth_codes set expire_le = now() - interval '1 second' where hash = $1`, [echu.code.empreinte]);
    expect(await store.consommerCode(echu.code.empreinte)).toBeNull();
    const revoquee = await autoriser();
    expect(await store.revoquer(tenantId, revoquee.autorisationId)).toBe(true);
    expect(await store.consommerCode(revoquee.code.empreinte)).toBeNull();
  });

  it('les jetons ne se posent qu’une fois par autorisation', async () => {
    const { autorisationId } = await autoriserEtEchanger();
    expect(await store.poserJetons(autorisationId, { ...paire(), refreshMaxLe: new Date(Date.now() + 90 * 86_400_000) })).toBe(false);
  });

  it('🔴 le jeton d’accès se résout avec sa personne et son espace ; échu, il n’est plus valide', async () => {
    const { autorisationId, jetons } = await autoriserEtEchanger();
    expect(await store.resoudreAcces(jetons.acces)).toEqual({
      autorisationId, tenantId, userId: adminId, scopes: ['mcp:read', 'mcp:write'], tenantStatus: 'active', valide: true,
    });
    await pool.query(`update oauth_autorisations set acces_expire_le = now() - interval '1 second' where id = $1`, [autorisationId]);
    expect((await store.resoudreAcces(jetons.acces))?.valide).toBe(false);
    expect(await store.resoudreAcces(nouveauJeton(PREFIXE_ACCES).empreinte)).toBeNull();
  });

  it('le dernier usage s’écrit au plus une fois par minute', async () => {
    const { autorisationId, jetons } = await autoriserEtEchanger();
    const lire = async () => (await pool.query<{ d: Date | null }>(
      `select dernier_usage_le as d from oauth_autorisations where id = $1`, [autorisationId],
    )).rows[0]!.d;
    expect(await lire()).toBeNull();
    await store.resoudreAcces(jetons.acces);
    const premier = await lire();
    expect(premier).not.toBeNull();
    await store.resoudreAcces(jetons.acces);
    expect((await lire())?.getTime()).toBe(premier!.getTime());
  });

  it('🔴 la rotation : le nouveau jeton marche, l’ancien accès ne se résout plus', async () => {
    const { autorisationId, jetons } = await autoriserEtEchanger();
    const suivants = paire();
    expect(await store.renouveler(jetons.refresh, CLAUDE_CODE, suivants)).toBe('ok');
    expect(await store.resoudreAcces(jetons.acces)).toBeNull();
    expect((await store.resoudreAcces(suivants.acces))?.autorisationId).toBe(autorisationId);
    const tierce = paire();
    expect(await store.renouveler(suivants.refresh, CLAUDE_CODE, tierce)).toBe('ok');
  });

  it('🔴 un ancien jeton de renouvellement présenté révoque TOUTE l’autorisation', async () => {
    const { autorisationId, jetons } = await autoriserEtEchanger();
    const suivants = paire();
    expect(await store.renouveler(jetons.refresh, CLAUDE_CODE, suivants)).toBe('ok');
    expect(await store.renouveler(jetons.refresh, CLAUDE_CODE, paire())).toBe('rejeu');
    // Le jeton légitime du moment ne sert plus à rien non plus : c'est ce qui coupe un voleur.
    expect((await store.resoudreAcces(suivants.acces))?.valide).toBe(false);
    expect(await store.renouveler(suivants.refresh, CLAUDE_CODE, paire())).toBe('inconnu');
    expect((await store.lister(tenantId)).map((a) => a.id)).not.toContain(autorisationId);
  });

  it('un renouvellement inconnu, d’un autre client, ou échu : `inconnu`', async () => {
    const { autorisationId, jetons } = await autoriserEtEchanger();
    expect(await store.renouveler(nouveauJeton(PREFIXE_RENOUVELLEMENT).empreinte, CLAUDE_CODE, paire())).toBe('inconnu');
    expect(await store.renouveler(jetons.refresh, CLAUDE_AI, paire())).toBe('inconnu');
    await pool.query(`update oauth_autorisations set refresh_expire_le = now() - interval '1 second' where id = $1`, [autorisationId]);
    expect(await store.renouveler(jetons.refresh, CLAUDE_CODE, paire())).toBe('inconnu');
  });

  it('🔴 un compte rétrogradé ou désactivé perd l’accès ET le renouvellement, sans rien révoquer', async () => {
    const compte = await creerCompte(tenantId);
    const { jetons } = await autoriserEtEchanger({ user: compte });
    await pool.query(`update users set role = 'manager' where id = $1`, [compte]);
    expect((await store.resoudreAcces(jetons.acces))?.valide).toBe(false);
    expect(await store.renouveler(jetons.refresh, CLAUDE_CODE, paire())).toBe('inconnu');
    // Redevenu admin, il retrouve l'accès : la base fait foi, pas le jeton.
    await pool.query(`update users set role = 'admin' where id = $1`, [compte]);
    expect((await store.resoudreAcces(jetons.acces))?.valide).toBe(true);
    await pool.query(`update users set disabled_at = now() where id = $1`, [compte]);
    expect((await store.resoudreAcces(jetons.acces))?.valide).toBe(false);
    expect(await store.renouveler(jetons.refresh, CLAUDE_CODE, paire())).toBe('inconnu');
  });

  it('🔴 la suppression d’un compte, par le vrai chemin, emporte ses autorisations', async () => {
    const compte = await creerCompte(tenantId);
    const { autorisationId, jetons } = await autoriserEtEchanger({ user: compte });
    expect(await new PgUserStore(pool).deleteUser(tenantId, compte)).toBe('ok');
    expect(await store.resoudreAcces(jetons.acces)).toBeNull();
    const reste = await pool.query(`select 1 from oauth_autorisations where id = $1`, [autorisationId]);
    expect(reste.rowCount).toBe(0);
  });

  it('🔴 lister et révoquer ne voient pas l’autorisation d’un autre espace', async () => {
    const autreAdmin = await creerCompte(autreTenantId);
    const chezLAutre = await autoriserEtEchanger({ tenant: autreTenantId, user: autreAdmin });
    const ici = await autoriserEtEchanger();
    const liste = await store.lister(tenantId);
    expect(liste.map((a) => a.id)).toContain(ici.autorisationId);
    expect(liste.map((a) => a.id)).not.toContain(chezLAutre.autorisationId);
    expect(liste.find((a) => a.id === ici.autorisationId)).toMatchObject({ clientId: CLAUDE_CODE, userId: adminId, scopes: ['mcp:read', 'mcp:write'] });
    expect(await store.revoquer(tenantId, chezLAutre.autorisationId)).toBe(false);
    expect((await store.resoudreAcces(chezLAutre.jetons.acces))?.valide).toBe(true);
    expect(await store.revoquer(tenantId, ici.autorisationId)).toBe(true);
    expect(await store.revoquer(tenantId, ici.autorisationId)).toBe(false);
    expect((await store.resoudreAcces(ici.jetons.acces))?.valide).toBe(false);
  });

  it('la révocation par le client, par son jeton d’accès ou de renouvellement', async () => {
    const parAcces = await autoriserEtEchanger();
    expect(await store.revoquerParJeton(parAcces.jetons.acces)).toBe(true);
    expect((await store.resoudreAcces(parAcces.jetons.acces))?.valide).toBe(false);
    const parRefresh = await autoriserEtEchanger();
    expect(await store.revoquerParJeton(parRefresh.jetons.refresh)).toBe(true);
    expect(await store.renouveler(parRefresh.jetons.refresh, CLAUDE_CODE, paire())).toBe('inconnu');
    expect(await store.revoquerParJeton(nouveauJeton(PREFIXE_ACCES).empreinte)).toBe(false);
  });

  it('🔴 la purge : codes échus depuis une heure, autorisations mortes depuis 30 jours, et rien de vivant', async () => {
    const vieuxCode = await autoriser();
    await pool.query(`update oauth_codes set expire_le = now() - interval '2 hours' where hash = $1`, [vieuxCode.code.empreinte]);
    const codeRecent = await autoriser();
    const morte = await autoriserEtEchanger();
    await pool.query(`update oauth_autorisations set revoque_le = now() - interval '31 days' where id = $1`, [morte.autorisationId]);
    const revoqueeRecemment = await autoriserEtEchanger();
    await store.revoquer(tenantId, revoqueeRecemment.autorisationId);
    const vivante = await autoriserEtEchanger();

    expect(await store.purger()).toBeGreaterThanOrEqual(2);
    const existe = async (sql: string, v: string) => ((await pool.query(sql, [v])).rowCount ?? 0) > 0;
    expect(await existe(`select 1 from oauth_codes where hash = $1`, vieuxCode.code.empreinte)).toBe(false);
    expect(await existe(`select 1 from oauth_codes where hash = $1`, codeRecent.code.empreinte)).toBe(true);
    expect(await existe(`select 1 from oauth_autorisations where id = $1`, morte.autorisationId)).toBe(false);
    expect(await existe(`select 1 from oauth_autorisations where id = $1`, revoqueeRecemment.autorisationId)).toBe(true);
    expect(await existe(`select 1 from oauth_autorisations where id = $1`, vivante.autorisationId)).toBe(true);
  });
});
