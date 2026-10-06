import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore, type ConversationSummary } from '../../src/inbox/store.pg';

/**
 * LE STATUT « URGENT » D'UNE CONVERSATION (migration 0216, RC2, plan docs/superpowers/plans/2026-10-06-rc2-statut-urgent.md).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT, ET QU'AUCUN TEST UNITAIRE NE VOIT :
 *  - les écritures, exécutées par Postgres : poser, retirer, poser deux fois (un seul événement, le premier auteur
 *    gardé), et « Traité » et l'archivage qui lèvent l'urgence DANS LEUR PROPRE requête, avec `urgence_levee` ;
 *  - l'ORDRE de « À traiter » (les urgentes en tête) et surtout sa PAGINATION : la comparaison de tuple porte le rang
 *    d'urgence, et une page qui s'arrête à la frontière entre urgentes et non urgentes est le cas qu'un curseur mal
 *    posé casserait sans erreur (des doublons, ou un trou) ;
 *  - le dossier « Urgent » et son compteur, qui doivent dire la même chose ;
 *  - l'isolation : un autre espace ne marque rien et ne voit rien.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et ce fichier crée
 * et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

interface Ligne { type: string; acteur_id: string | null; cause: string | null }

describe.skipIf(!url)('le statut « urgent » d’une conversation', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId = '';
  let autreTenantId = '';
  let marie = '';
  let jean = '';
  let seq = 0;

  const membre = async (email: string, nom: string) => (await pool.query<{ id: string }>(
    `insert into users (tenant_id, email, name, password_hash, role) values ($1, $2, $3, 'x', 'agent') returning id`,
    [tenantId, email, nom],
  )).rows[0]!.id;

  /**
   * Une conversation « À traiter » : tenue par l'équipe, le contact a parlé en dernier. `last_direction` est écrit,
   * comme sur toute conversation réelle (un fil sans message n'entre pas dans « À traiter »).
   */
  const conversation = async (at: string, tenant = tenantId): Promise<{ id: string; waId: string }> => {
    seq += 1;
    const waId = `3361600${String(seq).padStart(4, '0')}`;
    const id = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at, control_owner, last_direction)
       values ($1, $2, $3, 'app_human', 'in') returning id`,
      [tenant, waId, at],
    )).rows[0]!.id;
    return { id, waId };
  };

  const etat = async (id: string) => (await pool.query<{ urgente_le: Date | null; urgente_par: string | null }>(
    'select urgente_le, urgente_par from conversations where id = $1', [id],
  )).rows[0]!;

  const journal = async (id: string): Promise<Ligne[]> => (await pool.query<Ligne>(
    'select type, acteur_id, cause from conversation_evenements where conversation_id = $1 order by at, id', [id],
  )).rows;
  const types = async (id: string): Promise<string[]> => (await journal(id)).map((l) => l.type);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-inbox-urgent') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-inbox-urgent-autre') returning id`)).rows[0]!.id;
    marie = await membre('marie@urgent.itest', 'Marie');
    jean = await membre('jean@urgent.itest', 'Jean');
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('delete from conversations where tenant_id = any($1::uuid[])', [[tenantId, autreTenantId]]);
  });

  describe('poser et retirer', () => {
    it('🔴 poser : l’horodatage, l’auteur, l’événement, et la ligne de la liste le dit', async () => {
      const c = await conversation('2026-10-06T10:00:00Z');
      expect(await store.marquerUrgente(tenantId, c.id, true, { collaborateur: marie })).toBe(true);
      const e = await etat(c.id);
      expect(e.urgente_le).not.toBeNull();
      expect(e.urgente_par).toBe(marie);
      expect(await journal(c.id)).toEqual([{ type: 'urgente', acteur_id: marie, cause: null }]);
      expect((await store.listConversations(tenantId))[0]!.urgente).toBe(true);
    });

    it('🔴 poser DEUX fois : un seul événement, et la première urgence (son heure, son auteur) est gardée', async () => {
      const c = await conversation('2026-10-06T10:00:00Z');
      await store.marquerUrgente(tenantId, c.id, true, { collaborateur: marie });
      const premiere = await etat(c.id);
      // Jean la marque à son tour : rien n'a changé, la frise n'en dit rien, et `urgente_par` ne doit donc pas le nommer.
      expect(await store.marquerUrgente(tenantId, c.id, true, { collaborateur: jean })).toBe(true);
      expect(await etat(c.id)).toEqual(premiere);
      expect(await types(c.id)).toEqual(['urgente']);
    });

    it('🔴 retirer efface l’heure ET l’auteur, et journalise ; retirer deux fois n’écrit rien de plus', async () => {
      const c = await conversation('2026-10-06T10:00:00Z');
      await store.marquerUrgente(tenantId, c.id, true, { collaborateur: marie });
      expect(await store.marquerUrgente(tenantId, c.id, false, { collaborateur: jean })).toBe(true);
      expect(await etat(c.id)).toEqual({ urgente_le: null, urgente_par: null });
      expect(await store.marquerUrgente(tenantId, c.id, false, { collaborateur: jean })).toBe(true);
      expect(await journal(c.id)).toEqual([
        { type: 'urgente', acteur_id: marie, cause: null },
        { type: 'urgence_levee', acteur_id: jean, cause: null },
      ]);
      expect((await store.listConversations(tenantId))[0]!.urgente).toBe(false);
    });

    it('🔴 l’agent IA (par le numéro) : `urgente_par` reste nul, la cause le nomme, et SEULE sa conversation est marquée', async () => {
      const a = await conversation('2026-10-06T10:00:00Z');
      const b = await conversation('2026-10-06T11:00:00Z');
      const cause = { cause: 'automatique : agent IA Sophie' };
      expect(await store.marquerUrgenteParWaId(tenantId, a.waId, cause)).toBe(true);
      expect((await etat(a.id)).urgente_le).not.toBeNull();
      expect((await etat(a.id)).urgente_par).toBeNull();
      expect(await journal(a.id)).toEqual([{ type: 'urgente', acteur_id: null, cause: 'automatique : agent IA Sophie' }]);
      // La conversation d'un autre contact n'est pas touchée.
      expect(await etat(b.id)).toEqual({ urgente_le: null, urgente_par: null });
      expect(await types(b.id)).toEqual([]);
      // Et la frise du panneau Détail la lit comme un geste automatique, pas comme un « ancien collaborateur ».
      const detail = await store.detailConversation(tenantId, a.id, { userId: null, role: 'admin' });
      expect(detail?.historique.map((h) => ({ type: h.type, acteur: h.acteur, cause: h.cause }))).toEqual([
        { type: 'urgente', acteur: null, cause: 'automatique : agent IA Sophie' },
      ]);
    });

    it('le départ du collaborateur qui l’a posée efface son nom, jamais l’urgence (on delete set null)', async () => {
      const c = await conversation('2026-10-06T10:00:00Z');
      const parti = await membre('parti@urgent.itest', 'Parti');
      await store.marquerUrgente(tenantId, c.id, true, { collaborateur: parti });
      await pool.query('delete from users where id = $1', [parti]);
      const e = await etat(c.id);
      expect(e.urgente_le).not.toBeNull();
      expect(e.urgente_par).toBeNull();
    });
  });

  describe('🔴 « Traité » et l’archivage lèvent l’urgence (décision de Julien du 2026-10-06)', () => {
    it('« Traité » : l’urgence tombe dans la même requête, et la frise dit les deux gestes, du même auteur', async () => {
      const c = await conversation('2026-10-06T10:00:00Z');
      await store.marquerUrgente(tenantId, c.id, true, { collaborateur: marie });
      expect(await store.marquerTraitee(tenantId, c.id, true, { collaborateur: jean })).toBe(true);
      expect(await etat(c.id)).toEqual({ urgente_le: null, urgente_par: null });
      // L'urgence levée d'abord, le geste ensuite : la frise, du plus récent au plus ancien, montre le geste au-dessus.
      expect(await journal(c.id)).toEqual([
        { type: 'urgente', acteur_id: marie, cause: null },
        { type: 'urgence_levee', acteur_id: jean, cause: null },
        { type: 'traitee', acteur_id: jean, cause: null },
      ]);
      expect((await store.compterConversations(tenantId)).urgentes).toBe(0);
    });

    it('l’archivage aussi', async () => {
      const c = await conversation('2026-10-06T10:00:00Z');
      await store.marquerUrgente(tenantId, c.id, true, { collaborateur: marie });
      await store.archiverConversation(tenantId, c.id, true, { cause: 'automatique : test' });
      expect(await etat(c.id)).toEqual({ urgente_le: null, urgente_par: null });
      expect(await types(c.id)).toEqual(['urgente', 'urgence_levee', 'archivee']);
    });

    it('🔴 PREUVE INVERSE : sur une conversation qui n’est pas urgente, « Traité » n’écrit AUCUN `urgence_levee`', async () => {
      const c = await conversation('2026-10-06T10:00:00Z');
      await store.marquerTraitee(tenantId, c.id, true, { collaborateur: jean });
      expect(await types(c.id)).toEqual(['traitee']);
    });

    it('retirer « Traité » ou désarchiver ne touche pas à l’urgence', async () => {
      const c = await conversation('2026-10-06T10:00:00Z');
      await store.marquerUrgente(tenantId, c.id, true, { collaborateur: marie });
      await store.marquerTraitee(tenantId, c.id, false, { collaborateur: jean });
      await store.archiverConversation(tenantId, c.id, false, { collaborateur: jean });
      expect((await etat(c.id)).urgente_par).toBe(marie);
      expect(await types(c.id)).toEqual(['urgente']);
    });
  });

  describe('le dossier « Urgent » et son compteur', () => {
    it('🔴 la liste et le compteur disent la même chose, hors archivées', async () => {
      const urgente = await conversation('2026-10-06T10:00:00Z');
      await conversation('2026-10-06T11:00:00Z');
      const rangee = await conversation('2026-10-06T12:00:00Z');
      await store.marquerUrgente(tenantId, urgente.id, true, { collaborateur: marie });
      // Une urgente archivée par un chemin qui ne la lève pas (écrite à la main) : le dossier l'exclut comme les autres.
      await pool.query('update conversations set urgente_le = now(), archived_at = now() where id = $1', [rangee.id]);
      expect((await store.listConversations(tenantId, { urgentes: true })).map((c) => c.id)).toEqual([urgente.id]);
      expect((await store.compterConversations(tenantId)).urgentes).toBe(1);
      // Pas exclusif : elle reste dans « Tout ».
      expect((await store.listConversations(tenantId)).some((c) => c.id === urgente.id)).toBe(true);
    });
  });

  describe('🔴 l’ordre de « À traiter », et sa pagination', () => {
    it('la première page met une urgente ANCIENNE avant une non urgente RÉCENTE', async () => {
      const recente = await conversation('2026-10-06T10:00:00Z');
      const ancienne = await conversation('2026-10-01T10:00:00Z');
      // Le témoin : sans urgence, la plus récente d'abord.
      expect((await store.listConversations(tenantId, { aTraiter: true })).map((c) => c.id)).toEqual([recente.id, ancienne.id]);
      await store.marquerUrgente(tenantId, ancienne.id, true, { collaborateur: marie });
      expect((await store.listConversations(tenantId, { aTraiter: true })).map((c) => c.id)).toEqual([ancienne.id, recente.id]);
      // Les autres dossiers gardent leur ordre : « Tout » reste du plus récent au plus ancien.
      expect((await store.listConversations(tenantId)).map((c) => c.id)).toEqual([recente.id, ancienne.id]);
    });

    /** Parcourt toutes les pages de « À traiter », le curseur repris TEL QUE le serveur le rend. */
    async function toutesLesPages(taille: number, sansRang = false): Promise<string[]> {
      const vus: string[] = [];
      let dernier: ConversationSummary | undefined;
      for (let tour = 0; tour < 50; tour += 1) {
        const page = await store.listConversations(tenantId, {
          aTraiter: true,
          limit: taille,
          ...(dernier ? { before: { at: dernier.curseur!, id: dernier.id, ...(sansRang ? {} : { urgente: dernier.urgente === true }) } } : {}),
        });
        vus.push(...page.map((c) => c.id));
        if (page.length < taille) break;
        dernier = page[page.length - 1];
      }
      return vus;
    }

    it('🔴 sans DOUBLON ni TROU, quel que soit le découpage, y compris à la frontière et sur des horodatages égaux', async () => {
      // Trois urgentes, dont deux au MÊME instant, et quatre non urgentes, dont une au même instant qu'une urgente :
      // la frontière tombe au milieu de chaque découpage essayé.
      const u1 = await conversation('2026-10-01T10:00:00Z');
      const u2 = await conversation('2026-10-01T10:00:00Z');
      const u3 = await conversation('2026-09-20T10:00:00Z');
      const n1 = await conversation('2026-10-06T10:00:00Z');
      const n2 = await conversation('2026-10-05T10:00:00Z');
      const n3 = await conversation('2026-10-01T10:00:00Z');
      const n4 = await conversation('2026-09-01T10:00:00Z');
      for (const u of [u1, u2, u3]) await store.marquerUrgente(tenantId, u.id, true, { collaborateur: marie });

      const attendu = (await store.listConversations(tenantId, { aTraiter: true, limit: 200 })).map((c) => c.id);
      // L'ordre de référence : les trois urgentes d'abord (les deux simultanées départagées par l'identifiant), puis
      // les autres du plus récent au plus ancien.
      expect(attendu.slice(0, 3).sort()).toEqual([u1.id, u2.id, u3.id].sort());
      expect(attendu[2]).toBe(u3.id);
      expect(attendu.slice(3)).toEqual([n1.id, n2.id, n3.id, n4.id]);

      for (const taille of [1, 2, 3, 4]) {
        const vus = await toutesLesPages(taille);
        expect(vus, `pages de ${taille}`).toEqual(attendu);
        expect(new Set(vus).size, `pages de ${taille}`).toBe(vus.length);
      }
    });

    it('⚠️ PREUVE INVERSE : un curseur SANS son rang reprend au mauvais endroit, d’où sa présence dans chaque ligne', async () => {
      // Une console d'avant 0216 n'envoie pas le rang : il vaut « non urgent ». Sur une page qui s'arrête chez les
      // urgentes, la suite saute les urgentes restantes. C'est ce que l'écran évite en renvoyant `urgente`.
      const u1 = await conversation('2026-10-02T10:00:00Z');
      const u2 = await conversation('2026-10-01T10:00:00Z');
      await conversation('2026-10-06T10:00:00Z');
      for (const u of [u1, u2]) await store.marquerUrgente(tenantId, u.id, true, { collaborateur: marie });
      const avecRang = await toutesLesPages(1);
      const sansRang = await toutesLesPages(1, true);
      expect(avecRang).toHaveLength(3);
      expect(sansRang).not.toContain(u2.id);
    });
  });

  describe('🔴 isolation entre espaces', () => {
    it('un autre espace ne marque rien, ne lève rien, et ne voit rien', async () => {
      const c = await conversation('2026-10-06T10:00:00Z');
      expect(await store.marquerUrgente(autreTenantId, c.id, true, { collaborateur: null })).toBe(false);
      expect(await store.marquerUrgenteParWaId(autreTenantId, c.waId, { cause: 'automatique : agent IA X' })).toBe(false);
      expect(await etat(c.id)).toEqual({ urgente_le: null, urgente_par: null });
      expect(await types(c.id)).toEqual([]);

      await store.marquerUrgente(tenantId, c.id, true, { collaborateur: marie });
      expect(await store.marquerUrgente(autreTenantId, c.id, false, { collaborateur: null })).toBe(false);
      expect((await etat(c.id)).urgente_par).toBe(marie);
      expect(await store.listConversations(autreTenantId, { urgentes: true })).toEqual([]);
      expect((await store.compterConversations(autreTenantId)).urgentes).toBe(0);
    });

    it('🔴 un collaborateur d’un AUTRE espace n’est jamais inscrit comme auteur', async () => {
      const etranger = (await pool.query<{ id: string }>(
        `insert into users (tenant_id, email, name, password_hash, role) values ($1, 'etranger@urgent.itest', 'Etranger', 'x', 'admin') returning id`,
        [autreTenantId],
      )).rows[0]!.id;
      const c = await conversation('2026-10-06T10:00:00Z');
      expect(await store.marquerUrgente(tenantId, c.id, true, { collaborateur: etranger })).toBe(true);
      expect((await etat(c.id)).urgente_par).toBeNull();
      expect((await journal(c.id))[0]!.acteur_id).toBeNull();
    });
  });
});
