import type { Pool } from 'pg';
import { lireEtat, type EntretienComplet, type EntretienStore } from './entretien-store';

/**
 * L'entretien de construction en base (table `agent_setup_conversations`).
 *
 * 🔴 `tenant_id = $1` sur chaque requête, même là où `agent_id` est clé primaire : la RLS est contournée par
 * le pooler, ce filtrage est le contrôle d'accès. Un agent d'un autre espace rend `null`.
 */
export class PgEntretienStore implements EntretienStore {
  constructor(private readonly pool: Pool) {}

  async lire(tenantId: string, agentId: string): Promise<EntretienComplet | null> {
    const res = await this.pool.query<{ messages: unknown; reponses: unknown; poses: unknown; bascules: unknown; auteurs: unknown }>(
      `select messages, reponses, poses, bascules, auteurs from agent_setup_conversations where agent_id = $2 and tenant_id = $1`,
      [tenantId, agentId],
    );
    const r = res.rows[0];
    return r ? lireEtat(r) : null;
  }

  async ecrire(tenantId: string, agentId: string, etat: EntretienComplet): Promise<void> {
    // Une seule ligne par agent : l'upsert réécrit la même, et son tableau `messages` porte tout le fil.
    await this.pool.query(
      `insert into agent_setup_conversations (agent_id, tenant_id, messages, reponses, poses, bascules, auteurs, updated_at)
       values ($2, $1, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, now())
       on conflict (agent_id) do update
         set messages = excluded.messages, reponses = excluded.reponses,
             poses = excluded.poses, bascules = excluded.bascules,
             auteurs = excluded.auteurs, updated_at = now()
       where agent_setup_conversations.tenant_id = $1`,
      [
        tenantId,
        agentId,
        // Pas de troncature ici : la borne s'applique à la lecture du prompt (`bornerPourModele`), sinon la
        // sauvegarde détruirait les tours anciens d'un fil qui doit perdurer.
        JSON.stringify(etat.messages),
        JSON.stringify(etat.reponses),
        JSON.stringify(etat.poses),
        JSON.stringify(etat.bascules ?? []),
        JSON.stringify(etat.auteurs ?? []),
      ],
    );
  }

  async effacer(tenantId: string, agentId: string): Promise<void> {
    await this.pool.query(
      `delete from agent_setup_conversations where agent_id = $2 and tenant_id = $1`,
      [tenantId, agentId],
    );
  }
}
