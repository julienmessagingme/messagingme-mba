import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgATraiterHubspot } from '../../src/inbox/a-traiter-hubspot.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LA LISTE DE LA PAGE « MESSAGING ME » DE HUBSPOT EN BASE (lot 4, décisions A et B) : ce que le faux de la route ne peut
 * qu'affirmer.
 *  - 🔴 l'isolation : un fil d'un autre espace n'y entre jamais ;
 *  - chaque branche du prédicat : l'escalade, le client qui attend, et ce qui reste dehors (l'agent de Meta, un robot,
 *    Traité, archivé, bloqué, STOP, une fin de parcours en attente) ; une conversation SANS fiche y entre ;
 *  - l'ordre : l'urgente d'abord, puis l'attente la plus ancienne, qui part du PREMIER message sans réponse ;
 *  - la borne et le total ; la fenêtre.
 *
 * Jamais joué en local (le DATABASE_URL local pointe l'ancienne production), joué par le job `integration`.
 */
describe.skipIf(!url)('la liste « à traiter » de la page HubSpot (Postgres)', () => {
  let pool: Pool;
  let t1: string;
  let t2: string;
  const ids: Record<string, string> = {};
  const depot = () => new PgATraiterHubspot(pool, () => Date.parse('2026-10-08T12:00:00Z'));

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    t1 = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-a-traiter') returning id`)).rows[0]!.id;
    t2 = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-a-traiter-autre') returning id`)).rows[0]!.id;
    const contact = async (t: string, tel: string, o: { bloque?: boolean; stop?: boolean } = {}) => (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, profile_name, blocked_at, opt_in_status) values ($1, $2, 'Claire', $3, $4) returning id`,
      [t, tel, o.bloque ? new Date() : null, o.stop ? 'opted_out' : 'unknown'],
    )).rows[0]!.id;
    const fil = async (
      nom: string, t: string, wa: string, contactId: string | null,
      o: { owner?: string; sens?: string; dernier?: string; escaladee?: string; traitee?: boolean; archivee?: boolean; urgente?: boolean; finParcours?: boolean } = {},
    ) => {
      ids[nom] = (await pool.query<{ id: string }>(
        `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, last_direction, control_owner, escaladee_le,
                                    traitee_le, archived_at, urgente_le, release_mba_apres_message, last_preview)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [t, wa, contactId, o.dernier ?? '2026-10-08T09:30:00Z', o.sens ?? 'in', o.owner ?? 'app_human', o.escaladee ?? null,
          o.traitee ? new Date() : null, o.archivee ? new Date() : null, o.urgente ? new Date() : null,
          o.finParcours ? 'wamid.itest-fin' : null, `aperçu ${nom} `.padEnd(200, '.')],
      )).rows[0]!.id;
      return ids[nom]!;
    };
    const msg = (conv: string, sens: 'in' | 'out', at: string) => pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, created_at, channel) values ($1, $2, 'text', 'x', $3, 'whatsapp')`,
      [conv, sens, at],
    );

    // Dedans.
    const client = await fil('client', t1, '33600001401', await contact(t1, '+33600001401'));
    await msg(client, 'out', '2026-10-08T08:00:00Z');
    await msg(client, 'in', '2026-10-08T08:30:00Z');
    await msg(client, 'in', '2026-10-08T09:30:00Z'); // il insiste : l'attente part toujours de 08:30
    await fil('escalade', t1, '33600001402', await contact(t1, '+33600001402'), { sens: 'out', escaladee: '2026-10-08T09:00:00Z' });
    await fil('sansFiche', t1, '33600001403', null, { dernier: '2026-10-08T09:15:00Z' });
    const urgente = await fil('urgente', t1, '33600001404', await contact(t1, '+33600001404'), { urgente: true, dernier: '2026-10-08T10:00:00Z' });
    await msg(urgente, 'in', '2026-10-08T10:00:00Z');
    // Dehors.
    await fil('mba', t1, '33600001405', await contact(t1, '+33600001405'), { owner: 'mba' });
    await fil('robot', t1, '33600001406', await contact(t1, '+33600001406'), { owner: 'app_workflow' });
    await fil('traitee', t1, '33600001407', await contact(t1, '+33600001407'), { traitee: true });
    await fil('archivee', t1, '33600001408', await contact(t1, '+33600001408'), { archivee: true });
    await fil('bloquee', t1, '33600001409', await contact(t1, '+33600001409', { bloque: true }));
    await fil('stop', t1, '33600001410', await contact(t1, '+33600001410', { stop: true }));
    await fil('finParcours', t1, '33600001411', await contact(t1, '+33600001411'), { finParcours: true });
    await fil('repondue', t1, '33600001412', await contact(t1, '+33600001412'), { sens: 'out' });
    await fil('ailleurs', t2, '33600001413', await contact(t2, '+33600001413'), { dernier: '2026-10-08T07:00:00Z' });
    // Sans fiche reliée, mais le NUMÉRO a dit STOP, ou a été bloqué, sur une fiche : dehors (la lecture des routes d'envoi).
    await contact(t1, '+33600001414', { stop: true });
    await fil('stopParNumero', t1, '33600001414', null);
    await contact(t1, '+33600001415', { bloque: true });
    await fil('bloqueParNumero', t1, '33600001415', null);
    // Deux attentes égales : l'identifiant départage, la liste est stable d'une lecture à l'autre.
    await fil('egalA', t1, '33600001416', await contact(t1, '+33600001416'), { sens: 'out', escaladee: '2026-10-08T09:45:00Z' });
    await fil('egalB', t1, '33600001417', await contact(t1, '+33600001417'), { sens: 'out', escaladee: '2026-10-08T09:45:00Z' });
  });

  const egales = () => [ids.egalA!, ids.egalB!].sort();

  afterAll(async () => {
    for (const t of [t1, t2]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  it('🔴 seules les conversations de l’espace qui attendent un humain, l’urgente d’abord puis la plus ancienne attente', async () => {
    const { total, lignes } = await depot().lister(t1, 200);
    expect(lignes.map((l) => l.conversationId)).toEqual([ids.urgente, ids.client, ids.escalade, ids.sansFiche, ...egales()]);
    expect(total).toBe(6);
    expect(lignes.map((l) => l.conversationId)).not.toContain(ids.ailleurs);
  });

  it('🔴 un numéro qui a dit STOP, ou qui est bloqué, reste dehors même sans fiche reliée à la conversation', async () => {
    const { lignes } = await depot().lister(t1, 200);
    expect(lignes.map((l) => l.conversationId)).not.toContain(ids.stopParNumero);
    expect(lignes.map((l) => l.conversationId)).not.toContain(ids.bloqueParNumero);
  });

  it('l’attente part du premier message sans réponse, ou de l’escalade ; la fenêtre suit le dernier message du client', async () => {
    const { lignes } = await depot().lister(t1, 200);
    const de = (nom: string) => lignes.find((l) => l.conversationId === ids[nom])!;
    expect(de('client')).toMatchObject({
      attendDepuis: '2026-10-08T08:30:00.000Z', motif: 'message', fenetreOuverte: true, finFenetre: '2026-10-09T09:30:00.000Z',
      nom: 'Claire', numero: '+33600001401', urgente: false, affecteA: null,
    });
    expect(de('client').apercu).toHaveLength(140);
    expect(de('escalade')).toMatchObject({ attendDepuis: '2026-10-08T09:00:00.000Z', motif: 'escalade', fenetreOuverte: false, finFenetre: null });
    // Sans fiche : elle attend aussi, son numéro vient du wa_id.
    expect(de('sansFiche')).toMatchObject({ nom: null, numero: '+33600001403', attendDepuis: '2026-10-08T09:15:00.000Z' });
  });

  it('la borne garde l’ordre et le total compte toutes celles qui attendent', async () => {
    const { total, lignes } = await depot().lister(t1, 2);
    expect(lignes.map((l) => l.conversationId)).toEqual([ids.urgente, ids.client]);
    expect(total).toBe(6);
  });

  it('🔴 l’autre espace ne voit que sa conversation', async () => {
    const { total, lignes } = await depot().lister(t2, 200);
    expect(lignes.map((l) => l.conversationId)).toEqual([ids.ailleurs]);
    expect(total).toBe(1);
  });
});
