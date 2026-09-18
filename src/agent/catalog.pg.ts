import type { Pool, PoolClient } from 'pg';
import type {
  JournalAppels, NatureOutil, OutilBibliotheque, OutilComplet, OutilDefini, PatchOutil, RisqueOutil,
  ToolAdminStore, ToolCatalog,
  SourceAppel,
} from './catalog';
import { OutilNonActivable, NomOutilDejaPris } from './catalog';
import { lireGestes } from './gestes';
import { asRecord } from '../webhooks/json';
import { agentDuConsommateur, consommateurAgent, consommateurMba } from './consommateur';

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
 * La jointure, écrite UNE fois. `c.tenant_id = t.tenant_id` est dans la JOINTURE en plus du `where` : le
 * second suffirait à l'isolation entre clients, le premier empêche en plus une ligne de liaison mal écrite
 * (portant le tenant d'un autre client) de rattacher un outil qui n'est pas le sien.
 */
const JOINTURE = `from agent_tools t
                  join agent_tool_consommateurs c on c.tool_id = t.id and c.tenant_id = t.tenant_id`;

/**
 * Colonnes lues par TOUTES les requêtes. Une seule liste : deux projections divergentes finiraient par ne
 * plus rendre le même outil selon le chemin, et le chemin qui compte est celui de l'exécution.
 *
 * 🔴 `autonome` VIENT DE `c`, LA LIAISON, PAS DE `t`. C'est un consentement, il est par consommateur. La
 * colonne de `t` n'existe plus depuis 0128, mais tant qu'elle était là, la lire aurait été silencieusement
 * juste pour le premier consommateur et faux pour tous les autres : le compilateur n'en aurait rien dit, et
 * la base non plus.
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
    // 🔴 LUE PAR LE RUNTIME depuis le 2026-08-29, et elle ne l'était pas. Elle vivait dans la seule
    // projection d'administration, donc le modèle ne l'a jamais vue. Voir `OutilDefini.nePasUtiliser`.
    nePasUtiliser: r.ne_pas_utiliser,
    // `safeParse` et repli VIDE : un jsonb corrompu ne doit pas rendre un agent muet sur le chemin de
    // chaque message, il doit ne produire aucun geste.
    gestes: lireGestes(r.gestes),
    params: r.params,
    // `binding` est du jsonb, donc opaque : lu par le helper défensif maison plutôt qu'affirmé par un `as`.
    // Un scalaire ou un null donne un objet vide, et le résolveur refuse alors proprement.
    binding: asRecord(r.binding),
    // La source vit sur la LIGNE, pas dans `binding` : elle est une clé étrangère, et la contrainte
    // `agent_tools_origin_src_chk` la rend obligatoire dès que l'origine n'est pas `mba`.
    sourceId: r.source_id,
    // La REQUETE que l'outil declenche (migration 0105). Sur la LIGNE pour la meme raison que la source :
    // c'est une cle etrangere, pas une donnee libre, donc la base garantit qu'elle designe quelque chose.
    requestId: r.request_id,
    outputPaths: r.output_paths ?? [],
    // ⚠️ `?? 'integre'` ET PAS UN `as` : une ligne écrite avant la migration 0150 n'a pas de nature, et la
    // valeur par défaut de la colonne la donne de toute façon. Le repli est là pour les faux de test et
    // pour une lecture faite pendant le déploiement, pas pour couvrir une donnée douteuse.
    nature: r.nature === 'pousse' ? 'pousse' : 'integre',
    risk: r.risk,
    timeoutMs: r.timeout_ms,
    maxBytes: r.max_bytes,
    autonome: r.autonome,
    // ⚠️ `null` ET PAS `undefined`, pour les quatre. La distinction a déjà coûté un défaut de bascule sur
    // l'écran MBA : un champ absent et un champ vide se lisent pareil à l'oeil, et pas dans le code.
    mcpAnnonce: r.mcp_annonce ?? null,
    mcpNonActivable: r.mcp_non_activable,
    mcpIndisponibleLe: r.mcp_indisponible_le,
    mcpVuLe: r.mcp_vu_le,
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

  // ---------- Écriture : l'écran de réglage (tranche 19c) ----------

  /**
   * ⚠️ JOINTURE INTERNE, ET C'EST DÉLIBÉRÉ. L'onglet Outils d'un agent montre ce que CET agent utilise, pas
   * tout le catalogue de l'espace : la bibliothèque complète est un autre écran. Passer en `left join` ferait
   * apparaître, dans chaque agent, les outils de tous les autres.
   */
  async listToutes(tenantId: string, agentId: string): Promise<OutilComplet[]> {
    const res = await this.pool.query<LigneAdmin>(
      `select ${COLONNES_ADMIN} ${JOINTURE}
        where t.tenant_id = $1 and c.consommateur = $2 order by t.name`,
      [tenantId, consommateurAgent(agentId)],
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
    // 🔴 DEUX ÉCRITURES, DONC UNE TRANSACTION. Une définition créée sans son rattachement serait un outil
    // qui n'apparaît dans AUCUN écran : ni dans l'agent d'où on vient de le créer, ni ailleurs.
    return this.enTransaction(async (client) => {
      const res = await client.query<{ id: string }>(
        /**
         * 🔴 `agent_id` EST RENSEIGNÉ DEPUIS LA MIGRATION 0157 : une ACTION appartient à l'agent, quand un
         * CONNECTEUR appartient à l'espace. C'est ce qui fait disparaître « un outil de cet espace porte
         * déjà ce nom » : deux agents peuvent chacun avoir leur « terminer », le nom n'étant plus unique
         * que par agent pour les actions.
         */
        `insert into agent_tools
           (tenant_id, agent_id, origin, name, title, description, ne_pas_utiliser, params, binding, risk)
         select $1, $9, 'mba', $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8
          where exists (select 1 from agents where id = $9 and tenant_id = $1)
         returning id`,
        [
          tenantId, outil.name, outil.title, outil.description, outil.nePasUtiliser,
          JSON.stringify(outil.params ?? []),
          // `binding.handler` est ce qui donne son COMPORTEMENT à l'outil : le résolveur maison le lit là, et
          // jamais dans le nom exposé, que le client peut changer.
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
   * Un outil de CONNECTEUR (lot L2). `origin` vaut `'http'` en dur : comme pour les outils maison, le corps de
   * la requête n'a rien à dire là-dessus.
   *
   * La SOURCE est vérifiée dans le même ordre que l'agent, par le `where exists` : une source d'un autre
   * tenant ne produit aucune ligne plutôt qu'une violation de clé étrangère, donc un 404 plutôt qu'un 500.
   */
  async ajouterConnecteur(tenantId: string, agentId: string, outil: {
    sourceId: string; requestId: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: RisqueOutil;
    /**
     * 🔴 OBLIGATOIRES TOUS LES DEUX, ET C'EST DÉLIBÉRÉ (2026-09-15). Les rendre optionnels ferait retomber un
     * appelant distrait sur `integre` avec une liste vide, c'est-à-dire sur un outil qui refuse chaque appel
     * en pleine conversation. Un champ obligatoire force à répondre ; un champ optionnel se laisse oublier.
     */
    nature: NatureOutil; outputPaths: readonly string[];
  }): Promise<OutilComplet | null> {
    return this.creerOutilConnecteur(tenantId, consommateurAgent(agentId), outil);
  }

  /**
   * LE GESTE COMMUN aux deux portes d'entrée : celle d'un agent IA, et celle du Meta Business Agent.
   *
   * 🔴 UN SEUL `insert`, DEUX APPELANTS. Le recopier ferait diverger les gardes d'isolation au premier
   * ajustement, et c'est le motif que ce dépôt a payé une centaine de fois à l'audit du 2026-08-18.
   */
  private async creerOutilConnecteur(tenantId: string, consommateur: string, outil: {
    sourceId: string; requestId: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: RisqueOutil; nature: NatureOutil; outputPaths: readonly string[];
  }): Promise<OutilComplet | null> {
    return this.enTransaction(async (client) => {
      const res = await client.query<{ id: string }>(
        /**
         * ⚠️ `binding` RESTE VIDE : l'appel n'est plus décrit ici depuis la migration 0105, la requête le
         * porte, et le redécrire par agent est précisément le défaut que 0105 a corrigé.
         *
         * 🔴 MAIS `output_paths` EST DÉSORMAIS REMPLI, ET LA JUSTIFICATION D'À CÔTÉ S'EST INVERSÉE
         * (2026-09-15). Elle disait « les remplir en double créerait deux vérités, dont une que le résolveur
         * ne lit pas » : c'était juste tant que ce qu'un agent lisait était une propriété de l'APPEL. Ça ne
         * l'est plus, parce qu'un appel est partagé et que restreindre pour un agent restreignait pour tous.
         * La requête garde sa liste comme DÉFAUT de pré-remplissage, l'outil porte celle qui s'applique.
         *
         * ⚠️ ET LA « VÉRITÉ QUE PERSONNE NE LISAIT » EXISTAIT BEL ET BIEN : le bac à sable bouclait déjà sur
         * cette colonne vide et rendait un objet VIDE, en promettant « exactement ce que l'agent recevra ».
         *
         * Les trois `exists` sont la garde d'isolation : l'agent, la source ET la requête doivent être de ce
         * tenant. Sans eux, les clés étrangères lèveraient en 500, dont Cloudflare remplace le corps.
         */
        /**
         * 🔴 `source_kind` EST ÉCRIT ICI, ET LA SOURCE EST CONTRAINTE À `kind = 'http'` (migration 0152).
         * Les deux vont ensemble : la colonne porte la garde en base (clé étrangère composite vers
         * `agent_tool_sources (id, kind)`), et le `kind = 'http'` du `exists` refuse dès l'écriture qu'un
         * outil HTTP se branche sur un serveur MCP. Sans lui, la ligne passerait la clé étrangère (elle
         * serait cohérente) mais le résolveur partirait dans la mauvaise branche à l'exécution.
         *
         * ⚠️ Le refus prend la forme d'un `insert` qui ne rend AUCUNE ligne, donc le `null` que l'appelant
         * traite déjà, et pas une erreur de contrainte en 500 dont Cloudflare remplace le corps.
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
          // ⚠️ Un `pousse` force la liste à VIDE plutôt que de faire confiance à l'appelant : deux champs qui
          // doivent rester cohérents et que l'on écrit indépendamment finissent par diverger.
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
   * LE MÊME GESTE, POUR UN CONSOMMATEUR QUI N'EST PAS UN AGENT (2026-09-15).
   *
   * 🔴 ET IL NE DEMANDE AUCUNE MIGRATION, ce qui a été MESURÉ et non déduit : `agent_tools.agent_id` n'existe
   * plus depuis la migration 0128. Un outil appartient déjà à l'ESPACE ; seule la ligne
   * `agent_tool_consommateurs` le rattache à quelqu'un, et le Meta Business Agent y est un consommateur
   * comme un autre (`mba:<numero>`). Le plan de ce lot prévoyait de rendre une colonne nullable : elle
   * n'était plus là.
   *
   * 🔴 POURQUOI CE CHEMIN EXISTE. Un outil naissait en le donnant à un agent IA : exposer un appel au Meta
   * Business Agent obligeait donc à créer un agent dont on n'a pas besoin, et à répondre pour lui à des
   * questions que Meta ignore (il appelle le système du client en direct et lit toute la réponse). Julien,
   * 2026-09-15 : « je ne sais pas où l'affecter pour le MBA ».
   *
   * ⚠️ `nature` VAUT TOUJOURS `integre` ICI, et ce n'est pas un défaut paresseux : la question ne se pose pas
   * pour Meta, qui lit tout quoi qu'on déclare. Écrire `pousse` laisserait croire à un réglage qui n'a aucun
   * effet de ce côté.
   */
  async ajouterConnecteurPourMba(tenantId: string, phoneNumberId: string, outil: {
    sourceId: string; requestId: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: RisqueOutil;
  }): Promise<OutilComplet | null> {
    return this.creerOutilConnecteur(tenantId, consommateurMba(phoneNumberId), {
      ...outil, nature: 'integre', outputPaths: [],
    });
  }

  async patch(tenantId: string, agentId: string, outilId: string, patch: PatchOutil): Promise<OutilComplet | null> {
    // Les énumérations sont réécrites DANS le jsonb, en une instruction : une lecture suivie d'une écriture
    // laisserait deux administrateurs se recouvrir en silence sur la même colonne.
    const res = await this.pool.query<{ id: string }>(
      // 🔴 AUCUN ALIAS SUR LA TABLE MISE A JOUR, et surtout PAS `returning ${COLONNES_ADMIN}` : cette liste
      // porte desormais les prefixes `t.` et `c.` de la JOINTURE, qui n existent pas dans un UPDATE. Postgres
      // repond « missing FROM-clause entry for table t », et c est ce qu il a repondu en CI.
      //
      // ⚠️ LE PERIMETRE A CHANGE : `agent_id = $2` n existe plus (colonne retiree par 0128). C est un
      // `exists` sur la LIAISON qui le remplace, et il n est pas decoratif : sans lui, l ecran d un agent
      // pourrait corriger les mots d un outil qu il n utilise pas, donc changer le comportement de l agent
      // du voisin.
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
      [tenantId, consommateurAgent(agentId), outilId, patch.name ?? null, patch.title ?? null,
        patch.description ?? null, patch.nePasUtiliser ?? null,
        patch.enums ? JSON.stringify(patch.enums) : null,
        patch.gestes ? JSON.stringify(patch.gestes) : null],
    ).catch(surNomDejaPris);
    const r = res.rows[0];
    return r ? this.complet(tenantId, consommateurAgent(agentId), r.id) : null;
  }

  async activer(
    tenantId: string, agentId: string, outilId: string, actif: boolean, parUtilisateur: string,
  ): Promise<OutilComplet | null> {
    return this.activerConsommateur(tenantId, consommateurAgent(agentId), outilId, actif, parUtilisateur);
  }

  /**
   * ⚠️ `update`, JAMAIS `insert ... on conflict` : activer n'est PAS un rattachement implicite. Un
   * identifiant d'agent erroné doit rendre `null`, pas fabriquer un consentement pour un consommateur qui
   * n'existe nulle part et que plus aucun écran ne montrerait.
   *
   * Désactiver EFFACE l'activateur : ces deux colonnes disent « qui l'a mis en service, et quand », pas
   * « qui y a touché un jour ». Les garder ferait afficher un consentement qui n'a plus cours.
   */
  async activerConsommateur(
    tenantId: string, consommateur: string, outilId: string, actif: boolean, parUtilisateur: string,
  ): Promise<OutilComplet | null> {
    /**
     * 🔴 LE POINT DE PASSAGE UNIQUE DE L'ACTIVATION, ET C'EST POUR ÇA QUE LA GARDE EST ICI. Les deux
     * chemins y aboutissent : l'onglet Outils d'un agent (`activer`, juste au-dessus) et l'exposition à
     * l'agent de Meta (`src/http/agent-catalogue.ts`). La poser dans l'un des deux la laisserait absente
     * de l'autre, ce qui est le motif « capacité câblée sur un consommateur sur deux ».
     *
     * ⚠️ SEULEMENT À L'ACTIVATION. Désactiver un outil devenu non activable doit rester possible : c'est
     * même le seul geste qui reste au client.
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

  async rattacher(tenantId: string, agentId: string, outilId: string): Promise<boolean> {
    return this.rattacherConsommateur(tenantId, consommateurAgent(agentId), outilId);
  }

  /**
   * Le `where exists` vérifie que l'outil est de CE tenant : une clé étrangère lèverait en 500, dont
   * Cloudflare remplace le corps. `do nothing` rend un rattachement répété inoffensif.
   */
  async rattacherConsommateur(tenantId: string, consommateur: string, outilId: string): Promise<boolean> {
    const res = await this.pool.query(
      `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur)
       select $1, $2, $3 where exists (select 1 from agent_tools where id = $2 and tenant_id = $1)
       on conflict (tool_id, consommateur) do nothing`,
      [tenantId, outilId, consommateur],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async detacher(tenantId: string, agentId: string, outilId: string): Promise<boolean> {
    return this.detacherConsommateur(tenantId, consommateurAgent(agentId), outilId);
  }

  async detacherConsommateur(tenantId: string, consommateur: string, outilId: string): Promise<boolean> {
    const res = await this.pool.query(
      'delete from agent_tool_consommateurs where tenant_id = $1 and consommateur = $2 and tool_id = $3',
      [tenantId, consommateur, outilId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async supprimerDefinition(tenantId: string, outilId: string): Promise<'ok' | 'rattachee' | 'introuvable'> {
    return this.enTransaction(async (client) => {
      // `for update` sur la définition : sans lui, un rattachement concurrent passerait entre le comptage et
      // la suppression, et la cascade emporterait le consentement qui vient d'être posé.
      const exist = await client.query(
        'select 1 from agent_tools where tenant_id = $1 and id = $2 for update',
        [tenantId, outilId],
      );
      if ((exist.rowCount ?? 0) === 0) return 'introuvable';
      const rattachee = await client.query(
        'select 1 from agent_tool_consommateurs where tenant_id = $1 and tool_id = $2 limit 1',
        [tenantId, outilId],
      );
      if ((rattachee.rowCount ?? 0) > 0) return 'rattachee';
      await client.query('delete from agent_tools where tenant_id = $1 and id = $2', [tenantId, outilId]);
      return 'ok';
    });
  }

  /**
   * La bibliothèque de l'espace : chaque définition, et qui s'en sert.
   *
   * ⚠️ UNE SEULE REQUÊTE, pas une par outil. Une bibliothèque de trente outils ferait sinon trente allers et
   * retours, ce que l'audit du 2026-08-25 a déjà eu à corriger ailleurs. Les consommateurs sont agrégés en
   * jsonb dans la même passe.
   *
   * ⚠️ `left join` SUR LES CONSOMMATEURS : une définition que plus personne n'utilise doit APPARAÎTRE, c'est
   * même la seule qu'on puisse supprimer. Une jointure interne la cacherait précisément quand elle compte.
   */
  async listCatalogue(tenantId: string): Promise<OutilBibliotheque[]> {
    const res = await this.pool.query<{
      id: string; handler: string | null; name: string; title: string; description: string;
      origin: OutilDefini['origin']; risk: OutilDefini['risk']; source_id: string | null;
      mcp_non_activable: string | null; mcp_indisponible_le: Date | null;
      consommateurs: Array<{ cle: string; actif: boolean; agent_label: string | null }> | null;
    }>(
      `select t.id, t.binding->>'handler' as handler, t.name, t.title, t.description, t.origin, t.risk, t.source_id,
              t.mcp_non_activable, t.mcp_indisponible_le,
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
        order by t.name`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id, handler: r.handler, name: r.name, title: r.title, description: r.description,
      origin: r.origin, risk: r.risk, sourceId: r.source_id,
      mcpNonActivable: r.mcp_non_activable,
      mcpIndisponibleLe: r.mcp_indisponible_le ? r.mcp_indisponible_le.toISOString() : null,
      consommateurs: (r.consommateurs ?? []).map((c) => ({
        cle: c.cle,
        actif: c.actif,
        agentId: agentDuConsommateur(c.cle),
        agentLabel: c.agent_label,
      })),
    }));
  }

  // ---------- Aides privées ----------

  private async enTransaction<T>(travail: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const r = await travail(client);
      await client.query('commit');
      return r;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

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
 * L'index unique `(tenant_id, name)` de la migration 0127, traduit en erreur métier. Sans ça, deux outils du
 * même nom remontaient en 500, dont Cloudflare remplace le corps : le client ne voyait rien.
 *
 * ⚠️ IL PORTAIT SUR `(agent_id, name)` JUSQU'À 0127. La portée s'est ÉLARGIE : un nom pris par l'agent du
 * voisin bloque désormais la création, ce qui est le comportement voulu (une définition par nom et par
 * espace) mais change ce que le message veut dire. D'où « un outil de cet ESPACE » et non « de cet agent ».
 */
function surNomDejaPris(err: unknown): never {
  if ((err as { code?: string } | null)?.code === '23505') throw new NomOutilDejaPris();
  throw err;
}

// `ne_pas_utiliser` n'y est plus : elle est passée dans `COLONNES`, que le RUNTIME lit aussi.
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
