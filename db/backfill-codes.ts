/**
 * Backfill des codes publics « schéma A » (Lot 4a) pour les lignes créées AVANT le déploiement.
 * Idempotent : ne remplit que les codes NULL. À lancer UNE fois après la migration 0031, sur le VPS :
 *   sudo docker compose run --rm --no-deps mba-api npx tsx db/backfill-codes.ts
 * (les NOUVELLES lignes reçoivent déjà leur code à l'INSERT via les stores).
 */
import 'dotenv/config';
import { Client } from 'pg';
import { pgSsl } from '../src/db/ssl';
import { deriveTenantCode, makeCode } from '../src/ids/code';
import { mintNodeCodes } from '../src/workflow/node-codes';
import type { WorkflowGraph } from '../src/workflow/graph';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant (.env)');
  const c = new Client({ connectionString: url, ssl: pgSsl() });
  await c.connect();

  // 1) Racine « code client » des tenants qui n'en ont pas (déterministe depuis l'uuid).
  const tenants = await c.query<{ id: string }>('select id from tenants where public_code is null');
  for (const t of tenants.rows) {
    await c.query('update tenants set public_code = $2 where id = $1 and public_code is null', [t.id, deriveTenantCode(t.id)]);
  }
  console.log(`tenants backfillés: ${tenants.rowCount}`);

  // Map tenant -> code client (tous en ont un désormais).
  const codes = new Map<string, string>();
  const allT = await c.query<{ id: string; public_code: string }>('select id, public_code from tenants where public_code is not null');
  for (const r of allT.rows) codes.set(r.id, r.public_code);

  // 2) Entités à ligne DB : un code par ligne (ULID unique), UPDATE ciblé, seulement si code null.
  const byId = [
    { table: 'workflows', type: 'scn' as const },
    { table: 'users', type: 'usr' as const },
  ];
  for (const { table, type } of byId) {
    const rows = await c.query<{ id: string; tenant_id: string }>(`select id, tenant_id from ${table} where code is null`);
    let n = 0;
    for (const r of rows.rows) {
      const tc = codes.get(r.tenant_id);
      if (!tc) continue;
      await c.query(`update ${table} set code = $2 where id = $1 and code is null`, [r.id, makeCode(type, tc)]);
      n += 1;
    }
    console.log(`${table} backfillés: ${n}`);
  }

  // user_fields : identifié par (tenant_id, key).
  {
    const rows = await c.query<{ tenant_id: string; key: string }>('select tenant_id, key from user_fields where code is null');
    let n = 0;
    for (const r of rows.rows) {
      const tc = codes.get(r.tenant_id);
      if (!tc) continue;
      await c.query('update user_fields set code = $3 where tenant_id = $1 and key = $2 and code is null', [r.tenant_id, r.key, makeCode('fld', tc)]);
      n += 1;
    }
    console.log(`user_fields backfillés: ${n}`);
  }

  // tags : identifié par (tenant_id, name).
  {
    const rows = await c.query<{ tenant_id: string; name: string }>('select tenant_id, name from tags where code is null');
    let n = 0;
    for (const r of rows.rows) {
      const tc = codes.get(r.tenant_id);
      if (!tc) continue;
      await c.query('update tags set code = $3 where tenant_id = $1 and name = $2 and code is null', [r.tenant_id, r.name, makeCode('tag', tc)]);
      n += 1;
    }
    console.log(`tags backfillés: ${n}`);
  }

  // 3) Nodes des graphes existants (Lot 4b) : mint des codes manquants (réutilise mintNodeCodes). Idempotent :
  //    un node déjà codé (même tenant) est retourné par RÉFÉRENCE -> « rien n'a changé » détectable, pas d'update.
  {
    const rows = await c.query<{ id: string; tenant_id: string; graph: WorkflowGraph | null }>('select id, tenant_id, graph from workflows');
    let n = 0;
    for (const r of rows.rows) {
      const tc = codes.get(r.tenant_id);
      const graph = r.graph;
      if (!tc || !graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) continue;
      const minted = mintNodeCodes(graph, tc);
      if (minted.nodes.every((node, i) => node === graph.nodes[i])) continue; // déjà tous codés
      await c.query('update workflows set graph = $2::jsonb, updated_at = now() where id = $1', [r.id, JSON.stringify(minted)]);
      n += 1;
    }
    console.log(`workflows (nodes) backfillés: ${n}`);
  }

  await c.end();
  console.log('backfill terminé');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
