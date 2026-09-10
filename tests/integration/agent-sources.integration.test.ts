import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgSourceStore } from '../../src/agent/sources.pg';
import { LabelSourceDejaPris } from '../../src/agent/sources';

const url = process.env.DATABASE_URL ?? '';

/**
 * Les sources externes d'outils (migration 0088, lot L2).
 *
 * 🔴 POURQUOI EN INTÉGRATION, ET PAS AVEC UN DOUBLE. Tout ce qui compte ici est du SQL ou de la cryptographie
 * au repos : que le secret soit RÉELLEMENT chiffré dans la colonne (un faux store dirait oui à tout), que les
 * projections publiques ne le sélectionnent jamais, que la contrainte d'authentification de la migration
 * refuse une source `bearer` sans secret, que deux clients soient étanches, et que supprimer une source
 * emporte ses outils.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('sources externes d outils (Postgres)', () => {
  let pool: Pool;
  let sources: PgSourceStore;
  let tenantId: string;
  let autreTenantId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    sources = new PgSourceStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-sources') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-sources-autre') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('🔴 le secret est CHIFFRÉ dans la colonne, et la projection publique ne le rend pas', async () => {
    // Le seul test qui prouve le chiffrement au repos : on relit la colonne BRUTE et on vérifie que la valeur
    // en clair n'y est pas. Un store qui oublierait `encryptSecret` passerait tous les autres tests.
    const s = await sources.creer(tenantId, {
      kind: 'http', label: 'ERP', baseUrl: 'https://api.client.fr/v1',
      authKind: 'bearer', authSecret: 'jeton-tres-secret-42',
    });
    expect(s.aAuthentification).toBe(true);
    expect(JSON.stringify(s)).not.toContain('jeton-tres-secret-42');

    const brut = await pool.query<{ auth_secret_enc: string }>('select auth_secret_enc from agent_tool_sources where id = $1', [s.id]);
    expect(brut.rows[0]!.auth_secret_enc).not.toContain('jeton-tres-secret-42');
    // Et il se relit en clair par le SEUL chemin prévu pour ça.
    expect((await sources.pourAppel(tenantId, s.id))!.authSecret).toBe('jeton-tres-secret-42');
    // La liste, elle, ne le porte jamais.
    expect(JSON.stringify(await sources.lister(tenantId))).not.toContain('jeton-tres-secret-42');
  });

  it('🔴 un secret ABSENT du patch ne l’efface pas', async () => {
    // L'écran ne peut pas renvoyer le secret : il ne l'a jamais eu. Renommer une source ne doit donc pas
    // couper l'authentification du connecteur, ce qui se verrait au premier contact et pas avant.
    const s = await sources.creer(tenantId, {
      kind: 'http', label: 'Stock', baseUrl: 'https://api.client.fr/stock', authKind: 'bearer', authSecret: 'abc123',
    });
    await sources.patch(tenantId, s.id, { label: 'Stock (prod)' });
    expect((await sources.pourAppel(tenantId, s.id))!.authSecret).toBe('abc123');
    // Passer en « aucune authentification » le retire, en revanche : la contrainte l'exige, et garder un
    // secret que plus rien n'utilise n'a aucun intérêt.
    await sources.patch(tenantId, s.id, { authKind: 'none' });
    expect((await sources.pourAppel(tenantId, s.id))!.authSecret).toBeNull();
  });

  it('🔴 « aucune authentification » ET un secret dans le MÊME patch ne casse pas la requête', async () => {
    // Écrites en deux `if` indépendants, ces deux clauses poussaient DEUX fois `auth_secret_enc` dans le même
    // `update ... set` : Postgres refuse une double affectation de colonne, et l'erreur remontait en 500,
    // dont Cloudflare remplace le corps. Le client voyait une page d'incident sur un écran de configuration.
    const s = await sources.creer(tenantId, {
      kind: 'http', label: 'Contradictoire', baseUrl: 'https://api.client.fr/c', authKind: 'bearer', authSecret: 'avant',
    });
    const apres = await sources.patch(tenantId, s.id, { authKind: 'none', authSecret: 'apres' });
    expect(apres!.authKind).toBe('none');
    // `none` gagne : la contrainte de la migration refuserait un secret sur ce mode, et c'est le mode qui a
    // été demandé explicitement.
    expect((await sources.pourAppel(tenantId, s.id))!.authSecret).toBeNull();
  });

  it('🔴 TOUCHER À L’AUTHENTIFICATION DÉPUBLIE LE SECRET, donc la publication suivante le repose', async () => {
    // Meta ne rend JAMAIS le secret d'un connecteur : on ne peut pas comparer le sien au nôtre, seulement se
    // souvenir de ce qu'on a posé. Sans ce drapeau, la publication ne posait le secret qu'à la CRÉATION du
    // connecteur : un client qui faisait tourner son jeton le voyait pris en compte par ses agents et PAS
    // par l'agent de Meta, qui présentait l'ancien jusqu'à ce qu'un contact découvre l'outil muet.
    const s = await sources.creer(tenantId, {
      kind: 'http', label: 'Rotation', baseUrl: 'https://api.client.fr/rot', authKind: 'bearer', authSecret: 'v1',
    });
    // Née NON publiée : un connecteur qui n'existe pas encore chez Meta n'a rien reçu.
    expect(s.secretPublie).toBe(false);

    await sources.marquerSecretPublie(tenantId, s.id);
    expect((await sources.parId(tenantId, s.id))!.secretPublie).toBe(true);

    // Renommer ne touche PAS à l'authentification : reposer le secret à cette occasion serait un appel à Meta
    // pour rien, et surtout cela ferait mentir le test « publier deux fois ne produit aucun geste ».
    await sources.patch(tenantId, s.id, { label: 'Rotation (prod)' });
    expect((await sources.parId(tenantId, s.id))!.secretPublie).toBe(true);

    // Le secret change : Meta doit le recevoir.
    await sources.patch(tenantId, s.id, { authSecret: 'v2' });
    expect((await sources.parId(tenantId, s.id))!.secretPublie).toBe(false);

    // ⚠️ ET LE MODE COMPTE AUTANT QUE LE SECRET : `bearer` -> `header` change le corps envoyé à Meta
    // (`corpsApiKey`), donc l'en-tête présenté. N'écouter que le secret laisserait Meta présenter le bon
    // jeton dans le mauvais en-tête, ce qui ressemble à un jeton refusé et se diagnostique très mal.
    await sources.marquerSecretPublie(tenantId, s.id);
    await sources.patch(tenantId, s.id, { authKind: 'header', authHeaderName: 'X-Cle' });
    expect((await sources.parId(tenantId, s.id))!.secretPublie).toBe(false);
  });

  it('🔴 la base REFUSE une source « bearer » sans secret', async () => {
    // Elle signerait avec une chaîne vide, et le système du client répondrait 401 qu'on mettrait sur le dos
    // de ses identifiants.
    await expect(sources.creer(tenantId, { kind: 'http', label: 'Sans jeton', baseUrl: 'https://api.client.fr/x', authKind: 'bearer' }))
      .rejects.toThrow();
    await expect(sources.creer(tenantId, { kind: 'http', label: 'Header sans nom', baseUrl: 'https://api.client.fr/x', authKind: 'header', authSecret: 'v' }))
      .rejects.toThrow();
  });

  it('un libellé en double rend une erreur TYPÉE (donc un 409, pas un 500)', async () => {
    await sources.creer(tenantId, { kind: 'http', label: 'Doublon', baseUrl: 'https://api.client.fr/a', authKind: 'none' });
    await expect(sources.creer(tenantId, { kind: 'http', label: 'doublon', baseUrl: 'https://api.client.fr/b', authKind: 'none' }))
      .rejects.toBeInstanceOf(LabelSourceDejaPris);
  });

  it('🔴 deux clients sont ÉTANCHES, en lecture comme à l’appel', async () => {
    const mienne = await sources.creer(tenantId, { kind: 'http', label: 'Privee', baseUrl: 'https://api.client.fr/prive', authKind: 'bearer', authSecret: 'x' });
    expect(await sources.parId(autreTenantId, mienne.id)).toBeNull();
    expect(await sources.pourAppel(autreTenantId, mienne.id)).toBeNull();
    expect(await sources.patch(autreTenantId, mienne.id, { label: 'volee' })).toBeNull();
    expect(await sources.supprimer(autreTenantId, mienne.id)).toBe(false);
    expect((await sources.lister(autreTenantId)).some((s) => s.id === mienne.id)).toBe(false);
  });

  it('la dernière épreuve se lit, et une réussite efface l’erreur précédente', async () => {
    const s = await sources.creer(tenantId, { kind: 'http', label: 'Epreuve', baseUrl: 'https://api.client.fr/e', authKind: 'none' });
    await sources.marquerEpreuve(tenantId, s.id, false, 'jeton expiré');
    let lu = (await sources.parId(tenantId, s.id))!;
    expect(lu.lastError).toBe('jeton expiré');
    expect(lu.lastOkAt).toBeNull();
    await sources.marquerEpreuve(tenantId, s.id, true);
    lu = (await sources.parId(tenantId, s.id))!;
    expect(lu.lastError).toBeNull();
    expect(lu.lastOkAt).not.toBeNull();
  });

  it('🔴 supprimer une source emporte ses outils, et le compteur d’outils ACTIFS est juste', async () => {
    // `on delete cascade` : un outil `http` orphelin violerait la contrainte d'intégrité de la 0088, et
    // resterait de toute façon inappelable.
    const agentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest', 'IA', 'm') returning id`, [tenantId],
    )).rows[0]!.id;
    const s = await sources.creer(tenantId, { kind: 'http', label: 'AvecOutils', baseUrl: 'https://api.client.fr/o', authKind: 'none' });
    const userId = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role) values ($1, 'itest-src@e.test', 'admin') returning id`, [tenantId],
    )).rows[0]!.id;
    // ⚠️ DEUX ÉCRITURES DEPUIS LA MIGRATION 0127 : la définition PUIS le consentement. `outilsActifs` compte
    // désormais par la jointure, donc une définition sans ligne de liaison compterait ZÉRO et ce test
    // vérifierait le contraire de ce qu'il annonce.
    const outil = await pool.query<{ id: string }>(
      `insert into agent_tools (tenant_id, agent_id, origin, source_id, name, title, description, ne_pas_utiliser, params, binding, risk, actif, active_par, active_le)
       values ($1, $2, 'http', $3, 'lire_commande', 'Lire', 'd', 'n', '[]'::jsonb, '{}'::jsonb, 'read', true, $4, now()) returning id`,
      [tenantId, agentId, s.id, userId],
    );
    await pool.query(
      `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, actif, active_par, active_le)
       values ($1, $2, $3, true, $4, now())`,
      [tenantId, outil.rows[0]!.id, `agent:${agentId}`, userId],
    );
    expect((await sources.parId(tenantId, s.id))!.outilsActifs).toBe(1);

    await sources.supprimer(tenantId, s.id);
    const reste = await pool.query('select 1 from agent_tools where source_id = $1', [s.id]);
    expect(reste.rowCount).toBe(0);
  });

  it('🔴 la base REFUSE un outil externe SANS source, et un outil maison AVEC', async () => {
    // La contrainte d'intégrité de la 0088. Sans elle, un outil `http` sans source serait actif, exposé au
    // modèle, et refuserait à chaque appel : le client verrait un agent qui « ne fait rien ».
    const agentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest2', 'IA', 'm') returning id`, [tenantId],
    )).rows[0]!.id;
    const insere = (origin: string, sourceId: string | null) => pool.query(
      `insert into agent_tools (tenant_id, agent_id, origin, source_id, name, title, description, ne_pas_utiliser, params, binding, risk)
       values ($1, $2, $3, $4, 'x_' || substr(md5(random()::text), 1, 8), 't', 'd', 'n', '[]'::jsonb, '{}'::jsonb, 'read')`,
      [tenantId, agentId, origin, sourceId],
    );
    const s = await sources.creer(tenantId, { kind: 'http', label: 'Integrite', baseUrl: 'https://api.client.fr/i', authKind: 'none' });
    await expect(insere('http', null)).rejects.toThrow();
    await expect(insere('mba', s.id)).rejects.toThrow();
    await expect(insere('http', s.id)).resolves.toBeDefined();
  });
});
