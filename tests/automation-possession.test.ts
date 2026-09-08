import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgAutomationStore } from '../src/automation/store.pg';

/**
 * Possession d'une automation par autre chose que l'ecran Automation (colonne `possede_par`, migration 0114).
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. Les QUATRE requetes de pilotage (`list`, `getById`, `update`, `remove`) excluent une automation
 *     possedee. Sans ce predicat, l'ecran Automation propose de modifier ou de supprimer le compagnon d'un
 *     lien de chaine, et le bouton d'un post DEJA PUBLIE cesse de declencher, sans trace et sans recours :
 *     un post publie circule pour toujours.
 *  2. Le chemin CHAUD (`listEnabled`) ne porte PAS ce predicat et ne doit jamais le porter : l'y ajouter
 *     rendrait muets le webhook ET le lien de chaine, c'est-a-dire l'inverse du but.
 *  3. `create` sait POSER un proprietaire et un plafond : c'est par la qu'un lien de chaine fabrique son
 *     automation compagnon, `create` etant la seule methode du store sans predicat de possession.
 *
 * Fake pool (aucune base reelle), patron `tests/email-account-store.test.ts` : on capture le SQL et les
 * params. Le comportement REEL du predicat se prouve contre un vrai Postgres, en CI, dans
 * `tests/integration/automation-possession.integration.test.ts`.
 */
function fakePool() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (/^insert into automations/i.test(sql)) return { rows: [{ id: 'a-neuve' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const TENANT = 't1';

describe('PgAutomationStore : une automation POSSEDEE est hors de portee de l ecran', () => {
  it('🔴 les quatre requetes de pilotage excluent une automation possedee', async () => {
    const { pool, queries } = fakePool();
    const store = new PgAutomationStore(pool);
    await store.list(TENANT);
    await store.getById('a1', TENANT);
    await store.update('a1', TENANT, { name: 'x' });
    await store.remove('a1', TENANT);

    expect(queries).toHaveLength(4);
    for (const q of queries) {
      expect(q.sql, `cette requete laisse une automation possedee a portee de l ecran : ${q.sql}`)
        .toContain('possede_par is null');
      // Le premier terme n'a pas ete perdu au passage : les webhooks restent exclus comme avant.
      expect(q.sql).toContain("trigger_kind <> 'webhook'");
    }
  });

  it('le chemin CHAUD voit tout : `listEnabled` ne FILTRE pas sur le proprietaire, mais il le LIT', async () => {
    // ⚠️ CE TEST DISAIT « ne contient pas `possede_par` », et c'etait trop large. Le 2026-09-08 la colonne est
    // entree dans la liste des champs SELECTIONNES (sa VALEUR decide si un bouton de chaine reprend la main
    // sur le fil), et le test a casse alors que rien n'etait casse. Ce qu'il protege vraiment, et qui n'a pas
    // bouge, c'est l'absence du PREDICAT : `possede_par is null` dans le WHERE rendrait muets le webhook ET
    // le lien de chaine, c'est-a-dire l'inverse du but.
    const { pool, queries } = fakePool();
    await new PgAutomationStore(pool).listEnabled(TENANT, ['keyword']);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql, 'le chemin chaud filtre sur le proprietaire : le webhook et le lien de chaine deviennent muets')
      .not.toContain('possede_par is null');
    // Et l'autre moitie, nee le 2026-09-08 : la retirer de la SELECTION ne casserait aucun type, elle rendrait
    // seulement `possedePar` nul partout, et les boutons de chaine cesseraient de demarrer sur un fil tenu.
    expect(queries[0]!.sql, 'le chemin chaud ne lit plus le proprietaire : un bouton de chaine ne reprendra plus la main')
      .toContain('possede_par');
  });

  it('`create` pose le proprietaire et le plafond, et met null quand ils sont absents', async () => {
    const possedee = fakePool();
    await new PgAutomationStore(possedee.pool).create(TENANT, {
      name: 'Chaine : newsletter',
      triggerKind: 'keyword',
      // Jeton FICTIF (aucun secret) : valeur figee pour rendre les assertions lisibles.
      triggerConfig: { keywords: ['cm-a7k2m9p3'], mode: 'contains' },
      conditionGroup: null,
      workflowId: 'wf1',
      startNodeId: null,
      cooldownSeconds: 300,
      enabled: false,
      possedePar: 'channelsme_link',
      maxFiresPerHour: 2000,
    });
    const ins = possedee.queries[0]!;
    expect(ins.sql).toContain('possede_par');
    expect(ins.sql).toContain('max_fires_per_hour');
    // Ordre des params de l'INSERT :
    // (tenant, name, enabled, kind, cfg, group, workflow, node, cooldown, possede_par, max_fires_per_hour)
    expect(ins.params[9]).toBe('channelsme_link');
    expect(ins.params[10]).toBe(2000);

    const ordinaire = fakePool();
    await new PgAutomationStore(ordinaire.pool).create(TENANT, {
      name: 'Mot-cle rdv', triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] },
      conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, enabled: false,
    });
    // Une automation ordinaire n'a ni proprietaire ni plafond propre : les deux colonnes partent a null,
    // et c'est ce qui rend le changement ADDITIF pour les 200 automations deja en base.
    expect(ordinaire.queries[0]!.params[9]).toBeNull();
    expect(ordinaire.queries[0]!.params[10]).toBeNull();
  });
});
