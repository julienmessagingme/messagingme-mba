import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgWorkflowStore, NOM_SCENARIO_SYSTEME, designationDuScenario } from '../src/workflow/store.pg';

/**
 * 🔴 LE SCÉNARIO SYSTÈME DU RÉPONDEUR EST INVISIBLE, PAR LE MAGASIN ET NON PAR LES APPELANTS (lot 5, migration 0209).
 *
 * Une ligne par espace (`workflows.systeme = 'repondeur'`), l'ancre des parcours de l'agent répondeur. Elle ne doit
 * sortir par AUCUNE porte : `GET /workflows`, `/nodes`, la détection de doublon de nom, la résolution `/v1` par nom
 * ou par code, le catalogue `/v1`, l'outil MCP `list_scenarios`, les outils de l'agent de Meta, le lien de test, ni se
 * laisser modifier, publier ou supprimer par son identifiant. Toutes passent par CES méthodes : le filtre est posé
 * une fois, ici, et ce fichier vérifie qu'il est dans chacune.
 *
 * ⚠️ L'INVENTAIRE SUIT LA CLASSE : une méthode publique ajoutée demain doit être rangée ici, filtrée ou délibérément
 * pas, sinon le premier cas échoue. Ce que la base en fait vraiment : `tests/integration/repondeur.integration.test.ts`.
 */

/** Un faux pool qui note chaque requête et rend une ligne plausible : seule la requête nous intéresse. */
function banc() {
  const requetes: string[] = [];
  const ligne = {
    id: 'w1', tenant_id: 't1', name: 'n', code: null, graph: { nodes: [], edges: [] }, draft_graph: null,
    published_at: null, created_at: new Date(), updated_at: new Date(), node_count: 0, has_draft: false,
    brouillon: false, test_token: 'jeton', systeme: null,
  };
  const pool = {
    query: async (sql: string) => { requetes.push(sql.replace(/\s+/g, ' ')); return { rows: [ligne], rowCount: 1 }; },
  } as unknown as Pool;
  return { requetes, store: new PgWorkflowStore(pool) };
}

/** Les méthodes publiques qui doivent ignorer la ligne système, et comment chacune s'appelle. */
const FILTREES: Record<string, (s: PgWorkflowStore) => Promise<unknown>> = {
  listResume: (s) => s.listResume('t1'),
  listPublies: (s) => s.listPublies('t1'),
  list: (s) => s.list('t1'),
  getById: (s) => s.getById('w1', 't1'),
  update: (s) => s.update('w1', 't1', { name: 'x' }),
  publish: (s) => s.publish('w1', 't1'),
  remove: (s) => s.remove('w1', 't1'),
  ensureTestToken: (s) => s.ensureTestToken('w1', 't1', 'jeton'),
  findByTestToken: (s) => s.findByTestToken('jeton'),
};

/**
 * Les seules qui voient la ligne, et pourquoi : `insert` crée un scénario du client (jamais système) ;
 * `assurerScenarioSysteme` la crée ou la rend ; `designation` la nomme dans la frise (« Répondeur automatique »).
 */
const DELIBEREMENT_NON_FILTREES = ['insert', 'assurerScenarioSysteme', 'designation'];

describe('🔴 le scénario système n’existe pour aucune lecture publique du magasin', () => {
  it('l’inventaire est complet : chaque méthode publique est rangée, filtrée ou délibérément pas', () => {
    const methodes = Object.getOwnPropertyNames(PgWorkflowStore.prototype).filter((m) => m !== 'constructor').sort();
    expect(methodes).toEqual([...Object.keys(FILTREES), ...DELIBEREMENT_NON_FILTREES].sort());
  });

  for (const [nom, appeler] of Object.entries(FILTREES)) {
    it(`${nom} : chaque requête porte \`systeme is null\``, async () => {
      const { requetes, store } = banc();
      await appeler(store);
      expect(requetes.length, nom).toBeGreaterThan(0);
      for (const r of requetes) expect(r, nom).toMatch(/\bsysteme is null\b/);
    });
  }
});

describe('la ligne système se crée sans course, et se nomme', () => {
  it('🔴 la lecture d’abord ; l’insertion seulement si elle manque, arbitrée par l’index unique partiel', async () => {
    const requetes: string[] = [];
    let lectures = 0;
    const pool = {
      query: async (sql: string) => {
        requetes.push(sql.replace(/\s+/g, ' '));
        if (/^select id from workflows where tenant_id = \$1 and systeme = \$2/.test(sql)) {
          lectures += 1;
          // Absente à la première lecture ; la seconde voit celle d'un démarrage concurrent.
          return { rows: lectures === 1 ? [] : [{ id: 'w-autre' }] };
        }
        if (/from tenants/.test(sql)) return { rows: [{ code: 'abc' }] };
        // L'insertion a perdu la course : `do nothing`, aucune ligne rendue.
        return { rows: [] };
      },
    } as unknown as Pool;
    expect(await new PgWorkflowStore(pool).assurerScenarioSysteme('t1', 'repondeur')).toBe('w-autre');
    const insertion = requetes.find((r) => r.startsWith('insert into workflows'));
    expect(insertion).toContain("on conflict (tenant_id) where systeme = 'repondeur' do nothing");
  });

  it('existante : une seule lecture, aucune écriture', async () => {
    const requetes: string[] = [];
    const pool = { query: async (sql: string) => { requetes.push(sql); return { rows: [{ id: 'w-sys' }] }; } } as unknown as Pool;
    expect(await new PgWorkflowStore(pool).assurerScenarioSysteme('t1', 'repondeur')).toBe('w-sys');
    expect(requetes).toHaveLength(1);
  });

  it('la frise dit « Répondeur automatique » pour la ligne système, « scénario <nom> » sinon, l’identifiant faute de mieux', () => {
    expect(NOM_SCENARIO_SYSTEME.repondeur).toBe('Répondeur automatique');
    expect(designationDuScenario({ nom: 'peu importe', systeme: 'repondeur' }, 'w1')).toBe('Répondeur automatique');
    expect(designationDuScenario({ nom: 'Bienvenue', systeme: null }, 'w1')).toBe('scénario Bienvenue');
    expect(designationDuScenario(null, 'w1')).toBe('scénario w1');
  });
});
