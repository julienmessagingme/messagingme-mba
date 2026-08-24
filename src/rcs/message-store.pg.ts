import type { Pool } from 'pg';
import type { RcsOutbound } from './types';
import { parseStoredRcsOutbound } from './schema';

export interface RcsMessage {
  id: string;
  name: string;
  /** null = contenu stocké dont la forme n'est plus reconnue (schéma durci depuis). On le SIGNALE au lieu de
   *  le faire passer pour un message valide qui échouerait à l'envoi. */
  content: RcsOutbound | null;
  createdAt: string;
  updatedAt: string;
}

const COLS = 'id, name, content, created_at, updated_at';

interface Row { id: string; name: string; content: unknown; created_at: Date; updated_at: Date }

function toMessage(r: Row): RcsMessage {
  return {
    id: r.id,
    name: r.name,
    content: parseStoredRcsOutbound(r.content),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/**
 * Bibliothèque de messages RCS réutilisables (table `rcs_messages`, migration 0077).
 *
 * Le pendant des modèles d'email, à une différence près : un message RCS n'a AUCUNE validation à obtenir.
 * Il part tel qu'il est écrit sous l'agent de la marque. La bibliothèque sert à RÉUTILISER, pas à faire
 * approuver. Suppression DOUCE (`deleted_at`) comme les modèles d'email : une campagne passée garde la trace
 * du message qu'elle a envoyé.
 */
export class PgRcsMessageStore {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<RcsMessage[]> {
    const { rows } = await this.pool.query<Row>(
      `select ${COLS} from rcs_messages where tenant_id=$1 and deleted_at is null order by updated_at desc`,
      [tenantId],
    );
    return rows.map(toMessage);
  }

  async getById(tenantId: string, id: string): Promise<RcsMessage | null> {
    const { rows } = await this.pool.query<Row>(
      `select ${COLS} from rcs_messages where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id],
    );
    return rows[0] ? toMessage(rows[0]) : null;
  }

  async create(tenantId: string, name: string, content: RcsOutbound): Promise<RcsMessage> {
    const { rows } = await this.pool.query<Row>(
      `insert into rcs_messages (tenant_id, name, content) values ($1,$2,$3::jsonb) returning ${COLS}`,
      [tenantId, name, JSON.stringify(content)],
    );
    return toMessage(rows[0]!);
  }

  /** true si la ligne existait (et appartenait au tenant). Le scope tenant est DANS le where : un id d'un
   *  autre workspace ne modifie rien et rend false, jamais une écriture croisée. */
  async update(tenantId: string, id: string, name: string, content: RcsOutbound): Promise<boolean> {
    const res = await this.pool.query(
      `update rcs_messages set name=$3, content=$4::jsonb, updated_at=now()
       where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id, name, JSON.stringify(content)],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `update rcs_messages set deleted_at=now() where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
