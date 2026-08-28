import type { Pool } from 'pg';
import { encryptSecret, decryptSecret } from '../crypto/secretbox';
import { config } from '../config';
import {
  LabelSourceDejaPris,
  type AuthSource, type CreationSource, type KindSource, type PatchSource,
  type SourceAppel, type SourceStore, type SourceVue, type StatutSource,
} from './sources';

/**
 * Les sources externes en base (migration 0088).
 *
 * ⚠️ `tenant_id` sur CHAQUE requête : le pooler est superuser, la RLS est bypassée, et ici le filtrage protège
 * une adresse réseau et un secret. Une source lue sans ce filtre ferait appeler le système d'un autre client.
 *
 * 🔴 LE SECRET N'EST JAMAIS SÉLECTIONNÉ AILLEURS QUE DANS `pourAppel`. Les autres méthodes rendent
 * `auth_secret_enc is not null` (donc un booléen), et rien d'autre : c'est ce qui garantit qu'aucune route ne
 * peut le laisser fuiter par inadvertance, même en ajoutant un champ à la projection.
 */

/** Colonnes de la projection PUBLIQUE. Le secret n'y est pas, seulement son EXISTENCE. */
const COLS = `s.id, s.tenant_id, s.kind, s.label, s.base_url, s.auth_kind, s.auth_header_name,
  (s.auth_secret_enc is not null) as a_auth, s.status, s.last_ok_at, s.last_error,
  (select count(*)::int from agent_tools t where t.source_id = s.id and t.actif) as outils_actifs`;

interface LigneVue {
  id: string; tenant_id: string; kind: string; label: string; base_url: string;
  auth_kind: string; auth_header_name: string | null; a_auth: boolean;
  status: string; last_ok_at: Date | null; last_error: string | null; outils_actifs: number;
}

function versVue(r: LigneVue): SourceVue {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind as KindSource,
    label: r.label,
    baseUrl: r.base_url,
    authKind: r.auth_kind as AuthSource,
    authHeaderName: r.auth_header_name,
    aAuthentification: r.a_auth,
    status: r.status as StatutSource,
    lastOkAt: r.last_ok_at ? r.last_ok_at.toISOString() : null,
    lastError: r.last_error,
    outilsActifs: r.outils_actifs,
  };
}

/** `23505` = violation d'unicité sur `(tenant_id, lower(label))`. Traduite en erreur typée, pour que la route
 *  rende 409 : un 500 sur un libellé en double afficherait la page d'erreur de Cloudflare. */
function surLabelDejaPris(label: string) {
  return (err: unknown): never => {
    if ((err as { code?: string })?.code === '23505') throw new LabelSourceDejaPris(label);
    throw err;
  };
}

export class PgSourceStore implements SourceStore {
  constructor(private readonly pool: Pool) {}

  async lister(tenantId: string): Promise<SourceVue[]> {
    const res = await this.pool.query<LigneVue>(
      `select ${COLS} from agent_tool_sources s where s.tenant_id = $1 order by lower(s.label)`,
      [tenantId],
    );
    return res.rows.map(versVue);
  }

  async parId(tenantId: string, id: string): Promise<SourceVue | null> {
    const res = await this.pool.query<LigneVue>(
      `select ${COLS} from agent_tool_sources s where s.tenant_id = $1 and s.id = $2`,
      [tenantId, id],
    );
    const r = res.rows[0];
    return r ? versVue(r) : null;
  }

  async creer(tenantId: string, input: CreationSource): Promise<SourceVue> {
    // Le secret est chiffré ICI, jamais plus haut : la couche HTTP ne doit pas manipuler de forme chiffrée,
    // et la couche de stockage est le seul endroit qui connaît la clé.
    const secret = input.authSecret && input.authSecret !== '' ? encryptSecret(input.authSecret, config.ENCRYPTION_KEY) : null;
    const res = await this.pool.query<LigneVue>(
      `with nouvelle as (
         insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, auth_header_name, auth_secret_enc)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning *
       )
       select ${COLS} from nouvelle s`,
      [tenantId, input.kind, input.label, input.baseUrl, input.authKind, input.authHeaderName ?? null, secret],
    ).catch(surLabelDejaPris(input.label));
    return versVue(res.rows[0]!);
  }

