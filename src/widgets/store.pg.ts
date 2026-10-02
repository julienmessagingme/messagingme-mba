import type { Pool } from 'pg';
import { newTrackingCode } from '../ids/code';

/**
 * Les widgets WhatsApp d'un espace (migration 0200) : la bulle que le client pose sur son site.
 *
 * 🔴 `tenant_id = $1` SUR CHAQUE REQUÊTE, SAUF `parCode`. La connexion du pooler est superuser, la RLS est
 * contournée : ce filtre est le seul contrôle d'isolation entre clients. `parCode` n'en reçoit pas, et c'est
 * le cas du code opaque, comme `getByCode` des liens tracés (`src/links/tracked-links.pg.ts`) : la route
 * publique `/widget/<code>.js` n'a ni session ni espace, le code EST l'autorité, et c'est lui qui REND
 * l'espace. Il n'y a donc aucun espace à filtrer, seulement un espace à retourner.
 *
 * Ce store ne juge PAS la phrase. Le conflit par inclusion avec les liens de chaîne, et la phrase déjà vue
 * dans des messages reçus, se contrôlent dans la route d'écriture (lot 4 du plan), avec `normalizeText`.
 * Ici, on écrit, et l'index `widgets_phrase_key` est le filet contre une course entre deux créations.
 */

/** Qui prend la conversation qu'un widget amène. `null` = le réglage de l'espace, pas « personne ». */
export type DevenirWidget = 'agent' | 'mba' | 'scenario';

/** Les quatre coins où la bulle peut se poser. Pas de coordonnée libre. */
export type PositionWidget = 'bas_droite' | 'bas_gauche' | 'haut_droite' | 'haut_gauche';

/**
 * Ce qu'une route peut écrire. Ni `code` ni `tenantId` : le premier est tiré au sort à la création puis
 * IMMUABLE (une balise posée chez un client est une porte à sens unique), le second vient de la session,
 * jamais du corps de la requête.
 */
export interface WidgetInput {
  nom: string;
  phrase: string;
  devenir: DevenirWidget | null;
  /** Renseigné seulement si `devenir` vaut 'agent' : la base refuse le reste (`widgets_agent_sans_devenir_chk`). */
  agentId: string | null;
  /** Renseigné seulement si `devenir` vaut 'scenario' (`widgets_scenario_sans_devenir_chk`). */
  workflowId: string | null;
  couleur: string;
  position: PositionWidget;
  libelle: string | null;
  avatarUrl: string | null;
  badge: boolean;
  actif: boolean;
  /** Plafond horaire propre au widget. null = plafond global de l'instance, pas « zéro ». */
  maxParHeure: number | null;
}

/**
 * Un widget tel que la base le rend. ⚠️ `devenir = 'agent'` avec `agentId` à null est un état ATTEIGNABLE
 * (agent supprimé après coup, `on delete set null`), de même pour 'scenario' : le lecteur doit le traiter
 * comme `devenir = null`, c'est-à-dire le réglage de l'espace.
 */
export interface WidgetRow extends WidgetInput {
  id: string;
  tenantId: string;
  /** L'identifiant PUBLIC, celui de l'URL du script. */
  code: string;
  createdAt: string;
  updatedAt: string;
}

/** Liste tenue à la main : une colonne ajoutée ici doit l'être aussi dans `WidgetBrut` et `versWidget`. */
const COLS = `id, tenant_id, code, nom, phrase, devenir, agent_id, workflow_id, couleur, position, libelle,
  avatar_url, badge, actif, max_par_heure, created_at, updated_at`;

/**
 * Forme brute d'une ligne `widgets`. Les deux unions (`devenir`, `position`) ne sont pas un pari sur la
 * donnée : les CHECK `widgets_devenir_chk` et `widgets_position_chk` empêchent d'écrire toute autre valeur.
 */
interface WidgetBrut {
  id: string;
  tenant_id: string;
  code: string;
  nom: string;
  phrase: string;
  devenir: DevenirWidget | null;
  agent_id: string | null;
  workflow_id: string | null;
  couleur: string;
  position: PositionWidget;
  libelle: string | null;
  avatar_url: string | null;
  badge: boolean;
  actif: boolean;
  max_par_heure: number | null;
  created_at: Date;
  updated_at: Date;
}

function versWidget(r: WidgetBrut): WidgetRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    code: r.code,
    nom: r.nom,
    phrase: r.phrase,
    devenir: r.devenir,
    agentId: r.agent_id,
    workflowId: r.workflow_id,
    couleur: r.couleur,
    position: r.position,
    libelle: r.libelle,
    avatarUrl: r.avatar_url,
    badge: r.badge,
    actif: r.actif,
    maxParHeure: r.max_par_heure,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Les valeurs de `WidgetInput`, de `$3` à `$14`, dans l'ordre que `creer` et `modifier` partagent. */
