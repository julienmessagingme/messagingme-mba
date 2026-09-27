import { randomBytes } from 'node:crypto';
import { reconnaitre } from '../../agent/setup/piece-jointe';
import { EXTENSIONS_FICHIER, extensionCoherente, MAX_FICHIER } from '../../http/mba';

/**
 * Les pièces jointes de la conversation du MBA : déposées ici, envoyées chez Meta seulement si le diff est
 * accepté. Le document part tel quel, sans extraction : l'index est celui de Meta (l'agent IA, lui, découpe en
 * fiches parce que l'index est le nôtre).
 * Le dépôt rend un jeton, l'application le lit et appelle `uploadFile` : le fichier entre dans le diff au lieu
 * de partir seul. Le contenu ne traverse jamais le modèle, seul le jeton.
 * Magasin en mémoire, donc local au process : à déplacer avant le multi-replica (symptôme : « document déposé
 * plus disponible »).
 */

/** Deux heures : le temps de relire un diff, jamais celui d'oublier un document et de le retrouver. */
export const DUREE_PIECE_MS = 2 * 60 * 60 * 1000;
/** Par espace. Au-delà, la plus ancienne part : un magasin non borné est une fuite mémoire dans l'API. */
export const MAX_PIECES_PAR_ESPACE = 5;
/**
 * Et une borne globale : la borne par espace plafonne par client, donc un total qui grandit avec le nombre de
 * clients dans un process à mémoire fixe. Elle évince la plus ancienne, tous espaces confondus : un dépôt perdu
 * se redépose, une API arrêtée non.
 */
export const MAX_OCTETS_MAGASIN = 64 * 1024 * 1024;

export interface PieceJointePrete {
  nom: string;
  mime: string;
  octets: Buffer;
}

export interface MagasinPiecesJointes {
  /** Range le contenu et rend le jeton à mettre dans l'opération `fichier.ajouter`. */
  deposer(tenantId: string, piece: PieceJointePrete): string;
  /** `null` = jeton inconnu, expiré, ou appartenant à un autre espace. Ne consomme pas la pièce. */
  reprendre(tenantId: string, jeton: string): { nom: string; contenu: Blob } | null;
  /** Le jeton résout-il ? Même verdict que `reprendre`, sans construire le `Blob` : contrôle fait par la route
   *  avant d'appliquer quoi que ce soit chez Meta. */
  contient(tenantId: string, jeton: string): boolean;
}

/**
 * Ce que Meta accepte, décidé sur la signature du fichier : la nature vient des octets, jamais du type déclaré
 * par le navigateur (`reconnaitre()`, partagé avec l'agent IA). Le nom ne départage que deux formes de texte :
 * Meta nomme `text/csv` et refuse `text/plain`. Ce que `reconnaitre()` ne sait pas nommer (`.doc`, `.xlsx`)
 * reste refusé ici ; l'élargir changerait ce qu'accepte la conversation de construction d'un agent IA.
 */
export function typeMetaDuContenu(octets: Buffer, nom: string): { mime: string } | { refus: string } {
  const reconnu = reconnaitre(octets);
  if (!reconnu) return { refus: refusDeType() };
  const mime = reconnu.nature === 'texte'
    ? (nom.trim().toLowerCase().endsWith('.csv') ? 'text/csv' : '')
    : reconnu.mime;
  if (mime === '' || EXTENSIONS_FICHIER[mime] === undefined) return { refus: refusDeType() };
  if (!extensionCoherente(nom, mime)) {
    return { refus: `le nom du fichier doit finir par .${EXTENSIONS_FICHIER[mime]} pour correspondre à son contenu` };
  }
  return { mime };
}

function refusDeType(): string {
  return 'format non accepté ici (PDF, Word .docx, PNG, JPEG ou CSV). '
    + 'L’onglet Documents accepte en plus les .doc et .xlsx.';
}

/** Le plafond de l'onglet Documents, importé et non recopié : deux limites feraient refuser d'un côté ce
 *  que l'autre accepte. */
export { MAX_FICHIER };

interface Rangee extends PieceJointePrete {
  tenantId: string;
  deposeeLe: number;
}

/** Le magasin en mémoire ; `maintenant` est injecté pour éprouver l'expiration sans attendre deux heures. */
export function magasinPiecesJointes(maintenant: () => number = () => Date.now()): MagasinPiecesJointes {
  const pieces = new Map<string, Rangee>();

  const purger = (): void => {
    const limite = maintenant() - DUREE_PIECE_MS;
    for (const [cle, p] of pieces) if (p.deposeeLe <= limite) pieces.delete(cle);
  };

  return {
    deposer(tenantId, piece) {
      purger();
      // 🔴 La borne est par espace : un espace bavard ne doit pas faire perdre sa pièce à un autre.
      const siens = [...pieces.entries()].filter(([, p]) => p.tenantId === tenantId);
      for (const [cle] of siens.sort((a, b) => a[1].deposeeLe - b[1].deposeeLe).slice(0, Math.max(0, siens.length - (MAX_PIECES_PAR_ESPACE - 1)))) {
        pieces.delete(cle);
      }
      const jeton = randomBytes(16).toString('hex');
      pieces.set(`${tenantId}\n${jeton}`, { ...piece, tenantId, deposeeLe: maintenant() });
      /**
       * La borne globale se pose après l'insertion, sur le total réel : posée avant, elle laisserait passer le dépôt
       * qui fait déborder.
       */
      let total = [...pieces.values()].reduce((n, x) => n + x.octets.length, 0);
      for (const [cle, x] of [...pieces.entries()].sort((u, v) => u[1].deposeeLe - v[1].deposeeLe)) {
        if (total <= MAX_OCTETS_MAGASIN) break;
        // Jamais celle qu'on vient de ranger : l'évincer rendrait un jeton mort dans la seconde.
        if (cle === `${tenantId}\n${jeton}`) continue;
        pieces.delete(cle);
        total -= x.octets.length;
      }
      return jeton;
    },
    contient(tenantId, jeton) {
      purger();
      return pieces.has(`${tenantId}
${jeton}`);
    },
    reprendre(tenantId, jeton) {
      purger();
      // 🔴 La clé porte l'espace : un jeton deviné ne sert à rien s'il n'est pas présenté par le sien.
      const p = pieces.get(`${tenantId}\n${jeton}`);
      if (!p) return null;
      /**
       * On ne consomme pas : `appliquer` s'arrête à la première erreur, et le client réessaie le même diff. Copie en
       * `Uint8Array` : un `Buffer` peut être une vue sur un tampon partagé, que le type de `Blob` refuse.
       */
      return { nom: p.nom, contenu: new Blob([new Uint8Array(p.octets)], { type: p.mime }) };
    },
  };
}
