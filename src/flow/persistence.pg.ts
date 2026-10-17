import type { Pool } from 'pg';
import { PgUserFieldStore } from '../crm/field-store.pg';
import { PgFlowStore } from './store.pg';
import type { FormulaireLocal, PersistanceFormulaire } from './lifecycle';

/**
 * Écrit la définition locale du formulaire et les champs CRM qu'elle requiert dans une même transaction. Une panne
 * ne peut donc laisser ni champs orphelins, ni formulaire dont une cible manquerait.
 */
export class PgPersistanceFormulaire implements PersistanceFormulaire {
  constructor(private readonly pool: Pool) {}

  async create(input: FormulaireLocal): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const champs = new PgUserFieldStore(client);
      for (const def of input.champsAAssurer) await champs.upsert(input.tenantId, def);
      await new PgFlowStore(client).insert(input);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async update(input: FormulaireLocal): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const champs = new PgUserFieldStore(client);
      for (const def of input.champsAAssurer) await champs.upsert(input.tenantId, def);
      const updated = await new PgFlowStore(client).update(input.id, input.tenantId, input);
      if (!updated) {
        await client.query('rollback');
        return false;
      }
      await client.query('commit');
      return true;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
