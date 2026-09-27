import type { Pool, PoolClient } from 'pg';
import { enTransaction } from '../../db/transaction';
import type { RisqueOutil } from '../catalog';
import { verrouillerDefinitions } from '../catalog.pg';
import { paramsOutil, type SourceParam } from '../llm/tool-schema';
import type { OutilExistantMcp } from './import';
import type { EcritureImportMcp, OutilMcpVue, ServeurMcpVue } from '../../http/agent-mcp';

/**
 * Le stockage des outils importés d'un serveur MCP. À part de `catalog.pg.ts`, qui sert le chemin chaud (les
 * outils actifs lus à chaque tour) : l'import est un geste rare d'administrateur, ses colonnes n'ont rien à
 * faire dans cette projection. L'écriture d'un import est une transaction, tout ou rien.
 */

const COLS_SERVEUR = `s.id, s.label, s.base_url, s.auth_kind, s.auth_header_name, s.status,
                      s.last_ok_at, s.last_error`;

interface LigneServeur {
  id: string; label: string; base_url: string;
  auth_kind: 'none' | 'bearer' | 'header'; auth_header_name: string | null; status: string;
  last_ok_at: Date | null; last_error: string | null;
}

interface LigneOutil {
  id: string; name: string; binding: { outilDistant?: unknown } | null;
  params: unknown;
  mcp_annonce: unknown; mcp_indisponible_le: Date | null; actifs: string;
}

export class PgMcpStore {
  constructor(private readonly pool: Pool) {}

