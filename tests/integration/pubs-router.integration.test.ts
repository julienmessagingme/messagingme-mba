import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgArriveesPubStore, ATTRIBUTION_JOURS } from '../../src/pubs/arrivees.pg';
import { PgPublicitesStore } from '../../src/pubs/publicites.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du dépôt). La CI monte un Postgres jetable pour ça (job `integration`).
const url = process.env.DATABASE_URL ?? '';

const arrivee = (messageId: string) => ({
  messageId, adId: 'ad-itest-router', sourceType: 'ad', titre: 'Offre', url: 'https://fb.me/x',
  ctwaClid: 'clid-router', enStandby: false,
});

describe.skipIf(!url)('lot 3 des pubs : router et qualifier (Postgres réel)', () => {
  let pool: Pool;
  let arrivees: PgArriveesPubStore;
  let publicites: PgPublicitesStore;
  let tenantId = '';
  let voisinId = '';
  let contactId = '';

  /** Pose une publicité directement en base : la CRÉATION est le commit suivant, le routage ne la fait pas. */
  const poserPub = async (
    t: string, campagneId: string,
    o: { destination?: string; automationId?: string | null; tag?: string | null } = {},
  ) => pool.query(
    `insert into publicites (tenant_id, campagne_id, nom, destination, automation_id, tag_qualification)
     values ($1, $2, 'itest', $3, $4, $5)`,
    [t, campagneId, o.destination ?? 'scenario', o.automationId ?? null, o.tag ?? null],
  );

  /** Vieillit une arrivée de N jours, pour éprouver la fenêtre d'attribution sans attendre un mois. */
  const vieillir = async (messageId: string, jours: number) => pool.query(
    `update arrivees_pub set arrivee_le = now() - ($2::int * interval '1 day')
       where tenant_id = $1 and meta_message_id = $3`,
    [tenantId, jours, messageId],
  );

  const lire = async (messageId: string) => (await pool.query(
    `select campagne_id, issue, reprise_le, qualifie_le from arrivees_pub
       where tenant_id = $1 and meta_message_id = $2`,
    [tenantId, messageId],
  )).rows[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    arrivees = new PgArriveesPubStore(pool);
    publicites = new PgPublicitesStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-pubs-router') returning id`)).rows[0]!.id;
    voisinId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-pubs-router-v') returning id`)).rows[0]!.id;
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000701') returning id`, [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (voisinId) await pool.query('delete from tenants where id = $1', [voisinId]);
    await pool.end();
  });

  describe('la publicité d’une campagne', () => {
    it('rend la destination et l’automation, et `null` pour une campagne qu’on ne pilote pas', async () => {
      await poserPub(tenantId, 'camp-lire', { destination: 'agent_meta' });
      expect(await publicites.pubDeLaCampagne(tenantId, 'camp-lire'))
        .toEqual({ campagneId: 'camp-lire', destination: 'agent_meta', automationId: null });
      expect(await publicites.pubDeLaCampagne(tenantId, 'camp-jamais-vue')).toBeNull();
    });

    it('🔴 la campagne du VOISIN n’est pas la nôtre : un espace ne route jamais sur les pubs d’un autre', async () => {
      await poserPub(voisinId, 'camp-voisin');
      expect(await publicites.pubDeLaCampagne(tenantId, 'camp-voisin')).toBeNull();
      expect(await publicites.pubDeLaCampagne(voisinId, 'camp-voisin')).not.toBeNull();
    });

    it('une campagne est UNIQUE par espace, et les deux espaces peuvent porter la même', async () => {
      await poserPub(tenantId, 'camp-partagee');
      await poserPub(voisinId, 'camp-partagee');
      await expect(poserPub(tenantId, 'camp-partagee')).rejects.toThrow();
    });

    it('🔴 le CHECK du scénario ne ferme QU’UN SENS (leçon de 0144)', async () => {
      const wf = (await pool.query<{ id: string }>(
        `insert into workflows (tenant_id, name) values ($1, 'itest-wf-pubs') returning id`, [tenantId],
      )).rows[0]!.id;
      // Interdit : un scénario sur une pub qui envoie ses leads à l'agent de Meta. C'est une incohérence
      // de saisie, elle n'arrive jamais par accident.
      await expect(pool.query(
        `insert into publicites (tenant_id, campagne_id, nom, destination, workflow_id)
         values ($1, 'camp-chk-1', 'itest', 'agent_meta', $2)`, [tenantId, wf],
      )).rejects.toThrow();
      // AUTORISÉ, et c'est tout l'intérêt : destination scénario SANS scénario. C'est l'état où l'on tombe
      // quand le scénario est supprimé (`on delete set null`). Le refuser ferait échouer cette suppression
      // sur une contrainte de publicité, c'est-à-dire rendre 500 sur un geste ordinaire.
      await pool.query(
        `insert into publicites (tenant_id, campagne_id, nom, destination, workflow_id)
         values ($1, 'camp-chk-2', 'itest', 'scenario', $2)`, [tenantId, wf],
      );
      await pool.query('delete from workflows where id = $1 and tenant_id = $2', [wf, tenantId]);
      const r = (await pool.query(
        `select destination, workflow_id from publicites where tenant_id = $1 and campagne_id = 'camp-chk-2'`, [tenantId],
      )).rows[0];
      expect(r).toEqual({ destination: 'scenario', workflow_id: null });
    });
  });

  describe('la correspondance publicité vers campagne', () => {
    it('se mémorise, se relit, et ne se réécrit pas', async () => {
      expect(await publicites.campagneConnue(tenantId, 'ad-memo')).toBeNull();
      await publicites.memoriserPub(tenantId, 'ad-memo', 'camp-memo');
      expect(await publicites.campagneConnue(tenantId, 'ad-memo')).toBe('camp-memo');
      // Chez Meta, une pub ne change JAMAIS de campagne : un second appel ne doit pas pouvoir la déplacer.
      await publicites.memoriserPub(tenantId, 'ad-memo', 'camp-AUTRE');
      expect(await publicites.campagneConnue(tenantId, 'ad-memo')).toBe('camp-memo');
    });

    it('🔴 elle est PAR ESPACE : la mémoire du voisin ne route pas chez nous', async () => {
      await publicites.memoriserPub(voisinId, 'ad-voisin', 'camp-voisin');
      expect(await publicites.campagneConnue(tenantId, 'ad-voisin')).toBeNull();
    });
  });

  describe('l’issue du routage inscrite sur l’arrivée', () => {
    it('écrit la campagne, l’issue et l’heure de reprise', async () => {
      await arrivees.enregistrer(tenantId, '33600000701', arrivee('wamid.itest-r1'));
      const heure = new Date();
      await arrivees.noterIssue(tenantId, 'wamid.itest-r1', { campagneId: 'camp-1', issue: 'reprise_reussie', repriseLe: heure });
      const r = await lire('wamid.itest-r1');
      expect(r?.campagne_id).toBe('camp-1');
      expect(r?.issue).toBe('reprise_reussie');
      expect(r?.reprise_le).not.toBeNull();
    });

    it('🔴 LE PREMIER ROUTAGE GAGNE : un webhook redélivré ne réécrit pas l’histoire du lead', async () => {
      // Meta redélivre quand notre accusé se perd, et pg-boss rejoue un job interrompu. Sans cette règle, un
      // rejeu DÉPLACERAIT l'heure de reprise, qui est la seule mesure du délai entre l'arrivée et la prise
      // du fil : exactement le chiffre que l'essai réel du pilote doit lire.
      await arrivees.noterIssue(tenantId, 'wamid.itest-r1', { campagneId: 'camp-AUTRE', issue: 'inchange', repriseLe: null });
      const r = await lire('wamid.itest-r1');
      expect(r?.campagne_id).toBe('camp-1');
      expect(r?.issue).toBe('reprise_reussie');
      expect(r?.reprise_le).not.toBeNull();
    });

    it('une arrivée inexistante ne fait rien tomber', async () => {
      await expect(arrivees.noterIssue(tenantId, 'wamid.jamais-vu', { campagneId: null, issue: 'inchange', repriseLe: null }))
        .resolves.toBeUndefined();
    });

    it('🔴 le CHECK borne les issues : une valeur inventée est refusée en base', async () => {
      await expect(pool.query(
        `update arrivees_pub set issue = 'peut-etre' where tenant_id = $1 and meta_message_id = 'wamid.itest-r1'`,
        [tenantId],
      )).rejects.toThrow();
    });
  });

  describe('la qualification d’un lead', () => {
    beforeAll(async () => {
      await poserPub(tenantId, 'camp-tag', { tag: 'devis-envoye' });
      await poserPub(tenantId, 'camp-sans-tag');
    });

    it('🔴 qualifie l’arrivée la PLUS RÉCENTE de ce contact, et une seule', async () => {
      await arrivees.enregistrer(tenantId, '33600000701', arrivee('wamid.itest-q-vieux'));
      await arrivees.noterIssue(tenantId, 'wamid.itest-q-vieux', { campagneId: 'camp-tag', issue: 'scenario', repriseLe: null });
      await vieillir('wamid.itest-q-vieux', 3);
      await arrivees.enregistrer(tenantId, '33600000701', arrivee('wamid.itest-q-recent'));
      await arrivees.noterIssue(tenantId, 'wamid.itest-q-recent', { campagneId: 'camp-tag', issue: 'scenario', repriseLe: null });

      expect(await arrivees.qualifier(tenantId, '33600000701', 'devis-envoye')).toBe('camp-tag');
      expect((await lire('wamid.itest-q-recent'))?.qualifie_le).not.toBeNull();
      // C'est la DERNIÈRE qui a produit la conversation dans laquelle le tag a été posé. Compter les deux
      // gonflerait l'entonnoir de chaque campagne avec le travail d'une autre.
      expect((await lire('wamid.itest-q-vieux'))?.qualifie_le).toBeNull();
    });

    it('🔴 IDEMPOTENTE : un second tag ne qualifie pas une seconde fois la même arrivée', async () => {
      // Elle retombe sur la PRÉCÉDENTE, encore non qualifiée. C'est correct : deux poses successives du même
      // tag sur deux leads distincts font bien deux qualifiés.
      expect(await arrivees.qualifier(tenantId, '33600000701', 'devis-envoye')).toBe('camp-tag');
      expect((await lire('wamid.itest-q-vieux'))?.qualifie_le).not.toBeNull();
      // Plus rien à qualifier : la troisième fois ne rend rien.
      expect(await arrivees.qualifier(tenantId, '33600000701', 'devis-envoye')).toBeNull();
    });

    it(`🔴 la fenêtre d’attribution est de ${ATTRIBUTION_JOURS} jours, et elle est FERMÉE au-delà`, async () => {
      await arrivees.enregistrer(tenantId, '33600000701', arrivee('wamid.itest-q-hors'));
      await arrivees.noterIssue(tenantId, 'wamid.itest-q-hors', { campagneId: 'camp-tag', issue: 'scenario', repriseLe: null });
      await vieillir('wamid.itest-q-hors', ATTRIBUTION_JOURS + 1);
      expect(await arrivees.qualifier(tenantId, '33600000701', 'devis-envoye')).toBeNull();
      expect((await lire('wamid.itest-q-hors'))?.qualifie_le).toBeNull();
      // Et le SENS INVERSE, sans quoi ce test passerait aussi sur une fenêtre de zéro jour : la même arrivée,
      // ramenée d'un jour à l'intérieur, se qualifie.
      await vieillir('wamid.itest-q-hors', ATTRIBUTION_JOURS - 1);
      expect(await arrivees.qualifier(tenantId, '33600000701', 'devis-envoye')).toBe('camp-tag');
    });

    it('un tag qui n’est celui d’AUCUNE pub ne qualifie personne', async () => {
      await arrivees.enregistrer(tenantId, '33600000701', arrivee('wamid.itest-q-autre'));
      await arrivees.noterIssue(tenantId, 'wamid.itest-q-autre', { campagneId: 'camp-tag', issue: 'scenario', repriseLe: null });
      expect(await arrivees.qualifier(tenantId, '33600000701', 'un-tag-quelconque')).toBeNull();
      expect((await lire('wamid.itest-q-autre'))?.qualifie_le).toBeNull();
    });

    it('une arrivée dont la pub ne porte AUCUN tag de qualification n’est jamais qualifiée', async () => {
      await arrivees.enregistrer(tenantId, '33600000701', arrivee('wamid.itest-q-sans'));
      await arrivees.noterIssue(tenantId, 'wamid.itest-q-sans', { campagneId: 'camp-sans-tag', issue: 'scenario', repriseLe: null });
      expect(await arrivees.qualifier(tenantId, '33600000701', 'devis-envoye')).toBe('camp-tag');
      expect((await lire('wamid.itest-q-sans'))?.qualifie_le).toBeNull();
    });

    it('un contact SANS aucune arrivée ne fait rien tomber', async () => {
      expect(await arrivees.qualifier(tenantId, '33699999999', 'devis-envoye')).toBeNull();
    });

    it('🔴 la qualification est PAR ESPACE : le voisin ne qualifie pas nos leads', async () => {
      expect(await arrivees.qualifier(voisinId, '33600000701', 'devis-envoye')).toBeNull();
    });
  });
});
