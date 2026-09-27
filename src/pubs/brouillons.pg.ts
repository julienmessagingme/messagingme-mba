import type { Pool } from 'pg';
import type { DestinationPub } from './routage';

/**
 * Les brouillons de publicité : un formulaire mémorisé, sans identifiant Meta, dépense ni automation, dans sa
 * propre table. `publicites.campagne_id` est `not null` et porte l'unique par laquelle le routage retrouve la
 * publicité d'un lead payé : on n'y fait pas entrer de lignes sans campagne.
 *
 * Tout est du texte, budget et dates compris : un brouillon garde un travail incomplet. La validation reste
 * à la création réelle chez Meta.
 */

/** Ce que la liste rend : tout le formulaire sauf les octets du visuel. */
export interface BrouillonPub {
  id: string;
  nom: string;
  titre: string;
  texte: string;
  accueil: string;
  messagePreRempli: string;
  budgetTotal: string;
  debut: string;
  fin: string;
  pays: string;
  ageMin: string;
  ageMax: string;
  tagQualification: string;
  destination: DestinationPub;
  workflowId: string | null;
  /** Y a-t-il un visuel, sans le transporter : la liste ne sélectionne pas les octets, plusieurs mégaoctets
   *  par brouillon à chaque ouverture de l'écran. */
  aUnVisuel: boolean;
  creeLe: string;
  modifieLe: string;
}

/** Ce que la lecture d'un brouillon rend en plus : les octets, pour repeupler le formulaire. */
export interface BrouillonPubComplet extends BrouillonPub {
  visuel: { type: 'image/jpeg' | 'image/png'; base64: string } | null;
}

/** Ce qu'on enregistre. Aucun champ obligatoire : c'est un brouillon. */
export interface ChampsBrouillon {
  nom: string;
  titre: string;
  texte: string;
  accueil: string;
  messagePreRempli: string;
  budgetTotal: string;
  debut: string;
  fin: string;
  pays: string;
  ageMin: string;
  ageMax: string;
  tagQualification: string;
  destination: DestinationPub;
  workflowId: string | null;
  /**
   * `undefined` = ne pas toucher au visuel enregistré, `null` = l'effacer, un objet = le remplacer. L'écran
   * renvoie le formulaire entier sans relire les octets : sans le cas « ne pas toucher », chaque
   * ré-enregistrement effacerait l'image.
   */
  visuel?: { type: 'image/jpeg' | 'image/png'; base64: string } | null;
}

/** `visuel_octets` est absente de cette liste : c'est la garde (voir `BrouillonPub.aUnVisuel`). */
const COLS = `id, nom, titre, texte, accueil, message_prerempli, budget_total, debut, fin, pays,
              age_min, age_max, tag_qualification, destination, workflow_id,
              (visuel_octets is not null) as a_un_visuel, visuel_type, cree_le, modifie_le`;

interface Brut {
  id: string;
  nom: string; titre: string; texte: string; accueil: string; message_prerempli: string;
  budget_total: string; debut: string; fin: string;
  pays: string; age_min: string; age_max: string; tag_qualification: string;
  destination: string; workflow_id: string | null;
  a_un_visuel: boolean; visuel_type: string | null;
  cree_le: Date; modifie_le: Date;
}

function versBrouillon(r: Brut): BrouillonPub {
  return {
    id: r.id,
    nom: r.nom, titre: r.titre, texte: r.texte, accueil: r.accueil, messagePreRempli: r.message_prerempli,
    budgetTotal: r.budget_total, debut: r.debut, fin: r.fin,
    pays: r.pays, ageMin: r.age_min, ageMax: r.age_max, tagQualification: r.tag_qualification,
    // Le CHECK de la migration borne déjà la colonne ; ce repli n'existe que pour le typage.
    destination: r.destination === 'agent_meta' ? 'agent_meta' : 'scenario',
    workflowId: r.workflow_id,
    aUnVisuel: r.a_un_visuel,
    creeLe: r.cree_le.toISOString(),
    modifieLe: r.modifie_le.toISOString(),
  };
}