  /** Les serveurs MCP de l'espace. `kind = 'mcp'` est dans la requête : un connecteur HTTP n'a pas de
   *  catalogue à importer. */
  async listerServeurs(tenantId: string): Promise<ServeurMcpVue[]> {
    const res = await this.pool.query<LigneServeur>(
      `select ${COLS_SERVEUR} from agent_tool_sources s
        where s.tenant_id = $1 and s.kind = 'mcp'
        order by lower(s.label)`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      label: r.label,
      baseUrl: r.base_url,
      authKind: r.auth_kind,
      authHeaderName: r.auth_header_name,
      status: r.status,
      lastOkAt: r.last_ok_at ? r.last_ok_at.toISOString() : null,
      lastError: r.last_error,
    }));
  }

  /** Les outils déjà importés de ce serveur, avec le nombre de consommateurs actifs lu dans la même requête :
   *  c'est ce qu'un changement fera tomber. */
  async outilsDuServeur(tenantId: string, sourceId: string): Promise<OutilExistantMcp[]> {
    const res = await this.pool.query<LigneOutil>(
      `select t.id, t.name, t.binding, t.params, t.mcp_annonce, t.mcp_indisponible_le,
              (select count(*) from agent_tool_consommateurs c
                where c.tool_id = t.id and c.tenant_id = t.tenant_id and c.actif)::text as actifs
         from agent_tools t
        where t.tenant_id = $1 and t.source_id = $2 and t.origin = 'mcp'
        order by t.name`,
      [tenantId, sourceId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      // Le nom distant vit dans `binding` : c'est lui qui apparie au rafraîchissement. Le repli sur notre nom
      // local fera voir un « disparu » plutôt qu'un doublon silencieux.
      nomDistant: typeof r.binding?.outilDistant === 'string' ? r.binding.outilDistant : r.name,
      mcpAnnonce: r.mcp_annonce,
      mcpIndisponibleLe: r.mcp_indisponible_le,
      // `params` est du jsonb opaque : `paramsOutil` est la seule lecture autorisée (séparation des sources).
      params: paramsOutil(r.params),
      consommateursActifs: Number(r.actifs),
    }));
  }

  /**
   * Les outils importés, tels que l'écran les montre. À part de `outilsDuServeur`, qui ne lit que ce que le
   * rafraîchissement compare. `mcp_annonce` est rendue au client : c'est le schéma que le serveur annonce, ce
   * qu'il peut montrer à son fournisseur, sans aucun secret.
   */
  async outilsPourEcran(tenantId: string, sourceId: string): Promise<OutilMcpVue[]> {
    const res = await this.pool.query<{
      id: string; name: string; title: string; description: string; ne_pas_utiliser: string;
      params: unknown; binding: { outilDistant?: unknown } | null; risk: string;
      mcp_annonce: unknown; mcp_non_activable: string | null;
      mcp_indisponible_le: Date | null; actifs: string;
    }>(
      `select t.id, t.name, t.title, t.description, t.ne_pas_utiliser, t.params, t.binding, t.risk,
              t.mcp_annonce, t.mcp_non_activable, t.mcp_indisponible_le,
              (select count(*) from agent_tool_consommateurs c
                where c.tool_id = t.id and c.tenant_id = t.tenant_id and c.actif)::text as actifs
         from agent_tools t
        where t.tenant_id = $1 and t.source_id = $2 and t.origin = 'mcp'
        order by t.name`,
      [tenantId, sourceId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      nomDistant: typeof r.binding?.outilDistant === 'string' ? r.binding.outilDistant : r.name,
      title: r.title,
      description: r.description,
      nePasUtiliser: r.ne_pas_utiliser,
      params: Array.isArray(r.params) ? r.params as OutilMcpVue['params'] : [],
      risk: r.risk as OutilMcpVue['risk'],
      annonce: r.mcp_annonce,
      nonActivable: r.mcp_non_activable,
      indisponibleLe: r.mcp_indisponible_le ? r.mcp_indisponible_le.toISOString() : null,
      consommateursActifs: Number(r.actifs),
    }));
  }

  /** Les noms d'outils déjà pris dans l'espace, pas seulement chez ce serveur : un nom occupé par un
   *  connecteur HTTP ferait échouer l'import sur une contrainte de base. */
  async nomsPris(tenantId: string): Promise<string[]> {
    const res = await this.pool.query<{ name: string }>(
      'select name from agent_tools where tenant_id = $1',
      [tenantId],
    );
    return res.rows.map((r) => r.name);
  }

  /**
   * Les outils MCP qu'un rafraîchissement a débranchés chez ce consommateur, par leur nom. La marque est
   * `actif = false` avec `active_par` renseigné : quelqu'un avait dit oui et ce n'est plus vrai (un outil
   * jamais autorisé n'y figure pas). Restreint à `origin = 'mcp'` : un outil décoché n'est pas une panne.
   */
  async debranchesParRafraichissement(tenantId: string, consommateur: string): Promise<string[]> {
    const res = await this.pool.query<{ name: string }>(
      `select t.name
         from agent_tool_consommateurs c
         join agent_tools t on t.id = c.tool_id and t.tenant_id = c.tenant_id
        where c.tenant_id = $1 and c.consommateur = $2
          and c.actif = false and c.active_par is not null
          and t.origin = 'mcp'
        order by t.name`,
      [tenantId, consommateur],
    );
    return res.rows.map((r) => r.name);
  }

  /**
   * Supprimer un serveur MCP : trois issues, pas un booléen.
   *
   * 🔴 Refus tant qu'un outil est actif : la cascade (`agent_tools.source_id`, puis les consentements)
   * emporterait sans un mot tous les outils importés et leurs consentements. Et seulement du `kind = 'mcp'` :
   * sinon cette route supprimerait un connecteur API en contournant sa propre garde.
   *
   * La transaction rend l'écriture atomique mais ne ferme pas la course : en `READ COMMITTED`, une activation
   * concurrente peut commiter après le `count(*)`, et le `delete` l'emporterait. La fermer demanderait un
   * verrou de plus à chaque activation d'outil, pour deux gestes d'administrateur à la seconde près : résidu
   * assumé.
   */
  async supprimerServeur(tenantId: string, id: string): Promise<'supprime' | 'introuvable' | 'outils_actifs'> {
    return enTransaction(this.pool, async (client) => {
      const existe = await client.query(
        "select 1 from agent_tool_sources where tenant_id = $1 and id = $2 and kind = 'mcp'",
        [tenantId, id],
      );
      if (existe.rowCount === 0) return 'introuvable';

      const actifs = await client.query<{ n: string }>(
        `select count(*)::text as n
           from agent_tool_consommateurs c
           join agent_tools t on t.id = c.tool_id and t.tenant_id = c.tenant_id
          where c.tenant_id = $1 and t.source_id = $2 and t.origin = 'mcp' and c.actif`,
        [tenantId, id],
      );
      if (Number(actifs.rows[0]!.n) > 0) return 'outils_actifs';

      // Ses outils sont verrouillés par identifiant avant la cascade, l'ordre de `PgAgentStore.remove` : sinon
      // la cascade les prendrait dans l'ordre du parcours de table et interbloquerait avec une suppression d'agent.
      await client.query(
        'select 1 from agent_tools where tenant_id = $1 and source_id = $2 order by id for update',
        [tenantId, id],
      );
      await client.query(
        "delete from agent_tool_sources where tenant_id = $1 and id = $2 and kind = 'mcp'",
        [tenantId, id],
      );
      return 'supprime';
    });
  }

  /** Applique un plan d'import, tout ou rien. */
  async appliquer(tenantId: string, sourceId: string, e: EcritureImportMcp): Promise<void> {
    await enTransaction(this.pool, async (client) => {

      /**
       * Les définitions existantes que cet import va écrire sont verrouillées d'abord, d'un bloc et par
       * identifiant (`verrouillerDefinitions`, l'ordre de `PgAgentStore.remove`), avant même les insertions,
       * qui prennent le serveur par leur clé étrangère : l'ordre inverse de `supprimerServeur` interbloquerait.
       * Verrou exclusif : pendant l'import, un appel journalisé ou un rattachement sur ces outils attend.
       */
      await verrouillerDefinitions(client, tenantId, [...e.changes.map((c) => c.id), ...e.disparus, ...e.vus]);

      for (const o of e.nouveaux) {
        await client.query(
          `insert into agent_tools
             (tenant_id, origin, source_id, source_kind, name, title, description, ne_pas_utiliser,
              params, binding, output_paths, nature, risk,
              mcp_annonce, mcp_non_activable, mcp_vu_le)
           select $1, 'mcp', $2, 'mcp', $3, $4, $5, $6, $7::jsonb, $8::jsonb, '{}'::text[], 'integre', $9,
                  $10::jsonb, $11, now()
            where exists (select 1 from agent_tool_sources
                           where id = $2 and tenant_id = $1 and kind = 'mcp')`,
          [
            tenantId, sourceId, o.name, o.title, o.description, o.nePasUtiliser,
            JSON.stringify(o.params), JSON.stringify({ outilDistant: o.nomDistant }),
            o.risk, JSON.stringify(o.annonce), o.nonActivable,
          ],
        );
      }

      for (const c of e.changes) {
        await client.query(
          `update agent_tools
              set title = $3, description = $4, params = $5::jsonb,
                  mcp_annonce = $6::jsonb, mcp_non_activable = $7,
                  mcp_indisponible_le = null, mcp_vu_le = now(), updated_at = now()
            where tenant_id = $1 and id = $2 and origin = 'mcp'`,
          [
            tenantId, c.id, c.outil.title, c.outil.description,
            JSON.stringify(c.outil.params), JSON.stringify(c.outil.annonce), c.outil.nonActivable,
          ],
        );
        /**
         * 🔴 Le consentement tombe : un outil dont le schéma a changé n'est plus celui qui a été autorisé, et un
         * serveur distant ne doit pas élargir en silence ce qu'un outil autorisé sait faire. `actif = false` sans
         * effacer `active_par` : garder qui avait dit oui rend l'incident instruisable.
         */
        await client.query(
          `update agent_tool_consommateurs
              set actif = false, autonome = false, updated_at = now()
            where tenant_id = $1 and tool_id = $2 and actif`,
          [tenantId, c.id],
        );
      }

      if (e.disparus.length > 0) {
        /** Marqués, jamais supprimés : la ligne trace ce qui a tourné, et le journal des appels y renvoie. */
        await client.query(
          `update agent_tools set mcp_indisponible_le = now(), updated_at = now()
            where tenant_id = $1 and id = any($2::uuid[]) and mcp_indisponible_le is null`,
          [tenantId, e.disparus],
        );
        await client.query(
          `update agent_tool_consommateurs set actif = false, autonome = false, updated_at = now()
            where tenant_id = $1 and tool_id = any($2::uuid[]) and actif`,
          [tenantId, e.disparus],
        );
      }

      if (e.vus.length > 0) {
        await client.query(
          'update agent_tools set mcp_vu_le = now() where tenant_id = $1 and id = any($2::uuid[])',
          [tenantId, e.vus],
        );
      }

    });
  }

  /** Le réglage d'un outil importé. `origin = 'mcp'` dans le `where` : les paramètres d'un connecteur HTTP
   *  dérivent de sa requête, et seraient écrasés par une forme que personne n'a validée. */
  async reglerOutil(tenantId: string, outilId: string, patch: {
    params?: Array<{ name: string; source: SourceParam; cle?: string; contactPath?: string; value?: string | number | boolean }>;
    risk?: RisqueOutil;
    nePasUtiliser?: string;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      return await this.reglerAvecClient(client, tenantId, outilId, patch);
    } finally {
      client.release();
    }
  }

  private async reglerAvecClient(
    client: PoolClient,
    tenantId: string,
    outilId: string,
    patch: Parameters<PgMcpStore['reglerOutil']>[2],
  ): Promise<boolean> {
    /**
     * Les paramètres se fusionnent sur le nom, sans remplacement en bloc : le client règle la source de chaque
     * paramètre, le type, la description et l'énumération viennent du serveur distant.
     */
    const lu = await client.query<{ params: unknown }>(
      `select params from agent_tools where tenant_id = $1 and id = $2 and origin = 'mcp'`,
      [tenantId, outilId],
    );
    if (lu.rowCount === 0) return false;

    const avant = Array.isArray(lu.rows[0]!.params) ? lu.rows[0]!.params as Array<Record<string, unknown>> : [];
    const reglages = new Map((patch.params ?? []).map((p) => [p.name, p]));
    const apres = avant.map((p) => {
      const r = reglages.get(String(p.name));
      if (!r) return p;
      // On retire les marqueurs de l'ancienne source avant de poser la nouvelle : une `cle` restée sur un
      // paramètre passé en `modele` porterait une intention morte.
      const { cle: _cle, contactPath: _cp, value: _v, ...reste } = p;
      return {
        ...reste,
        source: r.source,
        ...(r.source === 'champ' && r.cle ? { cle: r.cle } : {}),
        ...(r.source === 'contact' && r.contactPath ? { contactPath: r.contactPath } : {}),
        ...(r.source === 'fixe' && r.value !== undefined ? { value: r.value } : {}),
      };
    });

    const res = await client.query(
      `update agent_tools
          set params = $3::jsonb,
              risk = coalesce($4, risk),
              ne_pas_utiliser = coalesce($5, ne_pas_utiliser),
              updated_at = now()
        where tenant_id = $1 and id = $2 and origin = 'mcp'`,
      [tenantId, outilId, JSON.stringify(apres), patch.risk ?? null, patch.nePasUtiliser ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
