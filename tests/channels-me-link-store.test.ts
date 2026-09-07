import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgChannelsMeLinkStore } from '../src/channels-me/link-store.pg';

/**
 * Les liens de chaine, avec un FAUX pool (aucune base reelle).
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. 🔴 Le lien n a PAS d etat allume ou eteint a lui. Son etat EST le `enabled` de son automation
 *     compagnon, et c est la seule source de verite. Aucune requete de ce store ne doit donc parler de
 *     `enabled` dans SES REQUETES DE LECTURE/CREATION : un second drapeau divergerait au premier chemin qui
 *     n ecrirait qu une des deux copies. `allumerAutomation`/`eteindreAutomation` sont l EXCEPTION assumee :
 *     elles ecrivent `enabled`, mais sur `automations`, jamais sur `channelsme_links`.
 *  2. list() trie par created_at desc, ordre exact de l index channelsme_links_tenant_idx
 *     (tenant_id, created_at desc) pose par la migration 0114. En sortir ne casse rien de visible, ca ne
 *     produit qu un plan d execution different, donc rien ne le signalerait.
 *  3. Chaque requete porte tenant_id, y compris byId() ou l id primaire suffirait techniquement : c est le
 *     seul controle d isolation, le pooler etant superuser.
 *  4. Le mapping rend des dates en ISO, jamais un objet Date brut (le contrat expose createdAt: string).
 *  5. allumerAutomation()/eteindreAutomation() portent une GARDE MIROIR (`possede_par = 'channelsme_link'`)
 *     sur la table `automations` : ce store ne doit jamais pouvoir toucher une automation qui ne lui
 *     appartient pas, symetrique du predicat qui exclut ces lignes de `PgAutomationStore`.
 */

const TENANT = 't1';

interface Reponse { rows: Array<Record<string, unknown>>; rowCount?: number }

/** Faux pool : enregistre SQL et params, repond selon l ordre des appels. Aucune base, aucun reseau. */
function fauxPool(reponses: Reponse[] = []) {
  const requetes: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      requetes.push({ sql, params });
      const r = reponses[Math.min(i, reponses.length - 1)] ?? { rows: [] };
      i += 1;
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    },
  } as unknown as Pool;
  return { pool, requetes };
}

/** Ligne `channelsme_links` telle que Postgres la rend (created_at en Date, comme le driver pg). */
function ligneLien(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'lnk-1', tenant_id: TENANT, workflow_id: 'wf-1', start_node_id: null,
    // Jeton FICTIF (aucun secret) : valeur figee pour rendre les assertions lisibles.
    token: 'cm-a7k2m9p3', phrase: 'Je veux recevoir la newsletter', automation_id: 'auto-1',
    max_par_heure: 5000, created_at: new Date('2026-09-04T10:00:00.000Z'),
    ...over,
  };
}

