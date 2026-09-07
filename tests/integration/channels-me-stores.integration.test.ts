import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgChannelsMeConnectionStore } from '../../src/channels-me/connection-store.pg';
import { PgChannelsMeLinkStore } from '../../src/channels-me/link-store.pg';
import { PgChannelsMePostStore } from '../../src/channels-me/post-store.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier cree/supprime des tenants. La CI monte un Postgres jetable pour ca
// (job `integration`) : c est la qu il doit tourner. `describe.skipIf(!url)` le rend inerte si DATABASE_URL
// n est pas defini, mais ne protege pas contre un DATABASE_URL defini qui pointerait sur la prod.
const url = process.env.DATABASE_URL ?? '';

/**
 * Les trois stores Channels Me contre un vrai Postgres.
 *
 * 🔴 POURQUOI EN INTEGRATION ET PAS AVEC UN DOUBLE. Tout ce qui compte ici est du SQL ou de la cryptographie
 * au repos : que les deux secrets soient REELLEMENT chiffres dans leurs colonnes (un faux pool dit oui a
 * tout), que la clause `where tenant_id` isole vraiment deux clients, et que les deux index uniques poses
 * par la migration 0114 refusent vraiment un doublon. Les tests a faux pool prouvent la FORME des requetes,
 * ceux-ci prouvent leur EFFET.
 */

// Cle FICTIVE (aucun secret) : 64 caracteres hex, valeur figee. Le contrat injecte la cle par le
// constructeur du store, donc ce fichier ne depend PAS de l ENCRYPTION_KEY jetable que la CI tire pour les
// tests du store SMTP.
const CLE = 'c'.repeat(64);
const CLE_API = 'cle-api-channelsme-itest';
const SECRET_HMAC = 'secret-hmac-channelsme-itest';

