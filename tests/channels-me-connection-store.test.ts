import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { encryptSecret } from '../src/crypto/secretbox';
import { PgChannelsMeConnectionStore } from '../src/channels-me/connection-store.pg';

/**
 * La connexion Channels Me d un tenant, avec un FAUX pool (aucune base reelle), patron
 * tests/email-account-store.test.ts.
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. La requete de get() ne NOMME meme pas les colonnes chiffrees. C est cette projection que la route sert
 *     au navigateur : une cle d API de chaine qui fuiterait laisserait publier a notre place sur la chaine
 *     du client.
 *  2. Le chiffrement se fait DANS le store, dans le tableau de parametres de la requete. Un clair passe en
 *     parametre serait un clair en base, donc un secret lisible dans n importe quelle sauvegarde.
 *  3. Chaque requete porte tenant_id=$1. Le pooler est superuser, la RLS est contournee : c est le SEUL
 *     controle d isolation entre clients.
 *  4. Remplacer les creds efface verified_at. Sinon l ecran annoncerait « verifiee » a propos d une cle que
 *     personne n a jamais essayee.
 */

// Cle FICTIVE (aucun secret) : 64 caracteres hex, valeur figee. Le contrat injecte la cle par le
// CONSTRUCTEUR, donc ce fichier ne depend ni de src/config.ts ni d une variable d environnement.
const CLE = 'b'.repeat(64);
const TENANT = 't1';
// Valeurs FICTIVES qui ressemblent a des secrets, pour que les assertions « le clair ne fuit nulle part »
// portent sur des chaines reconnaissables.
const CLE_API = 'cle-api-fictive-42';
const SECRET_HMAC = 'secret-hmac-fictif-42';

interface Reponse { rows: Array<Record<string, unknown>>; rowCount?: number }

/** Faux pool : enregistre SQL et params, repond selon l ordre des appels. Aucune base, aucun reseau. */
function fauxPool(reponses: Reponse[] = []) {
  const requetes: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      requetes.push({ sql, params });
      const r = reponses[Math.min(i, reponses.length - 1)] ?? { rows: [] };
      i += 1;
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    },
  } as unknown as Pool;
  return { pool, requetes };
}

/** Ligne rendue par le SELECT de get() : les colonnes de COLS, jamais un chiffre. `created_at` absent de
 *  COLS, `verified_at` en Date (c est ce que le driver pg rend pour un timestamptz, et le store appelle
 *  .toISOString() dessus directement). */
function lignePublique(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { org_id: 'org-1', channel_id: 'ch-1', verified_at: null, ...over };
}

/** Ligne rendue par le SELECT de getSecrets() : COLS plus les deux colonnes chiffrees, chiffrees POUR DE
 *  VRAI (un placeholder du genre 'v1.iv.tag.data' ferait planter le dechiffrement avant les assertions). */
function ligneAvecSecrets(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...lignePublique(),
    api_key_enc: encryptSecret(CLE_API, CLE),
    secret_enc: encryptSecret(SECRET_HMAC, CLE),
    ...over,
  };
}