export class PgBrouillonsPubStore {
  constructor(private readonly pool: Pool) {}

  /** Les brouillons de cet espace, le plus récemment modifié d'abord. C'est l'ordre de l'écran. */
  async lister(tenantId: string): Promise<BrouillonPub[]> {
    const { rows } = await this.pool.query<Brut>(
      `select ${COLS} from pubs_brouillons where tenant_id = $1 order by modifie_le desc`,
      [tenantId],
    );
    return rows.map(versBrouillon);
  }

  /** Un brouillon avec son visuel : c'est la seule requête qui a le droit de lire les octets. */
  async lire(tenantId: string, id: string): Promise<BrouillonPubComplet | null> {
    const { rows } = await this.pool.query<Brut & { visuel_octets: Buffer | null }>(
      `select ${COLS}, visuel_octets from pubs_brouillons where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
    const r = rows[0];
    if (r === undefined) return null;
    const base = versBrouillon(r);
    const type = r.visuel_type;
    return {
      ...base,
      visuel: r.visuel_octets !== null && (type === 'image/jpeg' || type === 'image/png')
        ? { type, base64: r.visuel_octets.toString('base64') }
        : null,
    };
  }

  /** Crée un brouillon et rend son identifiant. */
  async creer(tenantId: string, c: ChampsBrouillon): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into pubs_brouillons (tenant_id, nom, titre, texte, accueil, message_prerempli,
                                    budget_total, debut, fin, pays, age_min, age_max,
                                    tag_qualification, destination, workflow_id,
                                    visuel_octets, visuel_type)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       returning id`,
      [
        tenantId, c.nom, c.titre, c.texte, c.accueil, c.messagePreRempli,
        c.budgetTotal, c.debut, c.fin, c.pays, c.ageMin, c.ageMax,
        c.tagQualification, c.destination, c.workflowId,
        // À la création, `undefined` et `null` disent la même chose : il n'y a rien à conserver.
        c.visuel ? Buffer.from(c.visuel.base64, 'base64') : null,
        c.visuel ? c.visuel.type : null,
      ],
    );
    const r = rows[0];
    if (r === undefined) throw new Error('brouillon de publicité non créé');
    return r.id;
  }

  /**
   * Met à jour un brouillon ; `false` si l'identifiant n'existe pas dans cet espace. Le visuel ne se met à jour
   * que s'il est fourni (`c.visuel !== undefined`) : sinon modifier le texte effacerait l'image.
   */
  async mettreAJour(tenantId: string, id: string, c: ChampsBrouillon): Promise<boolean> {
    const octets = c.visuel === undefined ? null : c.visuel === null ? null : Buffer.from(c.visuel.base64, 'base64');
    const { rowCount } = await this.pool.query(
      `update pubs_brouillons
          set nom = $3, titre = $4, texte = $5, accueil = $6, message_prerempli = $7,
              budget_total = $8, debut = $9, fin = $10, pays = $11, age_min = $12, age_max = $13,
              tag_qualification = $14, destination = $15, workflow_id = $16,
              visuel_octets = case when $17::boolean then $18::bytea else visuel_octets end,
              visuel_type   = case when $17::boolean then $19::text  else visuel_type   end,
              modifie_le = now()
        where tenant_id = $1 and id = $2`,
      [
        tenantId, id, c.nom, c.titre, c.texte, c.accueil, c.messagePreRempli,
        c.budgetTotal, c.debut, c.fin, c.pays, c.ageMin, c.ageMax,
        c.tagQualification, c.destination, c.workflowId,
        c.visuel !== undefined, octets, c.visuel ? c.visuel.type : null,
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Rend `false` si le brouillon n'existe pas dans cet espace : la route en fait un 404. */
  async supprimer(tenantId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'delete from pubs_brouillons where tenant_id = $1 and id = $2',
      [tenantId, id],
    );
    return (rowCount ?? 0) > 0;
  }
}
