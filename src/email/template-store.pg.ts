import type { Pool } from 'pg';
import type { EmailTemplate, EmailTemplateFormat, EmailTemplateInput, EmailTemplateUpdate } from './types';

const COLS = `id, tenant_id, name, format, subject, body, created_at, updated_at`;

/** Forme brute d'une ligne `email_templates` telle que Postgres la rend (colonnes de COLS). */
interface EmailTemplateRow {
  id: string;
  tenant_id: string;
  name: string;
  format: EmailTemplateFormat;
  subject: string;
  body: string;
  created_at: Date;
  updated_at: Date;
}

/** Ligne brute -> EmailTemplate. Partagée par les méthodes qui SELECTent COLS, pour ne pas répéter le
 *  mapping (et ses casts) à chaque endroit. */
function toTemplate(r: EmailTemplateRow): EmailTemplate {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    format: r.format,
    subject: r.subject,
    body: r.body,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export class PgEmailTemplateStore {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<EmailTemplate[]> {
    const { rows } = await this.pool.query<EmailTemplateRow>(
      `select ${COLS} from email_templates where tenant_id=$1 and deleted_at is null order by created_at desc`,
      [tenantId],
    );
    return rows.map(toTemplate);
  }

  async getById(tenantId: string, id: string): Promise<EmailTemplate | null> {
    const { rows } = await this.pool.query<EmailTemplateRow>(
      `select ${COLS} from email_templates where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id],
    );
    return rows[0] ? toTemplate(rows[0]) : null;
  }

  async create(tenantId: string, input: EmailTemplateInput): Promise<EmailTemplate> {
    const { rows } = await this.pool.query<EmailTemplateRow>(
      `insert into email_templates (tenant_id, name, format, subject, body)
       values ($1,$2,$3,$4,$5) returning ${COLS}`,
      [tenantId, input.name, input.format, input.subject, input.body],
    );
    return toTemplate(rows[0]!);
  }

  async update(tenantId: string, id: string, patch: EmailTemplateUpdate): Promise<EmailTemplate | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    const push = (col: string, v: unknown): void => { sets.push(`${col}=$${i++}`); vals.push(v); };
    if (patch.name !== undefined) push('name', patch.name);
    if (patch.format !== undefined) push('format', patch.format);
    if (patch.subject !== undefined) push('subject', patch.subject);
    if (patch.body !== undefined) push('body', patch.body);
    // Patch vide (aucun champ fourni) : no-op volontaire, pas d'UPDATE inutile. On relit l'état actuel pour
    // renvoyer la même forme que le cas modifié (l'appelant ne distingue pas les deux).
    if (sets.length === 0) return this.getById(tenantId, id);
    sets.push('updated_at=now()');
    vals.push(tenantId, id);
    const { rows } = await this.pool.query<EmailTemplateRow>(
      `update email_templates set ${sets.join(', ')}
        where tenant_id=$${i++} and id=$${i} and deleted_at is null returning ${COLS}`,
      vals,
    );
    return rows[0] ? toTemplate(rows[0]) : null;
  }

  async softDelete(tenantId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update email_templates set deleted_at=now() where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id],
    );
    return (rowCount ?? 0) > 0;
  }
}