  async patch(tenantId: string, id: string, patch: PatchSource): Promise<SourceVue | null> {
    const sets: string[] = [];
    const vals: unknown[] = [tenantId, id];
    const push = (col: string, v: unknown): void => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (patch.label !== undefined) push('label', patch.label);
    if (patch.baseUrl !== undefined) push('base_url', patch.baseUrl);
    if (patch.authKind !== undefined) push('auth_kind', patch.authKind);
    if (patch.authHeaderName !== undefined) push('auth_header_name', patch.authHeaderName);
    if (patch.status !== undefined) push('status', patch.status);
    // 🔴 LES DEUX BRANCHES SONT EXCLUSIVES, ET C'EST STRUCTUREL. Écrites en deux `if` indépendants, un corps
    // portant `{ authKind: 'none', authSecret: 'x' }` poussait DEUX fois `auth_secret_enc` dans le même
    // `update ... set` : Postgres refuse une double affectation de colonne, l'erreur n'est pas un `23505`,
    // elle remontait donc jusqu'au 500 dont Cloudflare remplace le corps. Sur une route de configuration,
    // c'est un client qui voit une page d'incident au lieu d'un message.
    //
    // Passer en `none` RETIRE le secret (la contrainte de la migration l'exige, et garder un secret que plus
    // rien n'utilise n'a aucun intérêt) ; sinon, un secret ABSENT vaut INCHANGÉ, parce que l'écran ne peut
    // pas le renvoyer : il ne l'a jamais eu.
    if (patch.authKind === 'none') {
      push('auth_secret_enc', null);
    } else if (patch.authSecret !== undefined && patch.authSecret !== '') {
      push('auth_secret_enc', encryptSecret(patch.authSecret, config.ENCRYPTION_KEY));
    }
    if (sets.length === 0) return this.parId(tenantId, id);

    const res = await this.pool.query<LigneVue>(
      `with maj as (
         update agent_tool_sources set ${sets.join(', ')}, updated_at = now()
          where tenant_id = $1 and id = $2
          returning *
       )
       select ${COLS} from maj s`,
      vals,
    ).catch(surLabelDejaPris(patch.label ?? ''));
    const r = res.rows[0];
    return r ? versVue(r) : null;
  }

  async supprimer(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query('delete from agent_tool_sources where tenant_id = $1 and id = $2', [tenantId, id]);
    return (res.rowCount ?? 0) > 0;
  }

  async pourAppel(tenantId: string, id: string): Promise<SourceAppel | null> {
    const res = await this.pool.query<{
      id: string; base_url: string; auth_kind: string; auth_header_name: string | null;
      auth_secret_enc: string | null; status: string;
    }>(
      `select id, base_url, auth_kind, auth_header_name, auth_secret_enc, status
         from agent_tool_sources where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      baseUrl: r.base_url,
      authKind: r.auth_kind as AuthSource,
      authHeaderName: r.auth_header_name,
      authSecret: r.auth_secret_enc ? decryptSecret(r.auth_secret_enc, config.ENCRYPTION_KEY) : null,
      status: r.status as StatutSource,
    };
  }

  async marquerEpreuve(tenantId: string, id: string, ok: boolean, erreur?: string): Promise<void> {
    // Une réussite EFFACE la dernière erreur : sinon l'écran afficherait indéfiniment un incident réglé, et
    // le client cesserait de regarder ce champ, qui est justement le seul signal d'un jeton mort.
    await this.pool.query(
      `update agent_tool_sources
          set last_ok_at = case when $3 then now() else last_ok_at end,
              last_error = case when $3 then null else left($4, 500) end,
              updated_at = now()
        where tenant_id = $1 and id = $2`,
      [tenantId, id, ok, erreur ?? 'échec'],
    );
  }
}
