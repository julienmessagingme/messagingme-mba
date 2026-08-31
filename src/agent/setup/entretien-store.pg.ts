import type { Pool } from 'pg';
import { lireEtat, bornerMessages, type EntretienComplet, type EntretienStore } from './entretien-store';

/**
 * L'entretien de construction en base (table `agent_setup_conversations`, migration 0090).
 *
 * ⚠️ `tenant_id = $1` sur CHAQUE requête, y compris là où `agent_id` est déjà une clé primaire : la connexion
 * passe par le pooler en rôle superuser, donc la RLS est contournée et ce filtrage EST le contrôle d'accès.
 * Un agent d'un autre espace rend `null`, comme s'il n'existait pas.
 */
export class PgEntretienStore implements EntretienStore {
  constructor(private readonly pool: Pool) {}

  async lire(tenantId: string, agentId: string): Promise<EntretienComplet | null> {
    const res = await this.pool.query<{ messages: unknown; reponses: unknown; poses: unknown; bascules: unknown }>(
      `select messages, reponses, poses, bascules from agent_setup_conversations where agent_id = $2 and tenant_id = $1`,
      [tenantId, agentId],
    );
    const r = res.rows[0];
    return r ? lireEtat(r) : null;
  }

  async ecrire(tenantId: string, agentId: string, etat: EntretienComplet): Promise<void> {
    // Un seul état courant par agent : l'upsert écrase, il n'empile pas. L'historique d'un entretien
    // n'intéresse personne, et le garder ferait grossir une table pour rien.
    await this.pool.query(
      `insert into agent_setup_conversations (agent_id, tenant_id, messages, reponses, poses, bascules, updated_at)
       values ($2, $1, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, now())
       on conflict (agent_id) do update
         set messages = excluded.messages, reponses = excluded.reponses,
             poses = excluded.poses, bascules = excluded.bascules, updated_at = now()
       where agent_setup_conversations.tenant_id = $1`,
      [
        tenantId,
        agentId,
        JSON.stringify(bornerMessages(etat.messages)),
        JSON.stringify(etat.reponses),
        JSON.stringify(etat.poses),
        JSON.stringify(etat.bascules ?? []),
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
