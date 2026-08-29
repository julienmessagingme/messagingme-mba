import type { Pool } from 'pg';
import type {
  JournalAppels, OutilComplet, OutilDefini, PatchOutil, RisqueOutil, ToolAdminStore, ToolCatalog,
} from './catalog';
import { NomOutilDejaPris } from './catalog';
import { asRecord } from '../webhooks/json';

interface Ligne {
  id: string;
  tenant_id: string;
  agent_id: string;
  origin: OutilDefini['origin'];
  name: string;
  description: string;
  ne_pas_utiliser: string;
  params: unknown;
  binding: unknown;
  source_id: string | null;
  output_paths: string[] | null;
  risk: OutilDefini['risk'];
  timeout_ms: number;
  max_bytes: number;
  autonome: boolean;
}

/** Colonnes lues par les deux requêtes. Une seule liste : deux projections divergentes finiraient par ne plus
 *  rendre le même outil selon le chemin, et le chemin qui compte est celui de l'exécution. */
const COLONNES = `id, tenant_id, agent_id, origin, name, description, ne_pas_utiliser, params, binding,
                  source_id, output_paths, risk, timeout_ms, max_bytes, autonome`;

function versOutil(r: Ligne): OutilDefini {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    agentId: r.agent_id,
    origin: r.origin,
    name: r.name,
    description: r.description,
    // 🔴 LUE PAR LE RUNTIME depuis le 2026-08-29, et elle ne l'était pas. Elle vivait dans la seule
    // projection d'administration, donc le modèle ne l'a jamais vue. Voir `OutilDefini.nePasUtiliser`.
    nePasUtiliser: r.ne_pas_utiliser,
    params: r.params,
    // `binding` est du jsonb, donc opaque : lu par le helper défensif maison plutôt qu'affirmé par un `as`.
    // Un scalaire ou un null donne un objet vide, et le résolveur refuse alors proprement.
    binding: asRecord(r.binding),
    // La source vit sur la LIGNE, pas dans `binding` : elle est une clé étrangère, et la contrainte
    // `agent_tools_origin_src_chk` la rend obligatoire dès que l'origine n'est pas `mba`.
    sourceId: r.source_id,
    outputPaths: r.output_paths ?? [],
    risk: r.risk,
    timeoutMs: r.timeout_ms,
    maxBytes: r.max_bytes,
    autonome: r.autonome,
  };
}

/**
 * Lecture du catalogue d'outils (migration 0086).
 *
 * 🔴 `and actif` est dans le SQL des DEUX requêtes, et `tenant_id = $1 and agent_id = $2` aussi. Le nom
 * d'outil vient du modèle, donc d'un texte qu'un contact peut influencer : c'est la clause `where` qui
 * empêche d'appeler l'outil d'un autre agent ou d'un autre client (voir `ToolCatalog.byName`).
 */
export class PgToolCatalog implements ToolCatalog, ToolAdminStore {
  constructor(private readonly pool: Pool) {}

  async byName(tenantId: string, agentId: string, name: string): Promise<OutilDefini | null> {
    const res = await this.pool.query<Ligne>(
      `select ${COLONNES} from agent_tools
        where tenant_id = $1 and agent_id = $2 and name = $3 and actif`,
      [tenantId, agentId, name],
    );
    const r = res.rows[0];
    return r ? versOutil(r) : null;
  }

  async listActifs(tenantId: string, agentId: string): Promise<OutilDefini[]> {
    const res = await this.pool.query<Ligne>(
      `select ${COLONNES} from agent_tools
        where tenant_id = $1 and agent_id = $2 and actif order by name`,
      [tenantId, agentId],
    );
    return res.rows.map(versOutil);
  }

  // ---------- Écriture : l'écran de réglage (tranche 19c) ----------

  async listToutes(tenantId: string, agentId: string): Promise<OutilComplet[]> {
    const res = await this.pool.query<LigneAdmin>(
      `select ${COLONNES_ADMIN} from agent_tools
        where tenant_id = $1 and agent_id = $2 order by name`,
      [tenantId, agentId],
    );
    return res.rows.map(versComplet);
  }