describe.skipIf(!url)('Stores Channels Me (Postgres reel)', () => {
  let pool: Pool;
  let tenantId: string;
  let autreTenantId: string;
  let workflowId: string;
  let autreWorkflowId: string;
  let automationId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    const t = await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-channelsme') returning id`,
    );
    tenantId = t.rows[0]!.id;
    const t2 = await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-channelsme-autre') returning id`,
    );
    autreTenantId = t2.rows[0]!.id;

    // Un scenario par tenant : `channelsme_links.workflow_id` est une cle etrangere sur `workflows`.
    const wf = await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-channelsme-wf') returning id`, [tenantId],
    );
    workflowId = wf.rows[0]!.id;
    const wf2 = await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-channelsme-wf-autre') returning id`, [autreTenantId],
    );
    autreWorkflowId = wf2.rows[0]!.id;

    // L automation compagnon, creee ETEINTE comme le fera la route (elle s allume a la publication).
    const auto = await pool.query<{ id: string }>(
      `insert into automations (tenant_id, name, trigger_kind, trigger_config, workflow_id)
       values ($1, 'itest-channelsme-auto', 'keyword', '{"keywords":["cm-itest001"],"mode":"contains"}'::jsonb, $2)
       returning id`,
      [tenantId, workflowId],
    );
    automationId = auto.rows[0]!.id;
  });

  afterAll(async () => {
    // 🔴 ON NETTOIE A LA MAIN, contrairement a l usage du depot (« les lignes partent par cascade avec le
    // tenant »). La migration 0114 pose DEUX cles etrangeres en `on delete restrict` : workflow_id du lien,
    // et link_id du post. Supprimer le tenant cascade EN MEME TEMPS vers `workflows`, `channelsme_links` et
    // `channelsme_posts`, et l ordre entre ces branches n est pas garanti ; or RESTRICT n est PAS differable,
    // donc une branche qui supprime un workflow avant son lien fait echouer tout le nettoyage. On retire
    // les enfants d abord, du plus profond au moins profond.
    for (const t of [tenantId, autreTenantId]) {
      if (!t) continue;
      await pool.query('delete from channelsme_posts where tenant_id = $1', [t]);
      await pool.query('delete from channelsme_links where tenant_id = $1', [t]);
    }
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  describe('PgChannelsMeConnectionStore', () => {
    it('🔴 les deux secrets sont CHIFFRES dans leurs colonnes, et get() ne les rend pas', async () => {
      const store = new PgChannelsMeConnectionStore(pool, CLE);
      await store.upsert(tenantId, { orgId: 'org-1', channelId: 'ch-1', apiKey: CLE_API, secret: SECRET_HMAC });

      // Le seul test qui prouve le chiffrement au repos : on relit les colonnes BRUTES. Un store qui
      // oublierait encryptSecret passerait tous les autres.
      const brut = (await pool.query<{ api_key_enc: string; secret_enc: string }>(
        `select api_key_enc, secret_enc from channelsme_connections where tenant_id = $1`, [tenantId],
      )).rows[0]!;
      expect(brut.api_key_enc).not.toContain(CLE_API);
      expect(brut.secret_enc).not.toContain(SECRET_HMAC);
      expect(brut.api_key_enc.startsWith('v1.')).toBe(true);
      expect(brut.secret_enc.startsWith('v1.')).toBe(true);

      const publique = await store.get(tenantId);
      expect(publique).toEqual({
        orgId: 'org-1', channelId: 'ch-1', hasApiKey: true, hasSecret: true, verifiedAt: null,
      });
      expect((publique as unknown as Record<string, unknown>).apiKey).toBeUndefined();
      expect((publique as unknown as Record<string, unknown>).secret).toBeUndefined();
    });

    it('getSecrets() : aller-retour reel, les deux clairs reviennent', async () => {
      const store = new PgChannelsMeConnectionStore(pool, CLE);
      await store.upsert(tenantId, { orgId: 'org-1', channelId: 'ch-1', apiKey: CLE_API, secret: SECRET_HMAC });
      expect(await store.getSecrets(tenantId)).toEqual({
        orgId: 'org-1', channelId: 'ch-1', apiKey: CLE_API, secret: SECRET_HMAC,
      });
    });

    it('🔴 remplacer les creds efface verified_at, et markVerified le repose', async () => {
      const store = new PgChannelsMeConnectionStore(pool, CLE);
      await store.upsert(tenantId, { orgId: 'org-1', channelId: 'ch-1', apiKey: CLE_API, secret: SECRET_HMAC });
      expect((await store.get(tenantId))?.verifiedAt).toBeNull();

      await store.markVerified(tenantId);
      expect((await store.get(tenantId))?.verifiedAt).not.toBeNull();

      // Nouveaux creds : la preuve de validite portait sur les ANCIENS, elle tombe.
      await store.upsert(tenantId, { orgId: 'org-2', channelId: 'ch-2', apiKey: 'autre-cle', secret: 'autre-secret' });
      const apres = await store.get(tenantId);
      expect(apres?.orgId).toBe('org-2');
      expect(apres?.verifiedAt).toBeNull();
      expect((await store.getSecrets(tenantId))?.apiKey).toBe('autre-cle');
    });

    it('isolation cross-tenant REELLE : rien de ce qui se fait au nom d un autre tenant ne touche la connexion du proprietaire', async () => {
      const store = new PgChannelsMeConnectionStore(pool, CLE);
      await store.upsert(tenantId, { orgId: 'org-proprio', channelId: 'ch-proprio', apiKey: CLE_API, secret: SECRET_HMAC });
      await store.markVerified(tenantId);

      // Le voisin ne voit rien, ni en public ni en clair.
      expect(await store.get(autreTenantId)).toBeNull();
      expect(await store.getSecrets(autreTenantId)).toBeNull();
      // markVerified sur un tenant sans ligne : void, ne doit rien toucher, juste ne pas planter.
      await store.markVerified(autreTenantId);

      // Et le voisin peut avoir la SIENNE sans ecraser celle du proprietaire (cle primaire tenant_id).
      await store.upsert(autreTenantId, { orgId: 'org-voisin', channelId: 'ch-voisin', apiKey: 'cle-voisine', secret: 'secret-voisin' });

      const proprio = await store.get(tenantId);
      expect(proprio?.orgId).toBe('org-proprio');
      expect(proprio?.verifiedAt).not.toBeNull(); // aucune des tentatives voisines n a laisse de trace
      expect((await store.getSecrets(autreTenantId))?.apiKey).toBe('cle-voisine');
    });
  });

  describe('PgChannelsMeLinkStore', () => {
    it('create() + list() + byId() : aller-retour reel, mapping et tri par created_at desc', async () => {
      const store = new PgChannelsMeLinkStore(pool);
      const un = await store.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest001',
        phrase: 'Je veux recevoir la newsletter', automationId, maxParHeure: 5000,
      });
      expect(un.id).toBeTruthy();
      expect(un.tenantId).toBe(tenantId);
      expect(un.maxParHeure).toBe(5000);
      expect(un.automationId).toBe(automationId);
      expect(typeof un.createdAt).toBe('string'); // ISO, jamais un objet Date

      const deux = await store.create(tenantId, {
        workflowId, startNodeId: 'nod_abc', token: 'cm-itest002',
        phrase: 'Je veux le guide', automationId: null, maxParHeure: null,
      });

      const liste = await store.list(tenantId);
      expect(liste.map((l) => l.token).slice(0, 2)).toEqual(['cm-itest002', 'cm-itest001']); // plus recent d abord
      expect(await store.byId(tenantId, deux.id)).toMatchObject({ startNodeId: 'nod_abc', maxParHeure: null });
    });

    it('🔴 le jeton est unique GLOBALEMENT, pas par tenant : refuse aussi chez un AUTRE tenant', async () => {
      const store = new PgChannelsMeLinkStore(pool);
      await store.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest003', phrase: 'Bonjour',
        automationId: null, maxParHeure: null,
      });

      // Meme tenant : refuse (comme partout ailleurs dans le depot).
      await expect(store.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest003', phrase: 'Bonjour bis',
        automationId: null, maxParHeure: null,
      })).rejects.toThrow();

      // ⚠️ AUTRE tenant : refuse AUSSI, et c est l inverse de l usage du depot (index scopes tenant_id). Le
      // jeton est cherche sur le chemin chaud a partir du seul message entrant : deux tenants qui
      // partageraient un jeton rendraient le declenchement ambigu.
      await expect(store.create(autreTenantId, {
        workflowId: autreWorkflowId, startNodeId: null, token: 'cm-itest003', phrase: 'Chez le voisin',
        automationId: null, maxParHeure: null,
      })).rejects.toThrow();
    });

    it('isolation cross-tenant REELLE : un lien ne se voit ni en liste ni par id depuis un autre tenant', async () => {
      const store = new PgChannelsMeLinkStore(pool);
      const lien = await store.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest004', phrase: 'Isolation',
        automationId: null, maxParHeure: null,
      });

      expect(await store.byId(autreTenantId, lien.id)).toBeNull();
      expect((await store.list(autreTenantId)).some((l) => l.id === lien.id)).toBe(false);
      // Le proprietaire, lui, le voit toujours : aucune tentative voisine n a laisse de trace.
      expect((await store.byId(tenantId, lien.id))?.phrase).toBe('Isolation');
    });
  });

  describe('PgChannelsMePostStore', () => {
    it('create() + list() : aller-retour reel, avec lien puis sans lien', async () => {
      const liens = new PgChannelsMeLinkStore(pool);
      const posts = new PgChannelsMePostStore(pool);
      const lien = await liens.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest005', phrase: 'Post',
        automationId: null, maxParHeure: null,
      });

      await posts.create(tenantId, { cmMessageId: 'cmmsg-2001', linkId: lien.id });
      await posts.create(tenantId, { cmMessageId: 'cmmsg-2002', linkId: null });

      const liste = await posts.list(tenantId);
      expect(liste.map((p) => p.cmMessageId).slice(0, 2)).toEqual(['cmmsg-2002', 'cmmsg-2001']);
      expect(liste.find((p) => p.cmMessageId === 'cmmsg-2001')?.linkId).toBe(lien.id);
      expect(liste.find((p) => p.cmMessageId === 'cmmsg-2002')?.linkId).toBeNull();
    });

    it('unicite (tenant_id, cm_message_id) : doublon refuse sur le MEME tenant, libre sur un AUTRE', async () => {
      const posts = new PgChannelsMePostStore(pool);
      await posts.create(tenantId, { cmMessageId: 'cmmsg-3001', linkId: null });
      await expect(posts.create(tenantId, { cmMessageId: 'cmmsg-3001', linkId: null })).rejects.toThrow();

      // Index scope tenant_id, cette fois : le meme identifiant chez un AUTRE tenant ne rentre pas en conflit.
      await posts.create(autreTenantId, { cmMessageId: 'cmmsg-3001', linkId: null });
      expect((await posts.list(autreTenantId)).some((p) => p.cmMessageId === 'cmmsg-3001')).toBe(true);
    });

    it('🔴 un lien reference par un post ne se supprime pas : la ceinture qui rend l extinction obligatoire', async () => {
      const liens = new PgChannelsMeLinkStore(pool);
      const posts = new PgChannelsMePostStore(pool);
      const lien = await liens.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest006', phrase: 'Restrict',
        automationId: null, maxParHeure: null,
      });
      await posts.create(tenantId, { cmMessageId: 'cmmsg-4001', linkId: lien.id });

      // Un post publie circule pour toujours : la suppression dure laisserait un bouton mort sans trace.
      // La route repondra 409 et proposera l extinction ; cette contrainte est la ceinture sous la route.
      await expect(pool.query('delete from channelsme_links where id = $1', [lien.id])).rejects.toThrow();
      expect(await liens.byId(tenantId, lien.id)).not.toBeNull();
    });

    it('isolation cross-tenant REELLE : les posts du proprietaire ne se voient pas du voisin', async () => {
      const posts = new PgChannelsMePostStore(pool);
      await posts.create(tenantId, { cmMessageId: 'cmmsg-5001', linkId: null });
      expect((await posts.list(autreTenantId)).some((p) => p.cmMessageId === 'cmmsg-5001')).toBe(false);
      expect((await posts.list(tenantId)).some((p) => p.cmMessageId === 'cmmsg-5001')).toBe(true);
    });
  });

  /**
   * 🔴 AJOUT DU CONTROLEUR (2026-09-04), absent du brief extrait : chaque contrainte posee par la migration
   * 0114 doit etre EPROUVEE par un test qui tente de la violer, pas seulement traversee en passant par un
   * test fonctionnel. Deux des trois le sont deja plus haut (le jeton unique GLOBALEMENT dans le describe
   * `PgChannelsMeLinkStore`, l unicite (tenant_id, cm_message_id) dans le describe `PgChannelsMePostStore`) ;
   * ce bloc les rend explicites et couvre la troisieme, qui n etait testee nulle part : le `on delete
   * restrict` sur `channelsme_links.workflow_id`.
   */
  describe('Contraintes de la migration 0114, une par une', () => {
    it('unicite GLOBALE du jeton (channelsme_links_token_key) : deux TENANTS DIFFERENTS ne portent pas le meme jeton', async () => {
      const store = new PgChannelsMeLinkStore(pool);
      await store.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-contrainte-jeton', phrase: 'Un',
        automationId: null, maxParHeure: null,
      });
      await expect(store.create(autreTenantId, {
        workflowId: autreWorkflowId, startNodeId: null, token: 'cm-contrainte-jeton', phrase: 'Deux',
        automationId: null, maxParHeure: null,
      })).rejects.toThrow();
    });

    it('🔴 on delete restrict sur channelsme_links.workflow_id : supprimer un scenario vise par un lien echoue', async () => {
      // Un scenario dedie a ce test, pour ne pas dependre du workflow partage par les autres describe (dont
      // certains y creent aussi des liens) : la suppression doit echouer ICI, sans effet de bord ailleurs.
      const wf = await pool.query<{ id: string }>(
        `insert into workflows (tenant_id, name) values ($1, 'itest-channelsme-wf-restrict') returning id`,
        [tenantId],
      );
      const workflowIdDedie = wf.rows[0]!.id;
      const store = new PgChannelsMeLinkStore(pool);
      const lien = await store.create(tenantId, {
        workflowId: workflowIdDedie, startNodeId: null, token: 'cm-contrainte-workflow', phrase: 'Restrict workflow',
        automationId: null, maxParHeure: null,
      });

      await expect(pool.query('delete from workflows where id = $1', [workflowIdDedie])).rejects.toThrow();
      // Le lien est toujours la : RESTRICT a bien empeche la suppression, pas seulement leve une erreur a cote.
      expect(await store.byId(tenantId, lien.id)).not.toBeNull();
    });

    it('unicite (tenant_id, cm_message_id) sur channelsme_posts : doublon refuse sur le MEME tenant', async () => {
      const posts = new PgChannelsMePostStore(pool);
      await posts.create(tenantId, { cmMessageId: 'cmmsg-contrainte-unique', linkId: null });
      await expect(posts.create(tenantId, { cmMessageId: 'cmmsg-contrainte-unique', linkId: null })).rejects.toThrow();
    });
  });

  /**
   * 🔴 AJOUT DU CONTROLEUR (2026-09-04), absent du brief extrait : `allumerAutomation`/`eteindreAutomation`
   * ecrivent leur propre requete sur `automations`, hors de `PgAutomationStore`. Seul un vrai Postgres peut
   * prouver que la garde `possede_par = 'channelsme_link'` bloque vraiment l ecriture (un faux pool dirait
   * oui a tout) : on cree une automation NON possedee, on tente de l allumer via le lien qui la reference, et
   * on verifie qu AUCUNE ligne n a bouge. Le cas positif (une automation bien possedee) est verifie juste
   * apres, dans les deux sens (allumer puis eteindre), et le cas d isolation tenant cloture le lot.
   */
  describe('allumerAutomation() / eteindreAutomation() : la garde possede_par contre un vrai Postgres', () => {
    it('🔴 automation dont possede_par est null : allumerAutomation ne modifie AUCUNE ligne', async () => {
      const auto = await pool.query<{ id: string }>(
        `insert into automations (tenant_id, name, trigger_kind, trigger_config, workflow_id)
         values ($1, 'itest-channelsme-auto-non-possedee', 'keyword', '{"keywords":["cm-itest-garde"],"mode":"contains"}'::jsonb, $2)
         returning id`,
        [tenantId, workflowId],
      );
      const autoId = auto.rows[0]!.id;
      const liens = new PgChannelsMeLinkStore(pool);
      const lien = await liens.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest-garde', phrase: 'Garde',
        automationId: autoId, maxParHeure: null,
      });

      await liens.allumerAutomation(tenantId, lien.id);

      const apres = (await pool.query<{ enabled: boolean; possede_par: string | null }>(
        `select enabled, possede_par from automations where id = $1`, [autoId],
      )).rows[0]!;
      expect(apres.enabled).toBe(false); // inchangee : la garde a bloque l ecriture
      expect(apres.possede_par).toBeNull();
    });

    it('automation possedee (possede_par = channelsme_link) : allumerAutomation puis eteindreAutomation ecrivent vraiment', async () => {
      const auto = await pool.query<{ id: string }>(
        `insert into automations (tenant_id, name, trigger_kind, trigger_config, workflow_id, possede_par)
         values ($1, 'itest-channelsme-auto-possedee', 'keyword', '{"keywords":["cm-itest-possede"],"mode":"contains"}'::jsonb, $2, 'channelsme_link')
         returning id`,
        [tenantId, workflowId],
      );
      const autoId = auto.rows[0]!.id;
      const liens = new PgChannelsMeLinkStore(pool);
      const lien = await liens.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest-possede', phrase: 'Possede',
        automationId: autoId, maxParHeure: null,
      });

      await liens.allumerAutomation(tenantId, lien.id);
      expect((await pool.query<{ enabled: boolean }>(
        `select enabled from automations where id = $1`, [autoId],
      )).rows[0]!.enabled).toBe(true);

      await liens.eteindreAutomation(tenantId, lien.id);
      expect((await pool.query<{ enabled: boolean }>(
        `select enabled from automations where id = $1`, [autoId],
      )).rows[0]!.enabled).toBe(false);
    });

    it('isolation tenant : allumerAutomation depuis un AUTRE tenant sur un lien qui n est pas le sien ne modifie rien', async () => {
      const auto = await pool.query<{ id: string }>(
        `insert into automations (tenant_id, name, trigger_kind, trigger_config, workflow_id, possede_par)
         values ($1, 'itest-channelsme-auto-voisin', 'keyword', '{"keywords":["cm-itest-voisin"],"mode":"contains"}'::jsonb, $2, 'channelsme_link')
         returning id`,
        [tenantId, workflowId],
      );
      const autoId = auto.rows[0]!.id;
      const liens = new PgChannelsMeLinkStore(pool);
      const lien = await liens.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest-voisin', phrase: 'Voisin',
        automationId: autoId, maxParHeure: null,
      });

      // Le voisin ne connait pas ce lien : la sous-requete (tenant_id = autreTenantId AND id = lien.id) ne
      // rend rien, donc la clause `id = (...)` externe ne peut matcher aucune ligne.
      await liens.allumerAutomation(autreTenantId, lien.id);
      expect((await pool.query<{ enabled: boolean }>(
        `select enabled from automations where id = $1`, [autoId],
      )).rows[0]!.enabled).toBe(false);
    });
  });

  /**
   * L etat allume, LU par `list()` et `byId()`.
   *
   * Ce que ces tests protegent : sans ce champ, l etat n est lisible NULLE PART, parce que l automation
   * compagnon est possedee, donc exclue du predicat de `PgAutomationStore` et absente de `GET /automations`.
   * La console proposait deux boutons sans jamais savoir lequel avait un sens. La jointure porte la MEME
   * garde miroir que l ecriture (`tenant_id` ET `possede_par`) : on ne lit pas plus largement qu on n ecrit.
   */
  describe('enabled : l etat allume, lu sur l automation compagnon', () => {
    it('🔴 suit VRAIMENT l automation : false a la creation, true apres allumage, false apres extinction', async () => {
      const auto = await pool.query<{ id: string }>(
        `insert into automations (tenant_id, name, trigger_kind, trigger_config, workflow_id, possede_par)
         values ($1, 'itest-channelsme-auto-etat', 'keyword', '{"keywords":["cm-itest-etat"],"mode":"contains"}'::jsonb, $2, 'channelsme_link')
         returning id`,
        [tenantId, workflowId],
      );
      const liens = new PgChannelsMeLinkStore(pool);
      const lien = await liens.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest-etat', phrase: 'Etat',
        automationId: auto.rows[0]!.id, maxParHeure: null,
      });

      // 🔴 `create()` LIT deja l etat, il ne le suppose pas : sa sous-requete `returning` interroge
      // l automation compagnon. Sans elle, POST /links repondait `enabled: null` pour un lien qui vient
      // d en recevoir une, et `null` veut dire « plus d automation compagnon ».
      expect(lien.enabled).toBe(false);
      // L automation nait ETEINTE : un lien cree mais jamais publie ne declenche rien.
      expect((await liens.byId(tenantId, lien.id))!.enabled).toBe(false);

      await liens.allumerAutomation(tenantId, lien.id);
      expect((await liens.byId(tenantId, lien.id))!.enabled).toBe(true);
      expect((await liens.list(tenantId)).find((l) => l.id === lien.id)!.enabled).toBe(true);

      await liens.eteindreAutomation(tenantId, lien.id);
      expect((await liens.byId(tenantId, lien.id))!.enabled).toBe(false);
    });

    it('🔴 automation NON possedee : `enabled` sort a null, pas a son vrai etat', async () => {
      // On ne lit pas plus largement qu on n ecrit : une automation dont `possede_par` est null n appartient
      // pas au lien, donc elle ne joint pas, meme si le lien la reference. Sans la clause `possede_par` dans
      // la jointure, ce test verrait `true` : l etat d une ligne d un AUTRE proprietaire.
      const auto = await pool.query<{ id: string }>(
        `insert into automations (tenant_id, name, trigger_kind, trigger_config, workflow_id, enabled)
         values ($1, 'itest-channelsme-auto-etrangere', 'keyword', '{"keywords":["cm-itest-etrangere"],"mode":"contains"}'::jsonb, $2, true)
         returning id`,
        [tenantId, workflowId],
      );
      const liens = new PgChannelsMeLinkStore(pool);
      const lien = await liens.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest-etrangere', phrase: 'Etrangere',
        automationId: auto.rows[0]!.id, maxParHeure: null,
      });

      // La garde miroir vaut aussi pour la sous-requete de `create()`, pas seulement pour la jointure.
      expect(lien.enabled).toBeNull();
      expect((await liens.byId(tenantId, lien.id))!.enabled).toBeNull();
    });

    it('lien SANS automation compagnon : `enabled` vaut null, et null n est pas « eteint »', async () => {
      const liens = new PgChannelsMeLinkStore(pool);
      const lien = await liens.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest-sans-auto', phrase: 'Sans automation',
        automationId: null, maxParHeure: null,
      });

      expect((await liens.byId(tenantId, lien.id))!.enabled).toBeNull();
    });
  });
});
