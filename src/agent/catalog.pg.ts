import type { Pool, PoolClient } from 'pg';
import type {
  JournalAppels, NatureOutil, OutilBibliotheque, OutilComplet, OutilDefini, PatchOutil, RisqueOutil,
  ToolCatalog,
  SourceAppel,
} from './catalog';
import { OutilNonActivable, NomOutilDejaPris } from './catalog';
import { lireGestes } from './gestes';
import { asRecord } from '../webhooks/json';
import { agentDuConsommateur, consommateurAgent, consommateurMba } from './consommateur';
import { RISQUE_MAISON, type CibleMaison } from '../mba/outils-maison';
import { enTransaction } from '../db/transaction';

interface Ligne {
  /** jsonb opaque, relu par `lireGestes` : un contenu corrompu rend un tableau vide. */
  gestes: unknown;
  id: string;
  tenant_id: string;
  origin: OutilDefini['origin'];
  name: string;
  description: string;
  ne_pas_utiliser: string;
  params: unknown;
  binding: unknown;
  source_id: string | null;
  request_id: string | null;
  output_paths: string[] | null;
  nature: string | null;
  risk: OutilDefini['risk'];
  mcp_annonce: unknown;
  mcp_non_activable: string | null;
  mcp_indisponible_le: Date | null;
  mcp_vu_le: Date | null;
  timeout_ms: number;
  max_bytes: number;
  autonome: boolean;
}

/**
 * La jointure, écrite une fois. `c.tenant_id = t.tenant_id` est dans la jointure en plus du `where` : le
 * second suffit à l'isolation entre clients, le premier empêche une ligne de liaison mal écrite de
 * rattacher un outil qui n'est pas le sien.
 */
const JOINTURE = `from agent_tools t
                  join agent_tool_consommateurs c on c.tool_id = t.id and c.tenant_id = t.tenant_id`;

/**
 * Colonnes lues par toutes les requêtes : une seule projection, pour que l'exécution voie le même outil que
 * les autres chemins. 🔴 `autonome` vient de `c`, la liaison : c'est un consentement, par consommateur.
 */
const COLONNES = `t.id, t.tenant_id, t.origin, t.name, t.description, t.ne_pas_utiliser, t.params,
                  t.binding, t.source_id, t.request_id, t.output_paths, t.nature, t.risk, t.timeout_ms, t.max_bytes,
                  t.mcp_annonce, t.mcp_non_activable, t.mcp_indisponible_le, t.mcp_vu_le,
                  t.gestes,
                  c.autonome`;

function versOutil(r: Ligne): OutilDefini {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    origin: r.origin,
    name: r.name,
    description: r.description,
    // Lue par le runtime : le modèle la voit (voir `OutilDefini.nePasUtiliser`).
    nePasUtiliser: r.ne_pas_utiliser,
    // `safeParse` et repli vide : un jsonb corrompu ne produit aucun geste, sans rendre l'agent muet.
    gestes: lireGestes(r.gestes),
    params: r.params,
    // `binding` est du jsonb opaque : un scalaire ou un null donne un objet vide, et le résolveur refuse.
    binding: asRecord(r.binding),
    // La source vit sur la ligne, pas dans `binding` : clé étrangère, obligatoire dès que l'origine n'est pas
    // `mba` (`agent_tools_origin_src_chk`).
    sourceId: r.source_id,
    // La requête que l'outil déclenche, sur la ligne pour la même raison : une clé étrangère garantit qu'elle
    // désigne quelque chose.
    requestId: r.request_id,
    outputPaths: r.output_paths ?? [],
    // `?? 'integre'` plutôt qu'un `as` : le défaut de la colonne la donne, le repli sert aux faux de test.
    nature: r.nature === 'pousse' ? 'pousse' : 'integre',
    risk: r.risk,
    timeoutMs: r.timeout_ms,
    maxBytes: r.max_bytes,
    autonome: r.autonome,
    // `null` et pas `undefined`, pour les quatre : un champ absent et un champ vide se lisent pareil à l'œil,
    // pas dans le code.
    mcpAnnonce: r.mcp_annonce ?? null,
    mcpNonActivable: r.mcp_non_activable,
    mcpIndisponibleLe: r.mcp_indisponible_le,
    mcpVuLe: r.mcp_vu_le,
  };
}

