import type { Pool } from 'pg';
import { encryptSecret, decryptSecret } from '../crypto/secretbox';
import { config } from '../config';
import type { EmailAccount, DecryptedEmailAccount, EmailAccountInput, EmailAccountUpdate } from './types';

const COLS = `id, tenant_id, label, host, port, secure, username, from_address, from_name, reply_to,
  verified_at, created_at`;

/** Forme brute d'une ligne `email_accounts` telle que Postgres la rend (colonnes de COLS, jamais le secret). */
interface EmailAccountRow {
  id: string;
  tenant_id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from_address: string;
  from_name: string | null;
  reply_to: string | null;
  verified_at: Date | null;
  created_at: Date;
}

/** Idem + le secret chiffré : uniquement pour getDecrypted(), jamais sélectionné ailleurs. */
interface EmailAccountRowWithSecret extends EmailAccountRow {
  password_enc: string;
}

/** Ligne brute -> EmailAccount. Partagée par les 4 méthodes qui SELECTent COLS, pour ne pas répéter le
 *  mapping (et ses casts) à chaque endroit. */
function toAccount(r: EmailAccountRow): EmailAccount {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    label: r.label,
    host: r.host,
    port: r.port,
    secure: r.secure,
    username: r.username,
    fromAddress: r.from_address,
    fromName: r.from_name,
    replyTo: r.reply_to,
    verifiedAt: r.verified_at ? r.verified_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

export class PgEmailAccountStore {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<EmailAccount[]> {
    const { rows } = await this.pool.query<EmailAccountRow>(
      `select ${COLS} from email_accounts where tenant_id=$1 and deleted_at is null order by created_at desc`,
      [tenantId],
    );
    return rows.map(toAccount);
  }

  async getById(tenantId: string, id: string): Promise<EmailAccount | null> {
    const { rows } = await this.pool.query<EmailAccountRow>(
      `select ${COLS} from email_accounts where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async getDecrypted(tenantId: string, id: string): Promise<DecryptedEmailAccount | null> {
    const { rows } = await this.pool.query<EmailAccountRowWithSecret>(
      `select ${COLS}, password_enc from email_accounts where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id],
    );
    const row = rows[0];
    if (!row) return null;
    return { ...toAccount(row), password: decryptSecret(row.password_enc, config.ENCRYPTION_KEY) };
  }

  async create(tenantId: string, input: EmailAccountInput): Promise<EmailAccount> {
    const { rows } = await this.pool.query<EmailAccountRow>(
      `insert into email_accounts
         (tenant_id, label, host, port, secure, username, password_enc, from_address, from_name, reply_to)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ${COLS}`,
      [tenantId, input.label, input.host, input.port, input.secure, input.username,
       encryptSecret(input.password, config.ENCRYPTION_KEY), input.fromAddress,
       input.fromName ?? null, input.replyTo ?? null],
    );
    return toAccount(rows[0]!);
  }

  async update(tenantId: string, id: string, patch: EmailAccountUpdate): Promise<EmailAccount | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    const push = (col: string, v: unknown): void => { sets.push(`${col}=$${i++}`); vals.push(v); };
    if (patch.label !== undefined) push('label', patch.label);
    if (patch.host !== undefined) push('host', patch.host);
    if (patch.port !== undefined) push('port', patch.port);
    if (patch.secure !== undefined) push('secure', patch.secure);
    if (patch.username !== undefined) push('username', patch.username);
    if (patch.password !== undefined) push('password_enc', encryptSecret(patch.password, config.ENCRYPTION_KEY));
    if (patch.fromAddress !== undefined) push('from_address', patch.fromAddress);
    if (patch.fromName !== undefined) push('from_name', patch.fromName);
    if (patch.replyTo !== undefined) push('reply_to', patch.replyTo);
    // Patch vide (aucun champ fourni) : no-op volontaire, pas d'UPDATE inutile. On relit l'état actuel pour
    // renvoyer la même forme que le cas modifié (l'appelant ne distingue pas les deux).
    if (sets.length === 0) return this.getById(tenantId, id);
    sets.push('updated_at=now()');
    vals.push(tenantId, id);
    const { rows } = await this.pool.query<EmailAccountRow>(
      `update email_accounts set ${sets.join(', ')}
        where tenant_id=$${i++} and id=$${i} and deleted_at is null returning ${COLS}`,
      vals,
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async softDelete(tenantId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update email_accounts set deleted_at=now() where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id],
    );
    return (rowCount ?? 0) > 0;
  }

  async markVerified(tenantId: string, id: string): Promise<void> {
    await this.pool.query(
      `update email_accounts set verified_at=now() where tenant_id=$1 and id=$2 and deleted_at is null`,
      [tenantId, id],
    );
  }
}