describe('PgChannelsMeLinkStore (faux pool, sans base reelle)', () => {
  it('create() : insert scope tenant, params dans le bon ordre, ligne rendue mappee en camelCase', async () => {
    const { pool, requetes } = fauxPool([{ rows: [ligneLien()] }]);
    const lien = await new PgChannelsMeLinkStore(pool).create(TENANT, {
      workflowId: 'wf-1', startNodeId: null, token: 'cm-a7k2m9p3',
      phrase: 'Je veux recevoir la newsletter', automationId: 'auto-1', maxParHeure: 5000,
    });

    const q = requetes[0]!;
    expect(q.sql).toMatch(/^insert into channelsme_links/i);
    expect(q.sql).toMatch(/returning/i); // le store ne relit jamais en 2e requete ce que l INSERT peut rendre
    expect(q.params).toEqual([TENANT, 'wf-1', null, 'cm-a7k2m9p3', 'Je veux recevoir la newsletter', 'auto-1', 5000]);
    expect(lien).toEqual({
      id: 'lnk-1', tenantId: TENANT, workflowId: 'wf-1', startNodeId: null,
      token: 'cm-a7k2m9p3', phrase: 'Je veux recevoir la newsletter', automationId: 'auto-1',
      maxParHeure: 5000, createdAt: '2026-09-04T10:00:00.000Z',
      // null et pas false : a l insertion la colonne n est pas jointe. Rendre `false` ferait passer
      // l automation pour « eteinte alors qu elle existe », ce qui est une autre affirmation.
      enabled: null,
    });
  });

  it('create() : les champs facultatifs a null traversent tels quels (aucun plafond, aucun bloc de depart)', async () => {
    const { pool, requetes } = fauxPool([
      { rows: [ligneLien({ start_node_id: null, automation_id: null, max_par_heure: null })] },
    ]);
    const lien = await new PgChannelsMeLinkStore(pool).create(TENANT, {
      workflowId: 'wf-1', startNodeId: null, token: 'cm-a7k2m9p3', phrase: 'Bonjour',
      automationId: null, maxParHeure: null,
    });

    expect(requetes[0]!.params).toEqual([TENANT, 'wf-1', null, 'cm-a7k2m9p3', 'Bonjour', null, null]);
    // null et pas undefined : `max_par_heure` null veut dire « plafond global de l instance », pas « zero ».
    expect(lien.maxParHeure).toBeNull();
    expect(lien.automationId).toBeNull();
    expect(lien.startNodeId).toBeNull();
  });

  it('list() : trie par created_at desc, ordre exact de l index channelsme_links_tenant_idx', async () => {
    const { pool, requetes } = fauxPool([
      { rows: [ligneLien(), ligneLien({ id: 'lnk-2', token: 'cm-b8n3q4r5' })] },
    ]);
    const liens = await new PgChannelsMeLinkStore(pool).list(TENANT);

    expect(requetes[0]!.sql).toMatch(/where l\.tenant_id=\$1 order by l\.created_at desc/i);
    expect(requetes[0]!.params).toEqual([TENANT]);
    expect(liens.map((l) => l.id)).toEqual(['lnk-1', 'lnk-2']);
    expect(liens[0]!.createdAt).toBe('2026-09-04T10:00:00.000Z');
  });

  it('byId() : scope tenant ET id ; aucune ligne rend null', async () => {
    const trouve = fauxPool([{ rows: [ligneLien()] }]);
    const lien = await new PgChannelsMeLinkStore(trouve.pool).byId(TENANT, 'lnk-1');
    expect(lien?.id).toBe('lnk-1');
    expect(trouve.requetes[0]!.sql).toMatch(/where l\.tenant_id=\$1 and l\.id=\$2/i);
    expect(trouve.requetes[0]!.params).toEqual([TENANT, 'lnk-1']);

    const absent = fauxPool([{ rows: [] }]);
    expect(await new PgChannelsMeLinkStore(absent.pool).byId(TENANT, 'lnk-inconnu')).toBeNull();
  });

  it('🔴 channelsme_links ne porte JAMAIS de enabled : l etat du lien EST celui de son automation', async () => {
    // ⚠️ CE TEST A ETE PRECISE, PAS AFFAIBLI. Il interdisait le MOT « enabled » dans tout le SQL du store,
    // ce qui etait un raccourci pour l invariant reel : pas de SECOND drapeau sur `channelsme_links`. Le
    // raccourci refusait aussi de LIRE l etat a sa source, or sans cette lecture l etat n est visible nulle
    // part (l automation compagnon est possedee, donc absente de `GET /automations`), et la console
    // affichait deux boutons sans savoir lequel avait un sens. La regle interdit de COPIER l etat, pas de
    // le LIRE. On verifie donc les deux moities separement, ce qui est plus strict que l ancienne forme.
    const { pool, requetes } = fauxPool([{ rows: [ligneLien()] }]);
    const store = new PgChannelsMeLinkStore(pool);
    await store.create(TENANT, {
      workflowId: 'wf-1', startNodeId: null, token: 'cm-a7k2m9p3', phrase: 'Bonjour',
      automationId: 'auto-1', maxParHeure: null,
    });
    await store.list(TENANT);
    await store.byId(TENANT, 'lnk-1');

    expect(requetes).toHaveLength(3);

    // (a) L INSERT ne connait pas enabled du tout : la colonne n existe pas sur channelsme_links.
    expect(requetes[0]!.sql).toMatch(/^insert into channelsme_links/i);
    expect(requetes[0]!.sql).not.toMatch(/enabled/i);

    // (b) Les deux LECTURES lisent enabled sur `a` (automations), jamais sur `l` (channelsme_links), et
    //     jamais en ecriture.
    for (const q of [requetes[1]!, requetes[2]!]) {
      expect(q.sql).toMatch(/a\.enabled/i);
      expect(q.sql).not.toMatch(/l\.enabled/i);
      expect(q.sql).not.toMatch(/(update|insert|set)/i);
    }

    // (c) 🔴 La jointure porte la MEME garde miroir que l ecriture : tenant_id ET possede_par. Sans elle, on
    //     lirait l etat d une automation d un autre proprietaire, c est-a-dire plus largement qu on n ecrit.
    for (const q of [requetes[1]!, requetes[2]!]) {
      expect(q.sql).toMatch(/left join automations a on a\.id = l\.automation_id/i);
      expect(q.sql).toMatch(/a\.tenant_id = l\.tenant_id/i);
      expect(q.sql).toMatch(/a\.possede_par = 'channelsme_link'/i);
    }

    // Et toutes portent tenant_id, y compris byId() ou l id primaire suffirait techniquement.
    for (const q of requetes) expect(q.sql).toMatch(/tenant_id/i);
  });

  describe('allumerAutomation() / eteindreAutomation() : la garde miroir possede_par', () => {
    it('allumerAutomation() : met a jour automations, jamais channelsme_links, avec la garde possede_par', async () => {
      const { pool, requetes } = fauxPool();
      await new PgChannelsMeLinkStore(pool).allumerAutomation(TENANT, 'lnk-1');

      expect(requetes).toHaveLength(1);
      const q = requetes[0]!;
      expect(q.sql).toMatch(/^update automations/i);
      expect(q.sql).not.toMatch(/update channelsme_links/i);
      expect(q.sql).toMatch(/set\s+enabled\s*=\s*\$3/i);
      expect(q.sql).toMatch(/possede_par\s*=\s*'channelsme_link'/i);
      // La sous-requete qui resout l automation compagnon est elle aussi scopee tenant_id.
      expect(q.sql).toMatch(/select automation_id from channelsme_links where tenant_id\s*=\s*\$1 and id\s*=\s*\$2/i);
      expect(q.params).toEqual([TENANT, 'lnk-1', true]);
    });

    it('eteindreAutomation() : meme requete, enabled a false', async () => {
      const { pool, requetes } = fauxPool();
      await new PgChannelsMeLinkStore(pool).eteindreAutomation(TENANT, 'lnk-1');

      expect(requetes).toHaveLength(1);
      const q = requetes[0]!;
      expect(q.sql).toMatch(/^update automations/i);
      expect(q.sql).toMatch(/possede_par\s*=\s*'channelsme_link'/i);
      expect(q.params).toEqual([TENANT, 'lnk-1', false]);
    });

    it('les deux methodes portent tenant_id ET possede_par, jamais l un sans l autre', async () => {
      const allumer = fauxPool();
      await new PgChannelsMeLinkStore(allumer.pool).allumerAutomation(TENANT, 'lnk-9');
      const eteindre = fauxPool();
      await new PgChannelsMeLinkStore(eteindre.pool).eteindreAutomation(TENANT, 'lnk-9');

      for (const { requetes } of [allumer, eteindre]) {
        expect(requetes[0]!.sql).toMatch(/tenant_id/i);
        expect(requetes[0]!.sql).toMatch(/possede_par/i);
      }
    });
  });
});