  async ajouter(tenantId: string, agentId: string, outil: {
    handler: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: RisqueOutil;
  }): Promise<OutilComplet | null> {
    // `origin` vaut 'mba' en dur : L1 n'a que des outils maison, et le corps de la requête n'a rien à dire
    // là-dessus. `actif` reste à son défaut (faux) : la migration 0086 refuserait un actif sans activateur,
    // et surtout un outil actif d'emblée serait exposé au modèle avant que quiconque ait relu ses mots.
    const res = await this.pool.query<LigneAdmin>(
      `insert into agent_tools
         (tenant_id, agent_id, origin, name, title, description, ne_pas_utiliser, params, binding, risk)
       select $1, $2, 'mba', $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9
        where exists (select 1 from agents where id = $2 and tenant_id = $1)
       returning ${COLONNES_ADMIN}`,
      [
        tenantId, agentId, outil.name, outil.title, outil.description, outil.nePasUtiliser,
        JSON.stringify(outil.params ?? []),
        // `binding.handler` est ce qui donne son COMPORTEMENT à l'outil : le résolveur maison le lit là, et
        // jamais dans le nom exposé, que le client peut changer.
        JSON.stringify({ handler: outil.handler }),
        outil.risk,
      ],
    ).catch(surNomDejaPris);
    const r = res.rows[0];
    return r ? versComplet(r) : null;
  }

  /**
   * Un outil de CONNECTEUR (lot L2). `origin` vaut `'http'` en dur : comme pour les outils maison, le corps de
   * la requête n'a rien à dire là-dessus.
   *
   * La SOURCE est vérifiée dans le même ordre que l'agent, par le `where exists` : une source d'un autre
   * tenant ne produit aucune ligne plutôt qu'une violation de clé étrangère, donc un 404 plutôt qu'un 500.
   */
  async ajouterConnecteur(tenantId: string, agentId: string, outil: {
    sourceId: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; binding: { methode: string; chemin: string }; outputPaths: string[]; risk: RisqueOutil;
  }): Promise<OutilComplet | null> {
    const res = await this.pool.query<LigneAdmin>(
      `insert into agent_tools
         (tenant_id, agent_id, origin, source_id, name, title, description, ne_pas_utiliser, params, binding, output_paths, risk)
       select $1, $2, 'http', $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::text[], $11
        where exists (select 1 from agents where id = $2 and tenant_id = $1)
          and exists (select 1 from agent_tool_sources where id = $3 and tenant_id = $1)
       returning ${COLONNES_ADMIN}`,
      [
        tenantId, agentId, outil.sourceId, outil.name, outil.title, outil.description, outil.nePasUtiliser,
        JSON.stringify(outil.params ?? []),
        JSON.stringify(outil.binding),
        outil.outputPaths,
        outil.risk,
      ],
    ).catch(surNomDejaPris);
    const r = res.rows[0];
    return r ? versComplet(r) : null;
  }

  async patch(tenantId: string, agentId: string, outilId: string, patch: PatchOutil): Promise<OutilComplet | null> {
    // Les énumérations sont réécrites DANS le jsonb, en une instruction : une lecture suivie d'une écriture
    // laisserait deux administrateurs se recouvrir en silence sur la même colonne.
    const res = await this.pool.query<LigneAdmin>(
      `update agent_tools set
         name = coalesce($4, name),
         title = coalesce($5, title),
         description = coalesce($6, description),
         ne_pas_utiliser = coalesce($7, ne_pas_utiliser),
         params = case when $8::jsonb is null then params else (
           select coalesce(jsonb_agg(
             case when $8::jsonb ? (p->>'name')
                  then jsonb_set(p - 'enum', '{enum}', $8::jsonb -> (p->>'name'))
                  else p end
             order by ord), '[]'::jsonb)
             from jsonb_array_elements(params) with ordinality as t(p, ord)
         ) end,
         updated_at = now()
       where tenant_id = $1 and agent_id = $2 and id = $3
       returning ${COLONNES_ADMIN}`,
      [tenantId, agentId, outilId, patch.name ?? null, patch.title ?? null, patch.description ?? null,
        patch.nePasUtiliser ?? null, patch.enums ? JSON.stringify(patch.enums) : null],
    ).catch(surNomDejaPris);
    const r = res.rows[0];
    return r ? versComplet(r) : null;
  }