/**
 * Un consentement d'agent verrouille son agent, dans une instruction à part, avant de toucher à l'outil
 * (l'ordre de `PgAgentStore.remove` : l'agent, puis l'outil). Sans ça, le consentement survivrait à un agent
 * en cours de suppression (un consommateur fantôme qui empêche d'effacer le connecteur), ou inverserait
 * l'ordre des verrous. Instruction à part : l'ordre de deux `exists` d'un même `where` n'est pas garanti.
 * Rend `false` quand l'agent n'existe plus, ou pour une clé `agent:` malformée (sinon le CHECK la refuserait
 * en 500). Un consommateur qui n'est pas un agent (`mba:`) passe.
 */
async function verrouillerAgentDuConsommateur(client: PoolClient, tenantId: string, consommateur: string): Promise<boolean> {
  const agentId = agentDuConsommateur(consommateur);
  if (agentId === null) return !consommateur.startsWith('agent:');
  const r = await client.query('select 1 from agents where tenant_id = $1 and id = $2 for key share', [tenantId, agentId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Verrouiller les définitions avant le `not exists` qui décide de les effacer (une action ou un connecteur
 * HTTP que plus personne n'utilise part) : sans ce verrou, un rattachement concurrent, invisible du
 * `not exists`, partirait dans la cascade. Avec lui, l'un attend l'autre.
 *
 * Tous les chemins des consentements et du journal suivent le même ordre : l'agent, ses sessions, les
 * définitions (triées par identifiant, `order by id`), puis ce qui en dépend. Sinon deux chemins
 * s'attendent (40P01) : voir `PgAgentStore.remove`.
 */
export async function verrouillerDefinitions(client: PoolClient, tenantId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    'select 1 from agent_tools where tenant_id = $1 and id = any($2::uuid[]) order by id for update',
    [tenantId, ids],
  );
}

/**
 * Lecture et écriture du catalogue d'outils.
 *
 * 🔴 `t.tenant_id = $1 and c.consommateur = $2` et `and actif` dans chaque requête d'exécution : le nom
 * d'outil vient du modèle, et c'est ce `where` qui empêche d'appeler l'outil d'un autre agent ou d'un autre
 * client. C'est la liaison qui isole, pas `agent_id` (qui dit à qui appartient une définition) : filtrer sur
 * `agent_id` laisserait passer un connecteur partagé jamais rattaché à cet agent.
 *
 * L'activation porte le nom de qui l'a faite, tiré du jeton, jamais du corps : la spec MCP exige un
 * consentement humain avant l'invocation, déplacé ici du runtime vers la configuration (la base refuse
 * `actif` sans `active_par`). Même chose pour l'autonomie.
 */
export class PgToolCatalog implements ToolCatalog {
  constructor(private readonly pool: Pool) {}

  async byName(tenantId: string, agentId: string, name: string): Promise<OutilDefini | null> {
    const res = await this.pool.query<Ligne>(
      `select ${COLONNES} ${JOINTURE}
        where t.tenant_id = $1 and c.consommateur = $2 and t.name = $3 and c.actif`,
      [tenantId, consommateurAgent(agentId), name],
    );
    const r = res.rows[0];
    return r ? versOutil(r) : null;
  }

  async listActifs(tenantId: string, agentId: string): Promise<OutilDefini[]> {
    return this.listActifsConsommateur(tenantId, consommateurAgent(agentId));
  }

  async listActifsConsommateur(tenantId: string, consommateur: string): Promise<OutilDefini[]> {
    const res = await this.pool.query<Ligne>(
      `select ${COLONNES} ${JOINTURE}
        where t.tenant_id = $1 and c.consommateur = $2 and c.actif
        order by t.name`,
      [tenantId, consommateur],
    );
    return res.rows.map(versOutil);
  }

  // ---------- Écriture : l'écran de réglage ----------

  /**
   * Tous les outils d'un agent, actifs ou non. Jointure interne : l'onglet montre ce que cet agent utilise ;
   * un `left join` y ferait apparaître les outils de tous les autres.
   */
  async listToutes(tenantId: string, agentId: string): Promise<OutilComplet[]> {
    return this.listToutesConsommateur(tenantId, consommateurAgent(agentId));
  }

  /** Tous les outils d'un consommateur, actifs ou non, avec leurs champs d'écran : l'onglet d'un agent IA
   *  (`listToutes`) et celui de l'agent de Meta (`mba:<numéro>`). */
  async listToutesConsommateur(tenantId: string, consommateur: string): Promise<OutilComplet[]> {
    const res = await this.pool.query<LigneAdmin>(
      `select ${COLONNES_ADMIN} ${JOINTURE}
        where t.tenant_id = $1 and c.consommateur = $2 order by t.name`,
      [tenantId, consommateur],
    );
    return res.rows.map(versComplet);
  }

  /** Ajoute un outil maison à un agent, inactif. Rend `null` si l'agent n'existe pas ou appartient à un
   *  autre tenant. Lève `NomOutilDejaPris` si le nom exposé est déjà porté par un outil de cet agent. */
  async ajouter(tenantId: string, agentId: string, outil: {
    handler: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: RisqueOutil;
  }): Promise<OutilComplet | null> {
    // `actif` reste faux par défaut : un outil actif d'emblée serait exposé au modèle avant qu'on relise ses
    // mots. Deux écritures, donc une transaction : une définition sans rattachement n'apparaîtrait nulle part.
    return enTransaction(this.pool, async (client) => {
      const res = await client.query<{ id: string }>(
        /** `agent_id` renseigné : une action appartient à son agent (un connecteur, à l'espace), et son nom n'est
         *  unique que par agent. */
        `insert into agent_tools
           (tenant_id, agent_id, origin, name, title, description, ne_pas_utiliser, params, binding, risk)
         select $1, $9, 'mba', $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8
          where exists (select 1 from agents where id = $9 and tenant_id = $1)
         returning id`,
        [
          tenantId, outil.name, outil.title, outil.description, outil.nePasUtiliser,
          JSON.stringify(outil.params ?? []),
          // `binding.handler` donne son comportement à l'outil, jamais le nom exposé, que le client peut changer.
          JSON.stringify({ handler: outil.handler }),
          outil.risk, agentId,
        ],
      ).catch(surNomDejaPris);
      const id = res.rows[0]?.id;
      if (!id) return null;
      await client.query(
        'insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur) values ($1, $2, $3)',
        [tenantId, id, consommateurAgent(agentId)],
      );
      return this.completAvecClient(client, tenantId, consommateurAgent(agentId), id);
    });
  }

  /**
   * Un outil de connecteur, pour un agent. La source est vérifiée par le `where exists` : une source d'un autre
   * tenant ne produit aucune ligne (404) plutôt qu'une violation de clé étrangère (500).
   */
  async ajouterConnecteur(tenantId: string, agentId: string, outil: {
    sourceId: string; requestId: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: RisqueOutil;
    /** Obligatoires tous les deux : optionnels, un appelant retomberait sur `integre` avec une liste vide, donc
     *  un outil qui refuse chaque appel. */
    nature: NatureOutil; outputPaths: readonly string[];
  }): Promise<OutilComplet | null> {
    return this.creerOutilConnecteur(tenantId, consommateurAgent(agentId), outil);
  }

  /** Le geste commun à un agent IA et au Meta Business Agent : un seul `insert`, pour que les gardes
   *  d'isolation ne divergent pas. */
  private async creerOutilConnecteur(tenantId: string, consommateur: string, outil: {
    sourceId: string; requestId: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: RisqueOutil; nature: NatureOutil; outputPaths: readonly string[];
  }): Promise<OutilComplet | null> {
    return enTransaction(this.pool, async (client) => {
      if (!(await verrouillerAgentDuConsommateur(client, tenantId, consommateur))) return null;
      const res = await client.query<{ id: string }>(
        /**
         * `binding` reste vide : la requête porte l'appel. `output_paths` est rempli : ce qu'un agent lit est une
         * propriété de son outil (la requête garde sa liste comme défaut). Les trois `exists` sont la garde
         * d'isolation (agent, source et requête de ce tenant). `source_kind` est écrit et la source contrainte à
         * `kind = 'http'` : un outil HTTP ne se branche pas sur un serveur MCP. Un refus rend zéro ligne, donc le
         * `null` de l'appelant, pas un 500.
         */
        `insert into agent_tools
           (tenant_id, origin, source_id, source_kind, request_id, name, title, description, ne_pas_utiliser, params, binding, output_paths, nature, risk)
         select $1, 'http', $2, 'http', $3, $4, $5, $6, $7, $8::jsonb, '{}'::jsonb, $9::text[], $10, $11
          where ($12::uuid is null or exists (select 1 from agents where id = $12 and tenant_id = $1))
            and exists (select 1 from agent_tool_sources where id = $2 and tenant_id = $1 and kind = 'http')
            and exists (select 1 from connector_requests where id = $3 and tenant_id = $1)
         returning id`,
        [
          tenantId, outil.sourceId, outil.requestId,
          outil.name, outil.title, outil.description, outil.nePasUtiliser,
          JSON.stringify(outil.params ?? []),
          // Un `pousse` force la liste à vide plutôt que de faire confiance à l'appelant.
          outil.nature === 'pousse' ? [] : [...outil.outputPaths],
          outil.nature,
          outil.risk, agentDuConsommateur(consommateur),
        ],
      ).catch(surNomDejaPris);
      const id = res.rows[0]?.id;
      if (!id) return null;
      await client.query(
        'insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur) values ($1, $2, $3)',
        [tenantId, id, consommateur],
      );
      return this.completAvecClient(client, tenantId, consommateur, id);
    });
  }

  /**
   * Le même geste pour le Meta Business Agent, consommateur qui n'est pas un agent (`mba:<numero>`) : exposer
   * un appel à Meta ne doit pas obliger à créer un agent IA. Un connecteur laisse `agent_id` à `null` (CHECK
   * `agent_tools_agent_origin_chk`). `nature` vaut `integre` : Meta lit toute la réponse quoi qu'on déclare.
   */
  async ajouterConnecteurPourMba(tenantId: string, phoneNumberId: string, outil: {
    sourceId: string; requestId: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: RisqueOutil;
  }): Promise<OutilComplet | null> {
    return this.creerOutilConnecteur(tenantId, consommateurMba(phoneNumberId), {
      ...outil, nature: 'integre', outputPaths: [],
    });
  }

  /**
   * Un outil maison de l'agent de Meta, créé exposé et actif au nom de l'administrateur, dans la même
   * transaction : il n'a pas d'autre consommateur possible, et `atc_actif_humain_chk` exige un activateur
   * humain. `params` reste vide : ce que Meta envoie se dérive de la cible (`variablesPourMeta`).
   */
  async ajouterMaisonPourMba(tenantId: string, phoneNumberId: string, outil: {
    name: string; title: string; description: string; nePasUtiliser: string; cible: CibleMaison;
  }, parUtilisateur: string): Promise<OutilComplet | null> {
    const consommateur = consommateurMba(phoneNumberId);
    return enTransaction(this.pool, async (client) => {
      const res = await client.query<{ id: string }>(
        `insert into agent_tools
           (tenant_id, origin, name, title, description, ne_pas_utiliser, params, binding, risk, pour_agent_meta)
         values ($1, 'mba', $2, $3, $4, $5, '[]'::jsonb, $6::jsonb, $7, true)
         returning id`,
        [tenantId, outil.name, outil.title, outil.description, outil.nePasUtiliser,
          JSON.stringify(outil.cible), RISQUE_MAISON[outil.cible.handler]],
      ).catch(surNomDejaPris);
      const id = res.rows[0]?.id;
      if (!id) return null;
      await client.query(
        `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, actif, active_par, active_le)
         values ($1, $2, $3, true, $4, now())`,
        [tenantId, id, consommateur, parUtilisateur],
      );
      return this.completAvecClient(client, tenantId, consommateur, id);
    });
  }

  /** Corrige les mots ou la cible d'un outil maison de l'agent de Meta. `null` = pas un outil de cet agent.
   *  Le risque suit la cible, jamais le corps de la requête. */
  async patchMaisonPourMba(tenantId: string, phoneNumberId: string, outilId: string, patch: {
    name?: string; title?: string; description?: string; nePasUtiliser?: string; cible?: CibleMaison;
  }): Promise<OutilComplet | null> {
    const consommateur = consommateurMba(phoneNumberId);
    const res = await this.pool.query<{ id: string }>(
      `update agent_tools set
          name = coalesce($4, name), title = coalesce($5, title), description = coalesce($6, description),
          ne_pas_utiliser = coalesce($7, ne_pas_utiliser),
          binding = coalesce($8::jsonb, binding), risk = coalesce($9, risk),
          updated_at = now()
        where agent_tools.tenant_id = $1 and agent_tools.id = $3 and agent_tools.pour_agent_meta
          and exists (select 1 from agent_tool_consommateurs c
                       where c.tool_id = agent_tools.id and c.tenant_id = agent_tools.tenant_id
                         and c.consommateur = $2)
        returning id`,
      [tenantId, consommateur, outilId, patch.name ?? null, patch.title ?? null, patch.description ?? null,
        patch.nePasUtiliser ?? null, patch.cible ? JSON.stringify(patch.cible) : null,
        patch.cible ? RISQUE_MAISON[patch.cible.handler] : null],
    ).catch(surNomDejaPris);
    if (!res.rows[0]) return null;
    return this.complet(tenantId, consommateur, outilId);
  }

  /**
   * « Supprimer » depuis l'onglet de l'agent de Meta. L'outil n'est retiré qu'à l'agent de Meta : un
   * connecteur encore utilisé par un agent IA reste (`detache`) ; un outil sans plus aucun consommateur part
   * (`supprime`), même règle que `detacher`. `agent_id is null` épargne une action d'agent IA, `origin <>
   * 'mcp'` un outil MCP importé, qui doit rester branchable.
   */
  async retirerDeMba(tenantId: string, phoneNumberId: string, outilId: string): Promise<'supprime' | 'detache' | 'introuvable'> {
    const consommateur = consommateurMba(phoneNumberId);
    return enTransaction(this.pool, async (client) => {
      await verrouillerDefinitions(client, tenantId, [outilId]);
      const det = await client.query(
        'delete from agent_tool_consommateurs where tenant_id = $1 and consommateur = $2 and tool_id = $3',
        [tenantId, consommateur, outilId],
      );
      if ((det.rowCount ?? 0) === 0) return 'introuvable';
      const sup = await client.query(
        `delete from agent_tools t
          where t.tenant_id = $1 and t.id = $2 and t.agent_id is null and t.origin <> 'mcp'
            and not exists (select 1 from agent_tool_consommateurs c where c.tool_id = t.id and c.tenant_id = t.tenant_id)`,
        [tenantId, outilId],
      );
      return (sup.rowCount ?? 0) > 0 ? 'supprime' : 'detache';
    });
  }

  /** Corrige les mots d'un outil. Rend `null` s'il n'est pas de ce couple (tenant, agent). */
  async patch(tenantId: string, agentId: string, outilId: string, patch: PatchOutil): Promise<OutilComplet | null> {
    return this.patchConsommateur(tenantId, consommateurAgent(agentId), outilId, patch);
  }

  /** Le même geste pour un consommateur qui n'est pas un agent (le MBA), dont les outils n'ont pas d'agent. */
  async patchConsommateur(
    tenantId: string, consommateur: string, outilId: string, patch: PatchOutil,
  ): Promise<OutilComplet | null> {
    // Les énumérations sont réécrites dans le jsonb, en une instruction : une lecture suivie d'une écriture
    // laisserait deux administrateurs se recouvrir en silence.
    const res = await this.pool.query<{ id: string }>(
      // Pas d'alias ni de `returning ${COLONNES_ADMIN}` : ses préfixes `t.` et `c.` n'existent pas dans un
      // UPDATE. L'`exists` sur la liaison borne le périmètre : sans lui, l'écran d'un agent corrigerait les
      // mots d'un outil qu'il n'utilise pas, donc le comportement de l'agent du voisin.
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
             from jsonb_array_elements(agent_tools.params) with ordinality as x(p, ord)
         ) end,
         -- Les GESTES (0158). Un coalesce sur un jsonb ABSENT, jamais sur un tableau VIDE : un tableau
         -- vide est un CHOIX du client (il a retire tous ses gestes) et doit s ecrire, quand null veut
         -- dire que ce patch ne parle pas des gestes. Les confondre rendrait un geste ineffacable.
         gestes = coalesce($9::jsonb, gestes),
         updated_at = now()
       where agent_tools.tenant_id = $1 and agent_tools.id = $3
         and exists (select 1 from agent_tool_consommateurs c
                      where c.tool_id = agent_tools.id and c.tenant_id = agent_tools.tenant_id
                        and c.consommateur = $2)
       returning id`,
      [tenantId, consommateur, outilId, patch.name ?? null, patch.title ?? null,
        patch.description ?? null, patch.nePasUtiliser ?? null,
        patch.enums ? JSON.stringify(patch.enums) : null,
        patch.gestes ? JSON.stringify(patch.gestes) : null],
    ).catch(surNomDejaPris);
    const r = res.rows[0];
    return r ? this.complet(tenantId, consommateur, r.id) : null;
  }

  /** Active ou désactive. `parUtilisateur` vient du jeton. Rend `null` si l'outil n'est pas de ce couple. */
  async activer(
    tenantId: string, agentId: string, outilId: string, actif: boolean, parUtilisateur: string,
  ): Promise<OutilComplet | null> {
    return this.activerConsommateur(tenantId, consommateurAgent(agentId), outilId, actif, parUtilisateur);
  }

  /**
   * Active ou désactive pour un consommateur qui n'est pas un agent. `update`, jamais `insert ... on
   * conflict` : activer n'est pas un rattachement implicite, un identifiant erroné rend `null`. Désactiver
   * efface l'activateur : ces colonnes disent qui l'a mis en service, pas qui y a touché un jour.
   */
  async activerConsommateur(
    tenantId: string, consommateur: string, outilId: string, actif: boolean, parUtilisateur: string,
  ): Promise<OutilComplet | null> {
    /**
     * La garde est ici, au point de passage unique de l'activation (onglet d'un agent et outils de l'agent de
     * Meta). Seulement à l'activation : désactiver un outil devenu non activable reste le seul geste du client.
     */
    if (actif) {
      const etat = await this.pool.query<{ mcp_non_activable: string | null; mcp_indisponible_le: Date | null }>(
        'select mcp_non_activable, mcp_indisponible_le from agent_tools where tenant_id = $1 and id = $2',
        [tenantId, outilId],
      );
      const l = etat.rows[0];
      if (l?.mcp_non_activable) throw new OutilNonActivable(l.mcp_non_activable);
      if (l?.mcp_indisponible_le) {
        throw new OutilNonActivable('cet outil a disparu du serveur MCP : il n’est plus appelable');
      }
    }
    const res = await this.pool.query(
      `update agent_tool_consommateurs set
         actif = $4,
         active_par = case when $4 then $5::uuid else null end,
         active_le = case when $4 then now() else null end,
         updated_at = now()
       where tenant_id = $1 and consommateur = $2 and tool_id = $3`,
      [tenantId, consommateur, outilId, actif, parUtilisateur],
    );
    if ((res.rowCount ?? 0) === 0) return null;
    return this.complet(tenantId, consommateur, outilId);
  }

  /** Coche ou décoche l'autonomie sur une action irréversible. `parUtilisateur` vient du jeton. */
  async autonomie(
    tenantId: string, agentId: string, outilId: string, autonome: boolean, parUtilisateur: string,
  ): Promise<OutilComplet | null> {
    const consommateur = consommateurAgent(agentId);
    const res = await this.pool.query(
      `update agent_tool_consommateurs set
         autonome = $4,
         autonome_par = case when $4 then $5::uuid else null end,
         autonome_le = case when $4 then now() else null end,
         updated_at = now()
       where tenant_id = $1 and consommateur = $2 and tool_id = $3`,
      [tenantId, consommateur, outilId, autonome, parUtilisateur],
    );
    if ((res.rowCount ?? 0) === 0) return null;
    return this.complet(tenantId, consommateur, outilId);
  }

  /**
   * Rend cet outil de l'espace disponible pour cet agent, inactif : rattacher et activer sont deux gestes,
   * sinon ajouter un outil l'exposerait au modèle sans que personne ait relu ses mots. `false` = outil absent
   * de cet espace, déjà rattaché, réservé à l'agent de Meta, ou effacé à l'instant.
   */
  async rattacher(tenantId: string, agentId: string, outilId: string): Promise<boolean> {
    return this.rattacherConsommateur(tenantId, consommateurAgent(agentId), outilId);
  }

  /** Même geste, pour un consommateur qui n'est pas un agent (le MBA). Le `where exists` vérifie que l'outil
   *  est de ce tenant (404 plutôt que 500) ; `do nothing` rend un rattachement répété inoffensif. */
  async rattacherConsommateur(tenantId: string, consommateur: string, outilId: string): Promise<boolean> {
    // Un outil de l'agent de Meta ne s'ouvre jamais à un agent IA : son handler n'existe pas chez eux.
    // `for key share` : si un dernier détachement tient la définition, on l'attend, puis on rend `false` au lieu
    // d'un 500 sur la clé étrangère. L'agent d'abord (`verrouillerAgentDuConsommateur`) : jamais de
    // consentement fantôme.
    return enTransaction(this.pool, async (client) => {
      if (!(await verrouillerAgentDuConsommateur(client, tenantId, consommateur))) return false;
      const res = await client.query(
        `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur)
         select $1, $2, $3
          where exists (select 1 from agent_tools
                         where id = $2 and tenant_id = $1 and (not pour_agent_meta or $3::text like 'mba:%')
                           -- Un outil MCP décoché sur Tools > Connecteurs MCP ne s'offre à aucun agent (0199). Le
                           -- verrou attend un « proposer » concurrent, et la condition est relue après lui.
                           and (origin <> 'mcp' or mcp_propose)
                           for key share)
         on conflict (tool_id, consommateur) do nothing`,
        [tenantId, outilId, consommateur],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  /**
   * Retire l'outil de cet agent. 🔴 Une action ou un connecteur HTTP qui perd son dernier consommateur part
   * avec lui : sinon la définition resterait sans écran pour la supprimer, son nom pris, et la suppression de
   * sa requête bloquée. Un outil MCP reste, branchable depuis la bibliothèque. La condition qui compte est
   * l'absence de consommateur restant (sinon la cascade emporterait un consentement d'un autre), et
   * `agent_id = $3` borne l'effacement d'une action à son agent. Deux écritures, une transaction.
   */
  async detacher(tenantId: string, agentId: string, outilId: string): Promise<boolean> {
    return enTransaction(this.pool, async (client) => {
      await verrouillerDefinitions(client, tenantId, [outilId]);
      const res = await client.query(
        'delete from agent_tool_consommateurs where tenant_id = $1 and consommateur = $2 and tool_id = $3',
        [tenantId, consommateurAgent(agentId), outilId],
      );
      if ((res.rowCount ?? 0) === 0) return false;
      await client.query(
        `delete from agent_tools t
          where t.tenant_id = $1 and t.id = $2
            and (t.agent_id = $3 or (t.agent_id is null and t.origin = 'http'))
            and not exists (select 1 from agent_tool_consommateurs c
                             where c.tool_id = t.id and c.tenant_id = t.tenant_id)`,
        [tenantId, outilId, agentId],
      );
      return true;
    });
  }

  /**
   * La bibliothèque de l'espace : les définitions qu'un agent IA peut brancher (connecteurs et outils MCP),
   * avec qui s'en sert. Ni les actions d'un agent, qui lui appartiennent, ni les outils de l'agent de Meta.
   * Une seule requête, consommateurs agrégés en jsonb. `left join` : un outil MCP importé que personne n'a
   * branché doit apparaître, c'est celui qu'on vient chercher.
   */
  async listCatalogue(tenantId: string): Promise<OutilBibliotheque[]> {
    const res = await this.pool.query<{
      id: string; name: string; title: string; description: string; ne_pas_utiliser: string;
      origin: OutilDefini['origin']; risk: OutilDefini['risk']; source_id: string | null;
      mcp_non_activable: string | null; mcp_indisponible_le: Date | null; mcp_propose: boolean;
      consommateurs: Array<{ cle: string; actif: boolean; agent_label: string | null }> | null;
    }>(
      `select t.id, t.name, t.title, t.description, t.ne_pas_utiliser, t.origin, t.risk, t.source_id,
              t.mcp_non_activable, t.mcp_indisponible_le, t.mcp_propose,
              coalesce(
                (select jsonb_agg(jsonb_build_object('cle', c.consommateur, 'actif', c.actif,
                                                     'agent_label', a.label) order by c.consommateur)
                   from agent_tool_consommateurs c
                   left join agents a on a.tenant_id = c.tenant_id and 'agent:' || a.id = c.consommateur
                  where c.tool_id = t.id and c.tenant_id = t.tenant_id),
                '[]'::jsonb) as consommateurs
         from agent_tools t
        where t.tenant_id = $1
          -- LES ACTIONS D UN AGENT NE SONT PAS DANS LA BIBLIOTHEQUE DE L ESPACE (migration 0157), et
          -- l oublier introduirait le defaut que ce lot vient corriger : l ecran d un agent proposerait
          -- de BRANCHER le terminer d un AUTRE agent, c est-a-dire de partager une definition qui ne se
          -- partage plus. Tools > ne garde que ce qui pointe vers l exterieur (Julien, 2026-09-18).
          and t.agent_id is null
          -- NI LES OUTILS DE L AGENT DE META (0162) : cette liste est celle que les agents IA peuvent brancher.
          and not t.pour_agent_meta
        order by t.name`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id, name: r.name, title: r.title, description: r.description, nePasUtiliser: r.ne_pas_utiliser,
      origin: r.origin, risk: r.risk, sourceId: r.source_id,
      mcpNonActivable: r.mcp_non_activable,
      mcpIndisponibleLe: r.mcp_indisponible_le ? r.mcp_indisponible_le.toISOString() : null,
      mcpPropose: r.origin !== 'mcp' || r.mcp_propose,
      consommateurs: (r.consommateurs ?? []).map((c) => ({
        cle: c.cle,
        actif: c.actif,
        agentId: agentDuConsommateur(c.cle),
        agentLabel: c.agent_label,
      })),
    }));
  }

  // ---------- Aides privées ----------

  private async complet(tenantId: string, consommateur: string, outilId: string): Promise<OutilComplet | null> {
    const client = await this.pool.connect();
    try {
      return await this.completAvecClient(client, tenantId, consommateur, outilId);
    } finally {
      client.release();
    }
  }

  private async completAvecClient(
    client: PoolClient, tenantId: string, consommateur: string, outilId: string,
  ): Promise<OutilComplet | null> {
    const res = await client.query<LigneAdmin>(
      `select ${COLONNES_ADMIN} ${JOINTURE}
        where t.tenant_id = $1 and c.consommateur = $2 and t.id = $3`,
      [tenantId, consommateur, outilId],
    );
    const r = res.rows[0];
    return r ? versComplet(r) : null;
  }
}

/**
 * Les index uniques de nom, traduits en erreur métier (409 plutôt que 500). Deux index : une action est
 * unique par agent (`agent_tools_nom_agent_uidx`), une définition d'espace par espace. La portée se lit sur
 * la contrainte violée ; le repli est « espace », qui fait chercher trop large plutôt qu'à côté.
 */
function surNomDejaPris(err: unknown): never {
  const e = err as { code?: string; constraint?: string } | null;
  if (e?.code === '23505') {
    throw new NomOutilDejaPris(e.constraint === 'agent_tools_nom_agent_uidx' ? 'agent' : 'espace');
  }
  throw err;
}

// `ne_pas_utiliser` est dans `COLONNES`, que le runtime lit aussi.
const COLONNES_ADMIN = `${COLONNES}, t.title, c.actif, c.active_le, c.autonome_le`;

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
    tenantId: string; sessionId: string | null; toolId: string | null; toolName: string; origin: string;
    argsRediges: unknown; source: SourceAppel;
  }): Promise<string> {
    // `refuse` à l'ouverture : une ligne que rien ne vient clore (process tué en plein appel) reste ainsi
    // lisible comme « tentée, jamais aboutie » plutôt que de se faire passer pour un succès.
    const res = await this.pool.query<{ id: string }>(
      `insert into agent_tool_calls (tenant_id, session_id, tool_id, tool_name, origin, args_rediges, status, source)
       values ($1, $2, $3, $4, $5, $6::jsonb, 'refuse', $7) returning id`,
      [input.tenantId, input.sessionId, input.toolId, input.toolName, input.origin, JSON.stringify(input.argsRediges ?? null), input.source],
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
