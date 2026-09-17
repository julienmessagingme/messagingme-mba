import type { Pool, PoolClient } from 'pg';
import type { RisqueOutil } from '../catalog';
import { paramsOutil, type SourceParam } from '../llm/tool-schema';
import type { OutilExistantMcp } from './import';
import type { EcritureImportMcp, OutilMcpVue, ServeurMcpVue } from '../../http/agent-mcp';

/**
 * Le stockage des outils importés d'un serveur MCP.
 *
 * 🔴 IL EST SÉPARÉ DE `catalog.pg.ts`, ET C'EST DÉLIBÉRÉ. Ce dernier sert le chemin CHAUD (les outils actifs
 * d'un agent, lus à chaque tour) et l'écran de réglage d'un agent. Ce module-ci ne sert qu'un import, geste
 * rare, déclenché par un administrateur. Les mêler ferait grossir la projection du chemin chaud de colonnes
 * que personne n'y lit.
 *
 * 🔴 L'ÉCRITURE EST UNE TRANSACTION, ET ELLE EST TOUT OU RIEN. Un import à moitié appliqué laisserait des
 * outils neufs à côté d'anciens qu'on vient de déclarer disparus, sans que le plan montré au client
 * corresponde à quoi que ce soit.
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

  /**
   * Les serveurs MCP de l'espace.
   *
   * ⚠️ `kind = 'mcp'` EST DANS LA REQUÊTE, pas dans un filtre d'écran. Cette liste alimente l'écran des
   * connecteurs MCP : y laisser entrer les connecteurs HTTP ferait proposer un import de catalogue à un
   * système qui n'en a pas.
   */
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

  /**
   * Les outils déjà importés de ce serveur, avec ce qu'un changement ferait tomber.
   *
   * 🔴 LE COMPTE DES CONSOMMATEURS ACTIFS EST LU ICI, dans la même requête. Le calculer ailleurs ferait
   * annoncer au client un nombre qui n'est pas celui que l'application va faire tomber.
   */
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
      // ⚠️ Le nom distant vit dans `binding`, pas dans une colonne : c'est ce qui APPARIE au
      // rafraîchissement, et une ligne qui n'en aurait pas ne s'apparierait avec rien. Le repli sur notre
      // nom local est le moins mauvais : il fera voir un « disparu » plutôt qu'un doublon silencieux.
      nomDistant: typeof r.binding?.outilDistant === 'string' ? r.binding.outilDistant : r.name,
      mcpAnnonce: r.mcp_annonce,
      mcpIndisponibleLe: r.mcp_indisponible_le,
      // 🔴 LU PAR LE CHEMIN OFFICIEL. `params` est du jsonb, donc opaque : `paramsOutil` est la SEULE
      // lecture autorisée, et c'est elle qui porte la séparation des sources.
      params: paramsOutil(r.params),
      consommateursActifs: Number(r.actifs),
    }));
  }

  /**
   * Les outils importés, TELS QUE L'ÉCRAN LES MONTRE.
   *
   * 🔴 SÉPARÉE DE `outilsDuServeur`, ET CE N'EST PAS UN DOUBLON. Celle-là ne lit que ce qu'on COMPARE au
   * rafraîchissement (le nom distant, l'annonce, ce qu'un changement fait tomber) : lui faire porter le
   * titre, les paramètres et le risque ferait grossir le chemin de l'import de colonnes qu'il n'utilise
   * pas, et surtout ferait croire que le planificateur s'en sert.
   *
   * ⚠️ `mcp_annonce` EST RENDUE AU CLIENT, et c'est voulu : c'est le schéma QUE LE SERVEUR ANNONCE, donc la
   * seule chose qu'il puisse montrer à son fournisseur quand un outil est refusé. Elle ne porte aucun
   * secret : elle vient d'en face.
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

  /**
   * Les noms d'outils DÉJÀ pris dans l'espace.
   *
   * 🔴 PAR ESPACE, PAS PAR SERVEUR NI PAR AGENT. L'unicité de `agent_tools.name` est par espace depuis
   * 0127 : ne regarder que les outils du serveur en cours ferait choisir un nom qu'un connecteur HTTP
   * occupe déjà, et l'import échouerait sur une contrainte de base, ce qui est illisible pour le client.
   */
  async nomsPris(tenantId: string): Promise<string[]> {
    const res = await this.pool.query<{ name: string }>(
      'select name from agent_tools where tenant_id = $1',
      [tenantId],
    );
    return res.rows.map((r) => r.name);
  }

  /** Applique un plan d'import. TOUT OU RIEN. */
  async appliquer(tenantId: string, sourceId: string, e: EcritureImportMcp): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

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
         * 🔴 LE CONSENTEMENT TOMBE, ET C'EST LA MOITIÉ QUI COMPTE. Un outil dont le schéma a changé n'est
         * plus l'outil qui a été autorisé : c'est la lecture stricte de 0127, où le consentement porte sur
         * un outil PRÉCIS, et la seule qui empêche un serveur distant d'élargir en silence ce qu'un outil
         * autorisé sait faire.
         *
         * ⚠️ `actif = false` SANS EFFACER `active_par` : la contrainte de 0086 n'exige un auteur que sur un
         * consentement ACTIF, et garder le nom de qui avait dit oui est ce qui rend l'incident instruisable.
         */
        await client.query(
          `update agent_tool_consommateurs
              set actif = false, autonome = false, updated_at = now()
            where tenant_id = $1 and tool_id = $2 and actif`,
          [tenantId, c.id],
        );
      }

      if (e.disparus.length > 0) {
        /**
         * ⚠️ MARQUÉS, JAMAIS SUPPRIMÉS. La ligne est la trace de ce qui a tourné, et le journal des appels
         * y renvoie. Un `delete` ferait disparaître l'outil ET son histoire, au moment précis où le client
         * se demande pourquoi son agent ne sait plus faire quelque chose.
         */
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

      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Le réglage d'un outil importé.
   *
   * ⚠️ `origin = 'mcp'` EST DANS LE `where`, et ce n'est pas une précaution de style : sans lui, cette
   * route réglerait aussi les paramètres d'un connecteur HTTP, dont les paramètres sont DÉRIVÉS des
   * variables de sa requête et seraient donc écrasés par une forme que personne n'a validée là-bas.
   */
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
     * 🔴 LES PARAMÈTRES SE FUSIONNENT SUR LE NOM, ILS NE SE REMPLACENT PAS EN BLOC. Le client règle la
     * SOURCE de chaque paramètre ; le type, la description et l'énumération viennent du serveur distant et
     * ne lui appartiennent pas. Accepter un tableau complet laisserait l'écran réécrire un type, donc
     * envoyer au serveur une valeur qu'il refuse, pour une raison invisible.
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
      // On retire les marqueurs de l'ancienne source avant de poser la nouvelle : un paramètre qui
      // garderait une `cle` en passant en `modele` porterait une intention morte, que le prochain lecteur
      // croirait vivante.
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