describe('PgChannelsMeConnectionStore (faux pool, sans base reelle)', () => {
  it('🔴 get() ne nomme AUCUNE colonne chiffree et ne rend aucun secret', async () => {
    const { pool, requetes } = fauxPool([
      { rows: [lignePublique({ verified_at: new Date('2026-09-04T10:00:00.000Z') })] },
    ]);
    const cx = await new PgChannelsMeConnectionStore(pool, CLE).get(TENANT);

    expect(requetes).toHaveLength(1);
    // Le coeur du test : sur ce chemin, le chiffre ne quitte meme pas la base.
    expect(requetes[0]!.sql).not.toMatch(/_enc/i);
    // toEqual COMPLET : il prouve aussi qu aucun champ en trop (apiKey, secret) n est rendu.
    expect(cx).toEqual({
      orgId: 'org-1', channelId: 'ch-1', hasApiKey: true, hasSecret: true,
      verifiedAt: '2026-09-04T10:00:00.000Z',
    });
    expect((cx as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    expect((cx as unknown as Record<string, unknown>).secret).toBeUndefined();
  });

  it('get() : aucune ligne pour ce tenant, rend null', async () => {
    const { pool } = fauxPool([{ rows: [] }]);
    expect(await new PgChannelsMeConnectionStore(pool, CLE).get(TENANT)).toBeNull();
  });

  it('getSecrets() : aller-retour, les deux colonnes chiffrees redonnent les clairs', async () => {
    const { pool, requetes } = fauxPool([{ rows: [ligneAvecSecrets()] }]);
    const cx = await new PgChannelsMeConnectionStore(pool, CLE).getSecrets(TENANT);

    expect(cx).toEqual({ orgId: 'org-1', channelId: 'ch-1', apiKey: CLE_API, secret: SECRET_HMAC });
    // La SEULE requete du store qui a le droit de lire les colonnes chiffrees.
    expect(requetes[0]!.sql).toMatch(/api_key_enc/);
    expect(requetes[0]!.sql).toMatch(/secret_enc/);
  });

  it('getSecrets() : aucune ligne, rend null sans rien dechiffrer', async () => {
    const { pool } = fauxPool([{ rows: [] }]);
    expect(await new PgChannelsMeConnectionStore(pool, CLE).getSecrets(TENANT)).toBeNull();
  });

  it('🔴 upsert() chiffre les DEUX secrets dans les parametres : aucun clair, format v1. de secretbox', async () => {
    const { pool, requetes } = fauxPool();
    await new PgChannelsMeConnectionStore(pool, CLE).upsert(TENANT, {
      orgId: 'org-1', channelId: 'ch-1', apiKey: CLE_API, secret: SECRET_HMAC,
    });

    const q = requetes[0]!;
    // Ordre des params de l INSERT : (tenant_id, org_id, channel_id, api_key_enc, secret_enc).
    const apiEnc = q.params[3] as string;
    const secretEnc = q.params[4] as string;
    expect(apiEnc.startsWith('v1.')).toBe(true);
    expect(secretEnc.startsWith('v1.')).toBe(true);
    // Le clair ne fuit dans AUCUN slot, pas seulement dans le sien.
    for (const p of q.params) {
      expect(String(p)).not.toContain(CLE_API);
      expect(String(p)).not.toContain(SECRET_HMAC);
    }
    // Deux chiffres distincts : l iv est tire au hasard a chaque appel.
    expect(apiEnc).not.toBe(secretEnc);
  });

  it('🔴 upsert() remet verified_at a null : une preuve de validite ne survit pas a la cle qu elle prouvait', async () => {
    const { pool, requetes } = fauxPool();
    await new PgChannelsMeConnectionStore(pool, CLE).upsert(TENANT, {
      orgId: 'org-2', channelId: 'ch-2', apiKey: CLE_API, secret: SECRET_HMAC,
    });
    const sql = requetes[0]!.sql;
    expect(sql).toMatch(/on conflict \(tenant_id\) do update/i);
    expect(sql).toMatch(/verified_at\s*=\s*null/i);
  });

  describe('isolation tenant : tenant_id=$1 sur CHAQUE requete', () => {
    it('get()', async () => {
      const { pool, requetes } = fauxPool([{ rows: [lignePublique()] }]);
      await new PgChannelsMeConnectionStore(pool, CLE).get(TENANT);
      expect(requetes[0]!.params).toEqual([TENANT]);
      expect(requetes[0]!.sql).toMatch(/tenant_id\s*=\s*\$1/i);
    });

    it('getSecrets()', async () => {
      const { pool, requetes } = fauxPool([{ rows: [ligneAvecSecrets()] }]);
      await new PgChannelsMeConnectionStore(pool, CLE).getSecrets(TENANT);
      expect(requetes[0]!.params).toEqual([TENANT]);
      expect(requetes[0]!.sql).toMatch(/tenant_id\s*=\s*\$1/i);
    });

    it('upsert()', async () => {
      const { pool, requetes } = fauxPool();
      await new PgChannelsMeConnectionStore(pool, CLE).upsert(TENANT, {
        orgId: 'org-1', channelId: 'ch-1', apiKey: CLE_API, secret: SECRET_HMAC,
      });
      expect(requetes[0]!.params[0]).toBe(TENANT); // tenant_id : 1re colonne de l INSERT
      expect(requetes[0]!.sql).toMatch(/tenant_id/i);
    });

    it('markVerified()', async () => {
      const { pool, requetes } = fauxPool();
      await new PgChannelsMeConnectionStore(pool, CLE).markVerified(TENANT);
      expect(requetes[0]!.sql).toMatch(/^update channelsme_connections set verified_at\s*=\s*now\(\)/i);
      expect(requetes[0]!.sql).toMatch(/tenant_id\s*=\s*\$1/i);
      expect(requetes[0]!.params).toEqual([TENANT]);
    });
  });
});
