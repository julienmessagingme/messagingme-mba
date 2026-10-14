import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgRequeteStore } from '../src/agent/requetes.pg';
import type { MethodeConnecteur } from '../src/agent/http-cible';

/**
 * L'AUTONOMIE TOMBE QUAND UNE REQUÊTE REND SES OUTILS IRRÉVERSIBLES (relecture de 099fd6c1, todo du 2026-10-05).
 *
 * Le test lit ce qui PART vers la base, dans la transaction de `PgRequeteStore.patch` : l'écriture réelle est
 * éprouvée en intégration (`tests/integration/requete-methode-risque.integration.test.ts`, en CI seulement), ce
 * test-ci se mute en local. Le faux rend les outils « à monter » qu'on lui donne.
 */
function faux(methodeCourante: MethodeConnecteur, aMonter: string[]) {
  const envoyees: { sql: string; params: unknown[] }[] = [];
  const ligne = {
    id: 'r1', tenant_id: 't1', source_id: 's1', label: 'req', method: methodeCourante, path: '/x',
    query: [], headers: [], body_mode: 'aucun', body_json: null, body_champs: [], variables: [],
    output_paths: [], valeurs_test: {}, updated_at: new Date(0), outils: aMonter.length,
  };
  const client = {
    async query(sql: string, params: unknown[] = []) {
      envoyees.push({ sql, params });
      if (sql.includes('update connector_requests')) return { rows: [], rowCount: 1 };
      if (sql.includes('select id from agent_tools')) return { rows: aMonter.map((id) => ({ id })), rowCount: aMonter.length };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = {
    async query() { return { rows: [ligne], rowCount: 1 }; },
    async connect() { return client; },
  } as unknown as Pool;
  const autonomies = () => envoyees.filter((q) => /update agent_tool_consommateurs\s+set autonome = false/.test(q.sql));
  return { store: new PgRequeteStore(pool), envoyees, autonomies };
}

describe('changer la méthode d’une requête : l’autonomie de ses outils', () => {
  it('🔴 passée en DELETE, l’autonomie des outils montés tombe, DANS la transaction', async () => {
    const { store, envoyees, autonomies } = faux('POST', ['o1', 'o2']);
    await store.patch('t1', 'r1', { methode: 'DELETE' });
    expect(autonomies()).toHaveLength(1);
    expect(autonomies()[0]!.params).toEqual(['t1', ['o1', 'o2']]);
    expect(autonomies()[0]!.sql).toMatch(/tenant_id = \$1/);
    const i = envoyees.indexOf(autonomies()[0]!);
    expect(envoyees.findIndex((q) => q.sql === 'begin')).toBeLessThan(i);
    expect(envoyees.findIndex((q) => q.sql === 'commit')).toBeGreaterThan(i);
    // L'ordre des verrous du dépôt : la définition (`for update`), puis ses liaisons.
    expect(envoyees.findIndex((q) => q.sql.includes('for update'))).toBeLessThan(i);
  });

  it('passée en POST (écriture), l’autonomie ne bouge pas : l’exécuteur ne la lit que sur un outil irréversible', async () => {
    const { store, autonomies } = faux('GET', ['o1']);
    await store.patch('t1', 'r1', { methode: 'POST' });
    expect(autonomies()).toEqual([]);
  });

  it('passée en DELETE sans outil à monter (déjà irréversibles), rien n’est retiré', async () => {
    const { store, autonomies } = faux('DELETE', []);
    await store.patch('t1', 'r1', { methode: 'DELETE' });
    expect(autonomies()).toEqual([]);
  });
});
