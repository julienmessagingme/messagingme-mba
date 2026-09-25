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
 * 🔴 UN CONSENTEMENT D'AGENT VERROUILLE SON AGENT, dans une instruction À PART, avant de toucher à l'outil
 * (relecture du 2026-09-22). Sans ce verrou, un rattachement ne voyait pas qu'on supprimait l'agent : son
 * consentement survivait à l'agent (un consommateur fantôme, qui empêche à jamais le dernier détachement
 * d'effacer le connecteur), ou il se glissait entre la lecture et le retrait de `PgAgentStore.remove`, dont
 * l'ordre de verrous était alors inversé pour lui. Avec lui, il attend la suppression, puis ne trouve plus
 * l'agent et rend `false`. Instruction À PART : dans un même `where`, l'ordre de deux `exists` n'est pas
 * garanti, et celui-ci doit précéder le verrou de l'outil (l'ordre de `remove` : l'agent, puis l'outil).
 * Rend `false` quand l'agent n'existe plus. Un consommateur qui n'est pas un agent (`mba:`) passe.
 *
 * ⚠️ Une clé `agent:` que `FORME_CONSOMMATEUR` refuse (un identifiant en majuscules, que `estUuid` accepte)
 * rend `false` elle aussi : la laisser passer comme « pas un agent » sautait la garde, et c'est le CHECK de 0127
 * qui la refusait ensuite, en 500 (relecture du 2026-09-22).
 */
