import type { Pool } from 'pg';
import type { DestinationPub } from './routage';
import { BOUTON_PUB_DEFAUT, estBoutonPub, type BoutonPub } from '../meta/pubs-payloads';

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
  /**
   * L'identifiant chez Meta de la vidéo déposée (migration 0187), jamais ses octets. Exclusif du visuel image :
   * poser l'un efface l'autre.
   */
  videoId: string | null;
  /** Les audiences du compte publicitaire retenues, par identifiant Meta, relues chez Meta à la création. */
  audiencesIncluses: string[];
  audiencesExclues: string[];
  /**
   * Le bouton choisi (migration 0188). Une valeur que la liste ne connaît plus (retirée après l'essai réel) se
   * relit comme le bouton par défaut : un brouillon ne dépense rien, et l'écran montre ce qui partira.
   */
  bouton: BoutonPub;
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
  /**
   * Même règle à trois sens pour la vidéo : `undefined` = ne pas y toucher, `null` = l'effacer, un objet = la
   * remplacer. 🔴 Poser une vidéo EFFACE l'image, et poser une image efface la vidéo : un brouillon porte un seul
   * visuel (le CHECK de 0187 en est la ceinture). La route refuse un corps qui poserait les deux.
   */
  video?: { id: string } | null;
  /** `undefined` = ne pas toucher : un écran qui ne connaît pas encore les audiences ne les efface pas. */
  audiencesIncluses?: string[];
  audiencesExclues?: string[];
  /**
   * `undefined` = ne pas toucher, même règle : l'écran ne l'envoie que s'il diffère de ce que le serveur détient,
   * pour qu'une API d'avant 0188 (qui refuse toute clé inconnue) reste utilisable tant qu'on garde le défaut. Un
   * bouton ne s'efface pas, il se remplace : pas de troisième sens.
   */
  bouton?: BoutonPub;
}

/** `visuel_octets` est absente de cette liste : c'est la garde (voir `BrouillonPub.aUnVisuel`). */
const COLS = `id, nom, titre, texte, accueil, message_prerempli, budget_total, debut, fin, pays,
              age_min, age_max, tag_qualification, destination, workflow_id,
              (visuel_octets is not null) as a_un_visuel, visuel_type,
              video_id, audiences_incluses, audiences_exclues, bouton, cree_le, modifie_le`;

interface Brut {
  id: string;
  nom: string; titre: string; texte: string; accueil: string; message_prerempli: string;
  budget_total: string; debut: string; fin: string;
  pays: string; age_min: string; age_max: string; tag_qualification: string;
  destination: string; workflow_id: string | null;
  a_un_visuel: boolean; visuel_type: string | null;
  video_id: string | null; audiences_incluses: string[]; audiences_exclues: string[];
  bouton: string;
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
    videoId: r.video_id,
    audiencesIncluses: r.audiences_incluses,
    audiencesExclues: r.audiences_exclues,
    bouton: estBoutonPub(r.bouton) ? r.bouton : BOUTON_PUB_DEFAUT,
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
                                    visuel_octets, visuel_type, video_id,
                                    audiences_incluses, audiences_exclues, bouton)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19::text[], $20::text[], $21)
       returning id`,
      [
        tenantId, c.nom, c.titre, c.texte, c.accueil, c.messagePreRempli,
        c.budgetTotal, c.debut, c.fin, c.pays, c.ageMin, c.ageMax,
        c.tagQualification, c.destination, c.workflowId,
        // À la création, `undefined` et `null` disent la même chose : il n'y a rien à conserver. Une vidéo
        // l'emporte sur une image, comme à la mise à jour (la route refuse de recevoir les deux).
        c.visuel && !c.video ? Buffer.from(c.visuel.base64, 'base64') : null,
        c.visuel && !c.video ? c.visuel.type : null,
        c.video ? c.video.id : null,
        c.audiencesIncluses ?? [], c.audiencesExclues ?? [],
        c.bouton ?? BOUTON_PUB_DEFAUT,
      ],
    );
    const r = rows[0];
    if (r === undefined) throw new Error('brouillon de publicité non créé');
    return r.id;
  }

  /**
   * Met à jour un brouillon ; `false` si l'identifiant n'existe pas dans cet espace. Le visuel ne se met à jour
   * que s'il est fourni (`c.visuel !== undefined`) : sinon modifier le texte effacerait l'image. Même règle pour
   * la vidéo et les audiences.
   *
   * 🔴 L'EXCLUSIVITÉ SE TIENT ICI, EN ÉCRIVANT : une image POSÉE (non nulle) efface la vidéo, une vidéo POSÉE
   * efface l'image. Sans ça, choisir une vidéo sur un brouillon qui portait une image (clé `image` absente, donc
   * « ne pas toucher ») violerait le CHECK de 0187 et rendrait une erreur au lieu d'un enregistrement.
   */
  async mettreAJour(tenantId: string, id: string, c: ChampsBrouillon): Promise<boolean> {
    const octets = c.visuel === undefined ? null : c.visuel === null ? null : Buffer.from(c.visuel.base64, 'base64');
    const { rowCount } = await this.pool.query(
      `update pubs_brouillons
          set nom = $3, titre = $4, texte = $5, accueil = $6, message_prerempli = $7,
              budget_total = $8, debut = $9, fin = $10, pays = $11, age_min = $12, age_max = $13,
              tag_qualification = $14, destination = $15, workflow_id = $16,
              visuel_octets = case when $17::boolean then $18::bytea when $21::boolean then null else visuel_octets end,
              visuel_type   = case when $17::boolean then $19::text  when $21::boolean then null else visuel_type   end,
              video_id      = case when $20::boolean then $22::text  when $23::boolean then null else video_id      end,
              audiences_incluses = case when $24::boolean then $25::text[] else audiences_incluses end,
              audiences_exclues  = case when $26::boolean then $27::text[] else audiences_exclues  end,
              bouton             = coalesce($28::text, bouton),
              modifie_le = now()
        where tenant_id = $1 and id = $2`,
      [
        tenantId, id, c.nom, c.titre, c.texte, c.accueil, c.messagePreRempli,
        c.budgetTotal, c.debut, c.fin, c.pays, c.ageMin, c.ageMax,
        c.tagQualification, c.destination, c.workflowId,
        c.visuel !== undefined, octets, c.visuel ? c.visuel.type : null,
        // $20 : la vidéo est-elle fournie ; $21 : une vidéo est-elle POSÉE, auquel cas elle efface l'image.
        c.video !== undefined, c.video !== undefined && c.video !== null,
        c.video ? c.video.id : null,
        // $23 : une image est-elle POSÉE, auquel cas elle efface la vidéo.
        c.visuel !== undefined && c.visuel !== null,
        c.audiencesIncluses !== undefined, c.audiencesIncluses ?? [],
        c.audiencesExclues !== undefined, c.audiencesExclues ?? [],
        // $28 : `null` = ne pas toucher (clé absente du corps).
        c.bouton ?? null,
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
