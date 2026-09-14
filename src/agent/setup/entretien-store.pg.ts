import type { Pool } from 'pg';
import { lireEtat, type EntretienComplet, type EntretienStore } from './entretien-store';

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
    const res = await this.pool.query<{ messages: unknown; reponses: unknown; poses: unknown; bascules: unknown; auteurs: unknown }>(
      `select messages, reponses, poses, bascules, auteurs from agent_setup_conversations where agent_id = $2 and tenant_id = $1`,
      [tenantId, agentId],
    );
    const r = res.rows[0];
    return r ? lireEtat(r) : null;
  }

  async ecrire(tenantId: string, agentId: string, etat: EntretienComplet): Promise<void> {
    // Une seule LIGNE par agent : l'upsert écrase, il n'empile pas.
    //
    // ⚠️ CE COMMENTAIRE DISAIT « l'historique d'un entretien n'intéresse personne, et le garder ferait
    // grossir une table pour rien », ET C'EST DEVENU FAUX LE 2026-09-14. Le fil PERDURE désormais (« toute
    // la conversation avec l'assistant doit perdurer »), et c'est le tableau `messages` de cette unique
    // ligne qui le porte, en entier. Ce qui reste vrai est plus étroit : on n'empile pas une ligne par
    // version de l'entretien, on réécrit la même.
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
        // 🔴 PLUS DE TRONCATURE ICI (2026-09-14) : la borne est passée à la LECTURE du prompt
        // (`bornerPourModele`). Elle était posée à l'écriture, donc les tours anciens n'étaient pas
        // seulement absents du contexte du modèle, ils étaient DÉTRUITS. Un fil qui perdure ne peut pas
        // se faire amputer par sa propre sauvegarde.
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