async function verrouillerAgentDuConsommateur(client: PoolClient, tenantId: string, consommateur: string): Promise<boolean> {
  const agentId = agentDuConsommateur(consommateur);
  if (agentId === null) return !consommateur.startsWith('agent:');
  const r = await client.query('select 1 from agents where tenant_id = $1 and id = $2 for key share', [tenantId, agentId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 🔴 VERROUILLER LES DÉFINITIONS AVANT LE `not exists` QUI DÉCIDE DE LES EFFACER (décision du 2026-09-21 :
 * une action ou un connecteur HTTP que plus personne n'utilise part).
 *
 * Sans ce verrou, un rattachement concurrent posait son consentement juste avant le `not exists` : invisible de
 * ce dernier (pas encore validé), il partait ensuite dans la cascade de la définition effacée. C'est la raison
 * qu'écrivait déjà l'ancien `supprimerDefinition`, et les trois chemins qui l'ont remplacé l'avaient perdue
 * (revue finale du 2026-09-21). Avec lui, l'un attend l'autre : le rattachement validé d'abord est VU par le
 * `not exists`, qui s'exécute ensuite dans une nouvelle instruction ; celui qui arrive après attend
 * (`for key share` dans `rattacherConsommateur`) et ne trouve plus rien.
 *
 * ⚠️ DEUX CONTRAINTES : le verrou précède le `not exists` ; et les chemins des CONSENTEMENTS et du JOURNAL suivent
 * un même ordre, l'agent, ses sessions, les définitions (triées par identifiant), puis ce qui en dépend (lignes de
 * consentement, appels journalisés). Sinon deux chemins s'attendent l'un l'autre (40P01). Le JSDoc de
 * `PgAgentStore.remove` raconte les trois ordres qui ont interbloqué avant celui-là, et les chemins voisins (import
 * et suppression d'un serveur MCP, relecture de la connaissance) qui s'y sont alignés.
 *
 * ⚠️ `order by id` : deux effacements qui verrouillent plusieurs définitions le font dans le même ordre, sinon
 * ils pourraient s'attendre l'un l'autre.
 */
export async function verrouillerDefinitions(client: PoolClient, tenantId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    'select 1 from agent_tools where tenant_id = $1 and id = any($2::uuid[]) order by id for update',
    [tenantId, ids],
  );
}

/**
 * Lecture du catalogue d'outils (migration 0086).
 *
 * 🔴 `and actif` est dans le SQL des DEUX requêtes, et `t.tenant_id = $1 and c.consommateur = $2` aussi. Le
 * nom d'outil vient du modèle, donc d'un texte qu'un contact peut influencer : c'est la clause `where` qui
 * empêche d'appeler l'outil d'un autre agent ou d'un autre client (voir `ToolCatalog.byName`).
 *
 * ⚠️ C'EST LA LIAISON QUI ISOLE, PAS `agent_id`, et il ne faut pas les confondre depuis 0157. `agent_id` dit
 * à QUI APPARTIENT une définition (une action à son agent, un connecteur à personne) ; le consentement dit
 * QUI A LE DROIT DE S'EN SERVIR, et c'est lui seul qui garde le chemin d'exécution. Filtrer ici sur
 * `agent_id` laisserait passer un connecteur partagé auquel cet agent n'a jamais été rattaché.
 *
 * L'écriture (l'écran de réglage) vit dans la même classe. 🔴 L'ACTIVATION PORTE LE NOM DE QUI L'A FAITE, et ce
 * n'est pas de la traçabilité de confort. La spec MCP exige un consentement humain avant l'invocation d'un
 * outil ; notre agent n'a aucun humain au runtime. Le consentement est donc déplacé du runtime vers la
 * CONFIGURATION, et la migration 0086 le rend incontournable en base (`actif = false or active_par is not
 * null`). Même doctrine pour l'autonomie. L'identité vient du JETON, jamais du corps de la requête : sinon la
 * trace désignerait qui l'appelant veut.
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

  // ---------- Écriture : l'écran de réglage (tranche 19c) ----------

  /**
   * TOUS les outils d'un agent, actifs ou non.
   *
   * ⚠️ JOINTURE INTERNE, ET C'EST DÉLIBÉRÉ. L'onglet Outils d'un agent montre ce que CET agent utilise, pas
   * tout le catalogue de l'espace : la bibliothèque complète est un autre écran. Passer en `left join` ferait
   * apparaître, dans chaque agent, les outils de tous les autres.
   */
  async listToutes(tenantId: string, agentId: string): Promise<OutilComplet[]> {
    return this.listToutesConsommateur(tenantId, consommateurAgent(agentId));
  }

  /**
   * Tous les outils d'un consommateur, actifs ou non, avec leurs champs d'écran. Sert l'onglet d'un agent IA
   * (`listToutes`) et celui de l'agent de Meta (`mba:<numéro>`, spec 2026-09-21-outils-maison-mba).
   */
  async listToutesConsommateur(tenantId: string, consommateur: string): Promise<OutilComplet[]> {
    const res = await this.pool.query<LigneAdmin>(
      `select ${COLONNES_ADMIN} ${JOINTURE}
        where t.tenant_id = $1 and c.consommateur = $2 order by t.name`,
      [tenantId, consommateur],
    );
    return res.rows.map(versComplet);
  }

  /**
   * Ajoute un outil MAISON à un agent, inactif. Rend `null` si l'agent n'existe pas ou appartient à un autre
   * tenant. LÈVE `NomOutilDejaPris` si le nom exposé est déjà porté par un outil de cet agent.
   */
  async ajouter(tenantId: string, agentId: string, outil: {
    handler: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: RisqueOutil;
  }): Promise<OutilComplet | null> {
    // `origin` vaut 'mba' en dur : L1 n'a que des outils maison, et le corps de la requête n'a rien à dire
    // là-dessus. `actif` reste à son défaut (faux) : la migration 0086 refuserait un actif sans activateur,
    // et surtout un outil actif d'emblée serait exposé au modèle avant que quiconque ait relu ses mots.
    // 🔴 DEUX ÉCRITURES, DONC UNE TRANSACTION. Une définition créée sans son rattachement serait un outil
    // qui n'apparaît dans AUCUN écran : ni dans l'agent d'où on vient de le créer, ni ailleurs.
    return enTransaction(this.pool, async (client) => {
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
    return enTransaction(this.pool, async (client) => {
      if (!(await verrouillerAgentDuConsommateur(client, tenantId, consommateur))) return null;
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
   * 🔴 ET IL NE DEMANDE AUCUNE MIGRATION, ce qui a été MESURÉ et non déduit : un CONNECTEUR appartient à
   * l'ESPACE, seule la ligne `agent_tool_consommateurs` le rattache à quelqu'un, et le Meta Business Agent y
   * est un consommateur comme un autre (`mba:<numero>`). Le plan de ce lot prévoyait de rendre une colonne
   * nullable : elle n'était plus là.
   *
   * ⚠️ CETTE JUSTIFICATION DISAIT « `agent_id` N'EXISTE PLUS DEPUIS 0128 », ET C'EST DEVENU FAUX AVEC 0157,
   * qui l'a remise pour les ACTIONS. Ce qui reste vrai est ce qui compte ici : un connecteur laisse
   * `agent_id` à `null`, et le CHECK `agent_tools_agent_origin_chk` le lui impose.
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

  /**
   * UN OUTIL MAISON DE L'AGENT DE META (migration 0162, spec 2026-09-21-outils-maison-mba § 6).
   *
   * 🔴 IL NAÎT EXPOSÉ ET ACTIF, AU NOM DE L'ADMINISTRATEUR, dans la même transaction. Il n'a pas d'autre
   * consommateur possible (`rattacherConsommateur` refuse un agent IA), donc un outil créé mais inactif ne
   * servirait à personne ; et `atc_actif_humain_chk` exige qu'un humain l'ait activé.
   *
   * ⚠️ `params` RESTE VIDE : ce que Meta envoie se dérive de la cible (`variablesPourMeta`), et le recopier ici
   * ferait une seconde vérité.
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

  /**
   * Corrige les mots ou la cible d'un outil maison de l'agent de Meta. `null` = pas un outil de CET agent.
   *
   * ⚠️ LE RISQUE SUIT LA CIBLE : il se recalcule quand elle change, jamais depuis le corps de la requête.
   */
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
   * « SUPPRIMER » DEPUIS L'ONGLET DE L'AGENT DE META (spec 2026-09-21-outils-maison-mba § 9.1).
   *
   * 🔴 L'OUTIL N'EST RETIRÉ QU'À L'AGENT DE META. Un connecteur partagé avec un agent IA reste à cet agent
   * (`detache`) ; un outil qui n'a plus aucun consommateur part (`supprime`), sinon sa définition resterait
   * sans écran pour la voir, et son nom resterait pris : même règle que `detacher`. `agent_id is null` épargne
   * une action d'agent IA rattachée au MBA par l'ancienne route, et `origin <> 'mcp'` un outil MCP importé,
   * qui doit rester branchable.
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

  /**
   * 🔴 LE MÊME GESTE POUR UN CONSOMMATEUR QUI N'EST PAS UN AGENT (2026-09-18), et son absence rendait un
   * outil du Meta Business Agent DÉFINITIVEMENT figé. `patch` était scopé par agent, or un outil créé pour
   * le MBA n'en a aucun : aucune route ne pouvait donc corriger son nom, son titre, ce à quoi il sert ni
   * quand ne pas l'appeler. Julien : « je ne peux rien changer sur l'outil dans l'onglet outils ». C'est
   * exactement le motif `activer`/`activerConsommateur` du même fichier : une capacité câblée sur un
   * consommateur sur deux est un correctif à moitié.
   */
  async patchConsommateur(
    tenantId: string, consommateur: string, outilId: string, patch: PatchOutil,
  ): Promise<OutilComplet | null> {
    // Les énumérations sont réécrites DANS le jsonb, en une instruction : une lecture suivie d'une écriture
    // laisserait deux administrateurs se recouvrir en silence sur la même colonne.
    const res = await this.pool.query<{ id: string }>(
      // 🔴 AUCUN ALIAS SUR LA TABLE MISE A JOUR, et surtout PAS `returning ${COLONNES_ADMIN}` : cette liste
      // porte desormais les prefixes `t.` et `c.` de la JOINTURE, qui n existent pas dans un UPDATE. Postgres
      // repond « missing FROM-clause entry for table t », et c est ce qu il a repondu en CI.
      //
      // ⚠️ C EST LA LIAISON QUI BORNE LE PERIMETRE, PAS `agent_id`, et l `exists` n est pas decoratif : sans
      // lui, l ecran d un agent pourrait corriger les mots d un outil qu il n utilise pas, donc changer le
      // comportement de l agent du voisin. Le consentement est la bonne cle ici meme depuis 0157 : un
      // CONNECTEUR n a pas d `agent_id`, et c est pourtant bien cet agent-la qui a le droit de le renommer.
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
   * Active ou désactive pour un consommateur qui n'est pas un agent.
   *
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
     * chemins y aboutissent : l'onglet Outils d'un agent (`activer`, juste au-dessus) et la réactivation d'un
     * outil de l'agent de Meta (`src/http/mba-outils.ts`). La poser dans l'un des deux la laisserait absente
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
   * Rend cet outil de l'espace disponible pour cet agent, INACTIF.
   *
   * ⚠️ LE RATTACHEMENT ET L'ACTIVATION SONT DEUX GESTES. Les fondre ferait qu'ajouter un outil de la
   * bibliothèque à un agent l'exposerait au modèle dans la foulée, sans que personne ait relu ses mots :
   * exactement ce que la migration 0086 existe pour empêcher.
   * `false` = l'outil n'existe pas dans cet espace, il y est déjà rattaché, c'est un outil de l'agent de Meta
   * (jamais ouvert à un agent IA, migration 0162), ou un effacement concurrent vient de l'emporter.
   */
  async rattacher(tenantId: string, agentId: string, outilId: string): Promise<boolean> {
    return this.rattacherConsommateur(tenantId, consommateurAgent(agentId), outilId);
  }

  /**
   * Même geste, pour un consommateur qui n'est pas un agent (le MBA).
   *
   * Le `where exists` vérifie que l'outil est de CE tenant : une clé étrangère lèverait en 500, dont
   * Cloudflare remplace le corps. `do nothing` rend un rattachement répété inoffensif.
   */
  async rattacherConsommateur(tenantId: string, consommateur: string, outilId: string): Promise<boolean> {
    // 🔴 UN OUTIL DE L'AGENT DE META NE S'OUVRE JAMAIS À UN AGENT IA (migration 0162) : son handler n'existe pas
    // chez eux, et le brancher ferait un outil offert qui refuse à chaque appel.
    // ⚠️ `for key share` : si un dernier détachement tient la définition (`verrouillerDefinitions`), on l'ATTEND,
    // puis on ne trouve plus rien et l'on rend `false` (404). Sans lui, l'insertion passait la lecture, butait
    // ensuite sur la clé étrangère de la définition effacée, et le rattachement rendait 500.
    // 🔴 Et l'AGENT d'abord (`verrouillerAgentDuConsommateur`) : un agent qu'on supprime rend `false`, jamais un
    // consentement fantôme.
    return enTransaction(this.pool, async (client) => {
      if (!(await verrouillerAgentDuConsommateur(client, tenantId, consommateur))) return false;
      const res = await client.query(
        `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur)
         select $1, $2, $3
          where exists (select 1 from agent_tools
                         where id = $2 and tenant_id = $1 and (not pour_agent_meta or $3::text like 'mba:%')
                           for key share)
         on conflict (tool_id, consommateur) do nothing`,
        [tenantId, outilId, consommateur],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  /**
   * Retire l'outil de CET agent. La définition reste tant qu'un autre consommateur s'en sert ; une action ou un
   * connecteur HTTP qui perd son DERNIER consommateur part avec lui, un outil MCP reste (2026-09-21).
   *
   * 🔴 DÉTACHER LE DERNIER UTILISATEUR D'UNE ACTION OU D'UN CONNECTEUR HTTP LE SUPPRIME ; UN OUTIL MCP RESTE
   * (revue finale du 2026-09-18 pour l'action, décision de Julien du 2026-09-21 pour le connecteur).
   *
   * Le défaut était une conséquence non vue de 0157, et c'était le cul-de-sac même que ce lot corrigeait,
   * reproduit un cran plus bas. `listCatalogue` exclut désormais les actions d'agent de la bibliothèque de
   * l'espace ; or la bibliothèque est le SEUL écran d'où l'on puisse supprimer une définition. Détacher une
   * action ne retirait que la ligne de consentement : la définition restait, plus aucun écran ne la
   * montrait, plus aucun geste ne pouvait l'effacer, et son nom restait pris pour cet agent. Recréer le même
   * outil rendait 409, sans issue.
   *
   * 🔴 LE MÊME CUL-DE-SAC EST REVENU POUR LES CONNECTEURS, ET C'EST CE QUE LE 2026-09-21 FERME. Un connecteur
   * appartient à l'espace et se partage, donc son détachement ne l'effaçait pas ; son dernier écran de
   * suppression était l'ancien onglet Outils du MBA, parti avec le chantier des outils maison. Un connecteur
   * orphelin gardait alors son nom pris et BLOQUAIT la suppression de sa requête dans Connecteurs API, sans
   * écran pour s'en défaire. Décision de Julien : un connecteur HTTP que plus personne n'utilise part.
   *
   * ⚠️ LA CONDITION QUI COMPTE EST L'ABSENCE DE CONSOMMATEUR RESTANT : elle épargne une définition qu'un autre
   * agent (ou l'agent de Meta) utilise encore, dont la cascade emporterait le consentement. `origin = 'http'`
   * épargne les outils MCP : ils viennent d'un import de serveur et doivent rester branchables depuis la
   * bibliothèque. Et `agent_id = $3` borne l'effacement d'une action à SON agent.
   *
   * 🔴 UNE TRANSACTION, parce que ce sont DEUX écritures. Entre les deux, la définition est exactement dans
   * l'état orphelin qu'on veut ne jamais laisser derrière soi.
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
   * Les définitions qu'un agent IA peut BRANCHER, avec qui s'en sert : les connecteurs et les outils MCP de
   * l'espace. Ni les actions d'un agent (elles lui appartiennent, 0157), ni les outils de l'agent de Meta
   * (0162). Lue par l'onglet Outils d'un agent, l'assistant de construction et la vue de l'onglet de l'agent
   * de Meta (« Aussi utilisé par »).
   *
   * La bibliothèque de l'espace : chaque définition, et qui s'en sert.
   *
   * ⚠️ UNE SEULE REQUÊTE, pas une par outil. Une bibliothèque de trente outils ferait sinon trente allers et
   * retours, ce que l'audit du 2026-08-25 a déjà eu à corriger ailleurs. Les consommateurs sont agrégés en
   * jsonb dans la même passe.
   *
   * ⚠️ `left join` SUR LES CONSOMMATEURS : un outil MCP importé que personne n'a encore branché doit APPARAÎTRE,
   * c'est précisément celui qu'un agent vient chercher ici. (Un connecteur HTTP sans consommateur n'existe
   * plus : `detacher` et la suppression d'un agent l'effacent, décision du 2026-09-21.)
   *
   * 🔴 ET C'EST EXACTEMENT POURQUOI `detacher` EFFACE UNE ACTION (revue finale du 2026-09-18). Le filtre
   * `agent_id is null` ci-dessous sort les actions de cet écran, donc du SEUL endroit d'où l'on supprime une
   * définition : détacher une action y laissait un orphelin que rien ne montrait, que rien ne pouvait
   * effacer, et dont le nom restait pris pour cet agent. Depuis le 2026-09-21, plus aucun écran ne supprime
   * une définition à la main : ce qui ne sert plus à personne part avec son dernier détachement (`detacher`,
   * `PgAgentStore.remove`, `retirerDeMba`), sauf un outil MCP, qui reste branchable.
   */
  async listCatalogue(tenantId: string): Promise<OutilBibliotheque[]> {
    const res = await this.pool.query<{
      id: string; name: string; title: string; description: string; ne_pas_utiliser: string;
      origin: OutilDefini['origin']; risk: OutilDefini['risk']; source_id: string | null;
      mcp_non_activable: string | null; mcp_indisponible_le: Date | null;
      consommateurs: Array<{ cle: string; actif: boolean; agent_label: string | null }> | null;
    }>(
      `select t.id, t.name, t.title, t.description, t.ne_pas_utiliser, t.origin, t.risk, t.source_id,
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
 * Les index uniques de nom, traduits en erreur métier. Sans ça, deux outils du même nom remontaient en 500,
 * dont Cloudflare remplace le corps : le client ne voyait rien.
 *
 * 🔴 IL Y EN A DEUX DEPUIS 0157, ET LE MESSAGE DOIT DIRE LEQUEL A REFUSÉ. `agent_tools_nom_agent_uidx` tient
 * l'unicité d'une ACTION par agent, `agent_tools_nom_espace_uidx` celle d'une définition d'ESPACE. La portée
 * a fait l'aller-retour (par agent jusqu'à 0127, par espace jusqu'à 0157, par agent de nouveau pour les
 * actions) et elle a laissé deux fois un message périmé derrière elle. On la LIT donc sur la contrainte
 * violée, la seule chose qui ne puisse pas dériver.
 *
 * ⚠️ LE REPLI EST « ESPACE », et c'est le bon sens du doute : une contrainte inconnue est plus probablement
 * une unicité d'espace (le régime historique), et désigner l'espace sur un conflit d'agent fait chercher
 * trop large, quand l'inverse fait chercher à côté.
 */
function surNomDejaPris(err: unknown): never {
  const e = err as { code?: string; constraint?: string } | null;
  if (e?.code === '23505') {
    throw new NomOutilDejaPris(e.constraint === 'agent_tools_nom_agent_uidx' ? 'agent' : 'espace');
  }
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