function valeurs(w: WidgetInput): unknown[] {
  return [
    w.nom, w.phrase, w.devenir, w.agentId, w.workflowId, w.couleur, w.position, w.libelle, w.avatarUrl,
    w.badge, w.actif, w.maxParHeure,
  ];
}

export class PgWidgetStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Crée un widget et lui tire son code public. Le générateur est celui des liens tracés (`newTrackingCode`) :
   * mêmes besoins, une adresse publique qui ne doit dire ni à qui elle appartient ni quand elle est née, et
   * 60 bits d'aléa interdisent d'énumérer les widgets (donc les numéros) de nos clients. Le code ne protège
   * rien d'autre : le script qu'il sert est public par construction.
   */
  async creer(tenantId: string, w: WidgetInput): Promise<WidgetRow> {
    const { rows } = await this.pool.query<WidgetBrut>(
      `insert into widgets (tenant_id, code, nom, phrase, devenir, agent_id, workflow_id, couleur, position,
                            libelle, avatar_url, badge, actif, max_par_heure)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       returning ${COLS}`,
      [tenantId, newTrackingCode(), ...valeurs(w)],
    );
    return versWidget(rows[0]!);
  }

  /**
   * Le widget d'un code public, pour la route `/widget/<code>.js`. 🔴 SANS `tenant_id`, délibérément : voir
   * l'en-tête du fichier. C'est le widget qui RETOURNE l'espace, jamais l'appelant qui le fournit.
   *
   * Le code arrive d'une URL : comparé en minuscules, comme `getByCode` des liens tracés (le générateur ne
   * produit que des minuscules, et `lower` sur le paramètre laisse l'index `widgets_code_key` servir).
   * `actif` est RENDU, pas filtré : c'est la route qui décide d'une bulle absente, testable sans base.
   */
  async parCode(code: string): Promise<WidgetRow | null> {
    const { rows } = await this.pool.query<WidgetBrut>(
      `select ${COLS} from widgets where code = lower($1)`,
      [code],
    );
    return rows[0] ? versWidget(rows[0]) : null;
  }

  /** Les widgets de cet espace, du plus récent au plus ancien. */
  async lister(tenantId: string): Promise<WidgetRow[]> {
    const { rows } = await this.pool.query<WidgetBrut>(
      `select ${COLS} from widgets where tenant_id = $1 order by created_at desc`,
      [tenantId],
    );
    return rows.map(versWidget);
  }

  /**
   * Remplace tout ce qu'une route peut écrire. Le `code` et l'espace ne sont JAMAIS réécrits : c'est ici que
   * leur immuabilité se tient. null = widget inconnu dans cet espace, y compris celui d'un autre espace.
   */
  async modifier(tenantId: string, id: string, w: WidgetInput): Promise<WidgetRow | null> {
    const { rows } = await this.pool.query<WidgetBrut>(
      `update widgets
          set nom = $3, phrase = $4, devenir = $5, agent_id = $6, workflow_id = $7, couleur = $8, position = $9,
              libelle = $10, avatar_url = $11, badge = $12, actif = $13, max_par_heure = $14, updated_at = now()
        where tenant_id = $1 and id = $2
       returning ${COLS}`,
      [tenantId, id, ...valeurs(w)],
    );
    return rows[0] ? versWidget(rows[0]) : null;
  }

  /**
   * Supprime le widget. La balise déjà posée chez le client ne casse pas pour autant : un code inconnu doit
   * rendre un script inerte (lot 2 du plan). false = widget inconnu dans cet espace.
   */
  async supprimer(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      'delete from widgets where tenant_id = $1 and id = $2',
      [tenantId, id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Les phrases des widgets de cet espace, telles qu'elles sont stockées : le pendant de
   * `PgChannelsMeLinkStore.phrasesDesLiens`, pour que la création d'un lien de chaîne voie aussi les widgets.
   * La comparaison se fait en JS avec `normalizeText`, pas ici. Pas de `limit` : un plafond rendrait une garde
   * qui se dégrade en silence.
   */
  async phrasesDesWidgets(tenantId: string): Promise<string[]> {
    const res = await this.pool.query<{ phrase: string }>(
      'select phrase from widgets where tenant_id = $1',
      [tenantId],
    );
    return res.rows.map((r) => r.phrase);
  }
}
