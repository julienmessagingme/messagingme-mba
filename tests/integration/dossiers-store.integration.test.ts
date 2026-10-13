import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgDossierStore } from '../../src/dossiers/store.pg';
import { PgWorkflowStore } from '../../src/workflow/store.pg';
import { MAX_DOSSIERS_PAR_TYPE } from '../../src/dossiers/regles';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier crée puis supprime des espaces. La CI monte un Postgres jetable pour
// ça (job `integration`). `describe.skipIf(!url)` le rend inerte sans DATABASE_URL, mais ne protège pas contre
// un DATABASE_URL défini qui pointerait sur la production.
const url = process.env.DATABASE_URL ?? '';

/**
 * Les dossiers (migration 0229), contre un vrai Postgres. 🔴 L'ISOLATION EST LE PREMIER SUJET : la RLS est contournée par
 * le pooler, chaque requête porte `tenant_id = $1`, et un dossier n'est accepté que de l'espace ET du type demandé.
 */
describe.skipIf(!url)('PgDossierStore (Postgres réel)', () => {
  let pool: Pool;
  let dossiers: PgDossierStore;
  let scenarios: PgWorkflowStore;
  let tenantId = '';
  let autreTenantId = '';
  const graphe = { nodes: [], edges: [] };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    dossiers = new PgDossierStore(pool);
    scenarios = new PgWorkflowStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-dossiers') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-dossiers-voisin') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    // Les dossiers, les rangements et les scénarios partent par cascade avec leur espace.
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('🔴 un dossier d’un autre espace, ou de l’autre type, ne range rien et ne se voit pas', async () => {
    const chezLeVoisin = await dossiers.creer(autreTenantId, 'scenario', 'Voisin');
    const deTemplates = await dossiers.creer(tenantId, 'template', 'Promos');
    if (typeof chezLeVoisin === 'string' || typeof deTemplates === 'string') throw new Error('création refusée');
    const { id: wf } = await scenarios.insert(tenantId, 'itest isolation', graphe);
    expect(await dossiers.ranger(tenantId, 'scenario', [wf], chezLeVoisin.id)).toBe('dossier_inconnu');
    expect(await dossiers.ranger(tenantId, 'scenario', [wf], deTemplates.id)).toBe('dossier_inconnu');
    expect(await dossiers.rangement(tenantId, 'scenario')).toEqual({});
    expect((await dossiers.lister(tenantId, 'scenario')).map((d) => d.nom)).not.toContain('Voisin');
    // Et un scénario d'un autre espace n'est pas rangé par une clé forgée : rien n'est écrit.
    const { id: wfVoisin } = await scenarios.insert(autreTenantId, 'itest voisin', graphe);
    const sav = await dossiers.creer(tenantId, 'scenario', 'SAV isolation');
    if (typeof sav === 'string') throw new Error('création refusée');
    expect(await dossiers.ranger(tenantId, 'scenario', [wfVoisin], sav.id)).toBe(0);
    expect(await dossiers.rangement(autreTenantId, 'scenario')).toEqual({});
    // Ni renommé, ni supprimé depuis un autre espace.
    expect(await dossiers.renommer(autreTenantId, sav.id, 'Volé')).toBeNull();
    expect(await dossiers.supprimer(autreTenantId, sav.id)).toBe(false);
  });

  it('🔴 le rangement du voisin ne se lit ni ne s’efface d’ici, même sous un nom de template commun', async () => {
    const sienS = await dossiers.creer(autreTenantId, 'scenario', 'Sien');
    const sienT = await dossiers.creer(autreTenantId, 'template', 'Sien');
    if (typeof sienS === 'string' || typeof sienT === 'string') throw new Error('création refusée');
    const { id: wfSien } = await scenarios.insert(autreTenantId, 'itest sien', graphe);
    expect(await dossiers.ranger(autreTenantId, 'scenario', [wfSien], sienS.id)).toBe(1);
    expect(await dossiers.ranger(autreTenantId, 'template', ['hello_world'], sienT.id)).toBe(1);
    // D'ici : rien de lui dans notre rangement, et vider « hello_world » chez nous ne touche pas sa ligne.
    expect((await dossiers.rangement(tenantId, 'scenario'))[wfSien]).toBeUndefined();
    expect((await dossiers.rangement(tenantId, 'template')).hello_world).toBeUndefined();
    expect(await dossiers.ranger(tenantId, 'template', ['hello_world'], null)).toBe(0);
    expect((await dossiers.rangement(autreTenantId, 'template')).hello_world).toBe(sienT.id);
    expect((await dossiers.rangement(autreTenantId, 'scenario'))[wfSien]).toBe(sienS.id);
  });

  it('🔴 un nom est pris sans tenir compte de la casse, par type, et le même nom vit dans l’autre type', async () => {
    expect(typeof (await dossiers.creer(tenantId, 'scenario', 'Black Friday'))).toBe('object');
    expect(await dossiers.creer(tenantId, 'scenario', 'black friday')).toBe('pris');
    expect(typeof (await dossiers.creer(tenantId, 'template', 'Black Friday'))).toBe('object');
    const autre = await dossiers.creer(tenantId, 'scenario', 'Relances');
    if (typeof autre === 'string') throw new Error('création refusée');
    expect(await dossiers.renommer(tenantId, autre.id, 'BLACK FRIDAY')).toBe('pris');
    expect(await dossiers.renommer(tenantId, autre.id, 'Relances clients')).toEqual({ id: autre.id, nom: 'Relances clients' });
  });

  it('🔴 supprimer un dossier libère ses scénarios et ses templates, sans les perdre', async () => {
    const d = await dossiers.creer(tenantId, 'scenario', 'À vider');
    const t = await dossiers.creer(tenantId, 'template', 'À vider');
    if (typeof d === 'string' || typeof t === 'string') throw new Error('création refusée');
    const { id: wf } = await scenarios.insert(tenantId, 'itest à vider', graphe);
    expect(await dossiers.ranger(tenantId, 'scenario', [wf], d.id)).toBe(1);
    expect(await dossiers.ranger(tenantId, 'template', ['promo_ete', 'promo_ete'], t.id)).toBe(1);
    expect((await dossiers.rangement(tenantId, 'scenario'))[wf]).toBe(d.id);
    expect(await dossiers.rangement(tenantId, 'template')).toMatchObject({ promo_ete: t.id });
    expect(await dossiers.supprimer(tenantId, d.id)).toBe(true);
    expect(await dossiers.supprimer(tenantId, t.id)).toBe(true);
    expect((await dossiers.rangement(tenantId, 'scenario'))[wf]).toBeUndefined();
    expect((await dossiers.rangement(tenantId, 'template')).promo_ete).toBeUndefined();
    // Le scénario existe toujours.
    expect((await scenarios.getById(wf, tenantId))?.id).toBe(wf);
  });

  it('un rangement vers « Sans dossier » retire les lignes de templates, et déplacer réécrit la ligne', async () => {
    const a = await dossiers.creer(tenantId, 'template', 'A');
    const b = await dossiers.creer(tenantId, 'template', 'B');
    if (typeof a === 'string' || typeof b === 'string') throw new Error('création refusée');
    await dossiers.ranger(tenantId, 'template', ['relance_panier'], a.id);
    await dossiers.ranger(tenantId, 'template', ['relance_panier'], b.id);
    expect((await dossiers.rangement(tenantId, 'template')).relance_panier).toBe(b.id);
    expect(await dossiers.ranger(tenantId, 'template', ['relance_panier'], null)).toBe(1);
    expect((await dossiers.rangement(tenantId, 'template')).relance_panier).toBeUndefined();
  });

  it('le scénario système du répondeur n’est ni rangé ni listé', async () => {
    const d = await dossiers.creer(tenantId, 'scenario', 'Système');
    if (typeof d === 'string') throw new Error('création refusée');
    const sys = await scenarios.assurerScenarioSysteme(tenantId, 'repondeur');
    expect(await dossiers.ranger(tenantId, 'scenario', [sys], d.id)).toBe(0);
    expect((await dossiers.rangement(tenantId, 'scenario'))[sys]).toBeUndefined();
  });

  it('🔴 au plus 50 dossiers par type et par espace', async () => {
    const plein = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-dossiers-plein') returning id`)).rows[0]!.id;
    try {
      for (let i = 0; i < MAX_DOSSIERS_PAR_TYPE; i += 1) {
        expect(typeof (await dossiers.creer(plein, 'scenario', `D${i}`))).toBe('object');
      }
      expect(await dossiers.creer(plein, 'scenario', 'De trop')).toBe('plein');
      // L'autre type a son propre plafond.
      expect(typeof (await dossiers.creer(plein, 'template', 'Premier'))).toBe('object');
    } finally {
      await pool.query('delete from tenants where id = $1', [plein]);
    }
  });

  it('🔴 la migration en base : contraintes sous leur nom et comportement des clés étrangères', async () => {
    const fk = await pool.query<{ conname: string; confdeltype: string }>(
      `select conname, confdeltype from pg_constraint
        where conname in ('workflows_dossier_fk', 'template_dossiers_dossier_fk')`,
    );
    // n = set null, c = cascade.
    expect(Object.fromEntries(fk.rows.map((r) => [r.conname, r.confdeltype]))).toEqual({
      workflows_dossier_fk: 'n', template_dossiers_dossier_fk: 'c',
    });
    const chk = await pool.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'dossiers_nom_chk'`);
    expect(chk.rows[0]?.def).toMatch(/char_length\(nom\) >= 1.*char_length\(nom\) <= 60/);
    const idx = await pool.query<{ def: string }>(`select indexdef as def from pg_indexes where indexname = 'workflows_dossier_idx'`);
    expect(idx.rows[0]?.def).toMatch(/WHERE \(dossier_id IS NOT NULL\)/);
  });
});