  async activer(
    tenantId: string, agentId: string, outilId: string, actif: boolean, parUtilisateur: string,
  ): Promise<OutilComplet | null> {
    // Désactiver EFFACE l'activateur : ces deux colonnes disent « qui l'a mis en service, et quand », pas
    // « qui y a touché un jour ». Les garder ferait afficher un consentement qui n'a plus cours.
    const res = await this.pool.query<LigneAdmin>(
      `update agent_tools set
         actif = $4,
         active_par = case when $4 then $5::uuid else null end,
         active_le = case when $4 then now() else null end,
         updated_at = now()
       where tenant_id = $1 and agent_id = $2 and id = $3
       returning ${COLONNES_ADMIN}`,
      [tenantId, agentId, outilId, actif, parUtilisateur],
    );
    const r = res.rows[0];
    return r ? versComplet(r) : null;
  }

  async autonomie(
    tenantId: string, agentId: string, outilId: string, autonome: boolean, parUtilisateur: string,
  ): Promise<OutilComplet | null> {
    const res = await this.pool.query<LigneAdmin>(
      `update agent_tools set
         autonome = $4,
         autonome_par = case when $4 then $5::uuid else null end,
         autonome_le = case when $4 then now() else null end,
         updated_at = now()
       where tenant_id = $1 and agent_id = $2 and id = $3
       returning ${COLONNES_ADMIN}`,
      [tenantId, agentId, outilId, autonome, parUtilisateur],
    );
    const r = res.rows[0];
    return r ? versComplet(r) : null;
  }

  async retirer(tenantId: string, agentId: string, outilId: string): Promise<boolean> {
    const res = await this.pool.query(
      'delete from agent_tools where tenant_id = $1 and agent_id = $2 and id = $3',
      [tenantId, agentId, outilId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

/** L'index unique `(agent_id, name)` de la migration 0086, traduit en erreur métier. Sans ça, deux outils du
 *  même nom remontaient en 500, dont Cloudflare remplace le corps : le client ne voyait rien. */
function surNomDejaPris(err: unknown): never {
  if ((err as { code?: string } | null)?.code === '23505') throw new NomOutilDejaPris();
  throw err;
}

// `ne_pas_utiliser` n'y est plus : elle est passée dans `COLONNES`, que le RUNTIME lit aussi.
const COLONNES_ADMIN = `${COLONNES}, title, actif, active_le, autonome_le`;

interface LigneAdmin extends Ligne {
  title: string;
  actif: boolean;
  active_le: Date | null;
  autonome_le: Date | null;
}

function versComplet(r: LigneAdmin): OutilComplet {
  return {
    ...versOutil(r),
    title: r.title,
    actif: r.actif,
    activeLe: r.active_le ? r.active_le.toISOString() : null,
    autonomeLe: r.autonome_le ? r.autonome_le.toISOString() : null,
  };
}

/** Journal des appels d'outils. Le contrat et ses raisons sont sur `JournalAppels` (`./catalog`). */
export class PgJournalAppels implements JournalAppels {
  constructor(private readonly pool: Pool) {}

  async ouvrir(input: {
    tenantId: string; sessionId: string; toolId: string | null; toolName: string; origin: string; argsRediges: unknown;
  }): Promise<string> {
    // `refuse` à l'ouverture : une ligne que rien ne vient clore (process tué en plein appel) reste ainsi
    // lisible comme « tentée, jamais aboutie » plutôt que de se faire passer pour un succès.
    const res = await this.pool.query<{ id: string }>(
      `insert into agent_tool_calls (tenant_id, session_id, tool_id, tool_name, origin, args_rediges, status)
       values ($1, $2, $3, $4, $5, $6::jsonb, 'refuse') returning id`,
      [input.tenantId, input.sessionId, input.toolId, input.toolName, input.origin, JSON.stringify(input.argsRediges ?? null)],
    );
    return res.rows[0]!.id;
  }

  async clore(input: {
    tenantId: string; id: string; status: string; httpStatus?: number; dureeMs: number; tailleReponse?: number; erreur?: string;
  }): Promise<void> {
    await this.pool.query(
      `update agent_tool_calls
          set status = $3, http_status = $4, duree_ms = $5, taille_reponse = $6, erreur = $7
        where tenant_id = $1 and id = $2`,
      [
        input.tenantId, input.id, input.status,
        input.httpStatus ?? null, input.dureeMs, input.tailleReponse ?? null, input.erreur ?? null,
      ],
    );
  }
}
