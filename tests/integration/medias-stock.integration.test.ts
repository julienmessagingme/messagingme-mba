import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgRcsMediaStore, GRACE_SUPPRESSION_JOURS } from '../../src/rcs/media-store.pg';
import { newMediaCode } from '../../src/ids/code';
import { LimiteOffreError } from '../../src/offres/refus';

/**
 * LE STOCK DE LA MÉDIATHÈQUE (spec médias du 2026-10-14, lot B), sur une vraie base : quota sous verrou d'espace, un même
 * fichier compté une fois, suppression refusée tant que le fichier sert, puis douce pendant 30 jours.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Un « fichier » de `taille` octets dont le contenu dépend de `graine` (deux graines = deux empreintes). */
const fichier = (taille: number, graine: number): Buffer => {
  const b = Buffer.alloc(taille, graine);
  Buffer.from(PNG).copy(b);
  return b;
};

describe.skipIf(!url)('le stock de la médiathèque', () => {
  let pool: Pool;
  let store: PgRcsMediaStore;
  let t = '';
  let autre = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgRcsMediaStore(pool);
    t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-medias-stock') returning id`)).rows[0]!.id;
    autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-medias-stock-autre') returning id`)).rows[0]!.id;
  });
  beforeEach(async () => {
    for (const table of ['rcs_media', 'workflows', 'rcs_messages', 'campaign_drafts', 'campaigns']) {
      await pool.query(`delete from ${table} where tenant_id = any($1)`, [[t, autre]]);
    }
  });
  afterAll(async () => {
    await pool.query('delete from tenants where id = any($1)', [[t, autre]]);
    await pool.end();
  });

  const deposer = (tenant: string, octets: Buffer, quota: number | null = null) =>
    store.deposer(tenant, { code: newMediaCode(), mime: 'image/png', bytes: octets, nom: 'visuel.png' }, quota);
  const vieillir = (code: string, jours: number) =>
    pool.query(`update rcs_media set supprime_le = now() - make_interval(days => $2) where code = $1`, [code, jours]);

  it('un dépôt crée la fiche, pose son empreinte, et compte dans l’occupation de son espace seulement', async () => {
    const { media, existant } = await deposer(t, fichier(1000, 1));
    expect(existant).toBe(false);
    expect(media.taille).toBe(1000);
    const e = await pool.query<{ empreinte: string | null }>('select empreinte from rcs_media where code = $1', [media.code]);
    expect(e.rows[0]!.empreinte).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.occupation(t)).toBe(1000);
    expect(await store.occupation(autre)).toBe(0);
    expect((await store.lister(t)).map((m) => m.code)).toEqual([media.code]);
  });

  it('🔴 au-delà du quota, le dépôt est refusé par la limite de l’offre et rien n’est écrit', async () => {
    await deposer(t, fichier(600, 1), 1000);
    await expect(deposer(t, fichier(500, 2), 1000)).rejects.toBeInstanceOf(LimiteOffreError);
    expect(await store.occupation(t)).toBe(600);
    // Le quota est celui de l'espace : l'autre n'en est pas affecté.
    await expect(deposer(autre, fichier(900, 2), 1000)).resolves.toBeTruthy();
  });

  it('🔴 deux dépôts simultanés au bord du quota : le verrou d’espace n’en laisse passer qu’un', async () => {
    const issues = await Promise.allSettled([deposer(t, fichier(600, 1), 1000), deposer(t, fichier(600, 2), 1000)]);
    expect(issues.filter((i) => i.status === 'fulfilled')).toHaveLength(1);
    const refus = issues.find((i) => i.status === 'rejected') as PromiseRejectedResult;
    expect(refus.reason).toBeInstanceOf(LimiteOffreError);
    expect(await store.occupation(t)).toBe(600);
  });

  it('🔴 le même fichier déposé deux fois rend la même fiche, sans rien consommer, même au-dessus du quota', async () => {
    const premier = await deposer(t, fichier(800, 7), 1000);
    const second = await deposer(t, fichier(800, 7), 800);
    expect(second.existant).toBe(true);
    expect(second.media.code).toBe(premier.media.code);
    expect(await store.occupation(t)).toBe(800);
    // Un autre espace qui dépose le même fichier a SA fiche : l'empreinte ne traverse jamais les espaces.
    const ailleurs = await deposer(autre, fichier(800, 7));
    expect(ailleurs.existant).toBe(false);
    expect(ailleurs.media.code).not.toBe(premier.media.code);
  });

  it('🔴 point de revue 4 : redéposé pendant sa suppression douce, le fichier a une NOUVELLE fiche, que la purge de l’ancienne n’emporte pas', async () => {
    const ancien = await deposer(t, fichier(300, 3));
    expect(await store.supprimer(t, ancien.media.code)).toEqual({ issue: 'supprime' });
    const nouveau = await deposer(t, fichier(300, 3));
    expect(nouveau.existant).toBe(false);
    expect(nouveau.media.code).not.toBe(ancien.media.code);
    expect(await store.occupation(t)).toBe(300);
    await vieillir(ancien.media.code, GRACE_SUPPRESSION_JOURS + 1);
    expect(await store.purgerSupprimes(100)).toBe(1);
    expect(await store.getByCode(nouveau.media.code)).not.toBeNull();
    expect(await store.getByCode(ancien.media.code)).toBeNull();
  });

  it('🔴 supprimer : le fichier sort de la liste et du quota, reste servi 30 jours, puis la purge l’efface', async () => {
    const { media } = await deposer(t, fichier(400, 4));
    expect(await store.supprimer(t, media.code)).toEqual({ issue: 'supprime' });
    expect(await store.lister(t)).toEqual([]);
    expect(await store.occupation(t)).toBe(0);
    expect(await store.getByCode(media.code)).not.toBeNull();
    // Deux suppressions : la seconde ne trouve plus rien de vivant.
    expect(await store.supprimer(t, media.code)).toEqual({ issue: 'introuvable' });

    await vieillir(media.code, GRACE_SUPPRESSION_JOURS - 1);
    expect(await store.purgerSupprimes(100)).toBe(0);
    expect(await store.getByCode(media.code)).not.toBeNull();

    await vieillir(media.code, GRACE_SUPPRESSION_JOURS + 1);
    expect(await store.getByCode(media.code)).toBeNull();
    expect(await store.purgerSupprimes(100)).toBe(1);
    const r = await pool.query('select 1 from rcs_media where code = $1', [media.code]);
    expect(r.rowCount).toBe(0);
  });

  it('🔴 un espace ne supprime jamais le fichier d’un autre', async () => {
    const { media } = await deposer(autre, fichier(200, 5));
    expect(await store.supprimer(t, media.code)).toEqual({ issue: 'introuvable' });
    expect(await store.occupation(autre)).toBe(200);
  });

  describe('🔴 ce qui utilise encore un fichier, lieu par lieu', () => {
    const lien = (code: string) => `https://api.messagingme.app/m/${code}.png`;
    const graphe = (code: string) => JSON.stringify({ nodes: [{ id: 'q', type: 'quick_message', data: { imageUrl: lien(code) } }], edges: [] });
    const rcs = (code: string) => JSON.stringify({ kind: 'card', card: { description: 'x', mediaUrl: lien(code) } });

    it('un scénario, par son publié OU par son brouillon', async () => {
      const a = (await deposer(t, fichier(100, 10))).media.code;
      const b = (await deposer(t, fichier(100, 11))).media.code;
      await pool.query(`insert into workflows (tenant_id, name, graph) values ($1, 'Publié', $2)`, [t, graphe(a)]);
      await pool.query(`insert into workflows (tenant_id, name, draft_graph) values ($1, 'Brouillon', $2)`, [t, graphe(b)]);
      expect(await store.utilisations(t, a)).toEqual([{ lieu: 'scenario', nom: 'Publié' }]);
      expect(await store.utilisations(t, b)).toEqual([{ lieu: 'scenario', nom: 'Brouillon' }]);
      const refus = await store.supprimer(t, a);
      expect(refus).toEqual({ issue: 'utilise', utilisations: [{ lieu: 'scenario', nom: 'Publié' }] });
      expect(await store.occupation(t)).toBe(200);
    });

    it('un message RCS enregistré, sauf s’il est supprimé', async () => {
      const a = (await deposer(t, fichier(100, 12))).media.code;
      await pool.query(`insert into rcs_messages (tenant_id, name, content) values ($1, 'Promo', $2)`, [t, rcs(a)]);
      expect(await store.utilisations(t, a)).toEqual([{ lieu: 'message_rcs', nom: 'Promo' }]);
      await pool.query(`update rcs_messages set deleted_at = now() where tenant_id = $1`, [t]);
      expect(await store.utilisations(t, a)).toEqual([]);
    });

    it('une campagne pas terminée, par son message ou par un étage de sa chaîne ; une campagne terminée ne compte pas', async () => {
      const a = (await deposer(t, fichier(100, 13))).media.code;
      const b = (await deposer(t, fichier(100, 14))).media.code;
      await pool.query(`insert into campaigns (tenant_id, name, category, status, rcs_message) values ($1, 'Lancement', 'marketing', 'scheduled', $2)`, [t, rcs(a)]);
      const c = (await pool.query<{ id: string }>(
        `insert into campaigns (tenant_id, name, category, status) values ($1, 'Relance', 'marketing', 'running') returning id`, [t],
      )).rows[0]!.id;
      await pool.query(`insert into campaign_etages (campaign_id, rang, canal, rcs_message) values ($1, 2, 'rcs', $2)`, [c, rcs(b)]);
      expect(await store.utilisations(t, a)).toEqual([{ lieu: 'campagne', nom: 'Lancement' }]);
      expect(await store.utilisations(t, b)).toEqual([{ lieu: 'campagne', nom: 'Relance' }]);
      await pool.query(`update campaigns set status = 'completed' where tenant_id = $1`, [t]);
      expect(await store.utilisations(t, a)).toEqual([]);
      expect(await store.utilisations(t, b)).toEqual([]);
    });

    it('un brouillon de campagne', async () => {
      const a = (await deposer(t, fichier(100, 15))).media.code;
      await pool.query(`insert into campaign_drafts (tenant_id, name, state) values ($1, 'Rentrée', $2)`, [t, JSON.stringify({ rcs: { imageUrl: lien(a) } })]);
      expect(await store.utilisations(t, a)).toEqual([{ lieu: 'brouillon_campagne', nom: 'Rentrée' }]);
    });

    it('une adresse collée en MAJUSCULES est vue quand même : /m/ la sert (relecture du lot B, jaune n° 7)', async () => {
      const a = (await deposer(t, fichier(100, 17))).media.code;
      await pool.query(`insert into workflows (tenant_id, name, graph) values ($1, 'Majuscules', $2)`, [t, graphe(a.toUpperCase())]);
      expect(await store.utilisations(t, a)).toEqual([{ lieu: 'scenario', nom: 'Majuscules' }]);
    });

    it('le contenu d’un AUTRE espace qui cite le code ne bloque rien', async () => {
      const a = (await deposer(t, fichier(100, 16))).media.code;
      await pool.query(`insert into workflows (tenant_id, name, graph) values ($1, 'Ailleurs', $2)`, [autre, graphe(a)]);
      expect(await store.utilisations(t, a)).toEqual([]);
    });
  });
});
