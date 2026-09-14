import { randomBytes } from 'node:crypto';
import { reconnaitre } from '../../agent/setup/piece-jointe';
import { EXTENSIONS_FICHIER, extensionCoherente, MAX_FICHIER } from '../../http/mba';

/**
 * LES PIÈCES JOINTES DE LA CONVERSATION DU MBA : déposées ici, envoyées chez Meta SEULEMENT si le diff est
 * accepté.
 *
 * 🔴 LE DOCUMENT PART CHEZ META TEL QUEL, SANS EXTRACTION. Asymétrie assumée avec l'agent IA, où un document
 * est découpé en fiches (`src/agent/setup/piece-jointe.ts`). La raison est la DESTINATION : là-bas l'index
 * est le nôtre et le découpage est obligatoire (un document entier dans une fiche unique contient tous les
 * mots du métier et rend la garde anti-hallucination inopérante) ; ici, l'index est celui de Meta.
 *
 * 🔴 LE FICHIER ENTRE DANS LE DIFF, IL NE PART PAS TOUT SEUL. Le dépôt range le contenu ici et rend un JETON ;
 * l'application lit le jeton et appelle `uploadFile`. Sans ce détour, le dépôt serait le seul geste de la
 * conversation qu'on ne pourrait pas relire avant qu'il agisse, alors qu'il écrit chez Meta comme les autres.
 *
 * 🔴 LE CONTENU NE TRAVERSE JAMAIS LE MODÈLE. Le jeton, oui ; les octets, non. C'est ce qui permet d'accepter
 * un document de 20 Mo sans le faire payer au tour de conversation, et ce qui empêche un document hostile
 * d'orienter la proposition.
 *
 * ⚠️ LE MAGASIN EST EN MÉMOIRE, DONC LOCAL AU PROCESS, comme les plafonds de débit. Aujourd'hui l'API tourne
 * en une instance et le dépôt comme l'application arrivent sur elle. Le jour du multi-replica, ce magasin est
 * l'une des choses à déplacer, et le symptôme serait lisible : « document déposé plus disponible ».
 */

/** Deux heures : le temps de relire un diff, jamais celui d'oublier un document et de le retrouver. */
export const DUREE_PIECE_MS = 2 * 60 * 60 * 1000;
/** Par espace. Au-delà, la plus ancienne part : un magasin non borné est une fuite mémoire dans l'API. */
export const MAX_PIECES_PAR_ESPACE = 5;
/**
 * 🔴 ET UNE BORNE GLOBALE, parce que la borne par espace ne borne RIEN : elle plafonne 5 x 20 Mo PAR CLIENT,
 * donc un total qui grandit avec le nombre de clients, dans un process dont la mémoire, elle, ne grandit pas.
 * C'est le motif « une limite qui a l'air d'en être une ».
 *
 * ⚠️ ELLE ÉVINCE LA PLUS ANCIENNE, TOUS ESPACES CONFONDUS, et c'est assumé : entre faire perdre un dépôt
 * vieux de deux heures et arrêter l'API, le premier a un symptôme lisible et un geste de réparation évident
 * (« redéposez-le »).
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
  /** `null` = jeton inconnu, expiré, ou appartenant à un AUTRE espace. Ne consomme pas la pièce. */
  reprendre(tenantId: string, jeton: string): { nom: string; contenu: Blob } | null;
  /** Le jeton résout-il ? Même verdict que `reprendre`, sans construire le `Blob` : c'est le contrôle que la
   *  route fait AVANT d'appliquer quoi que ce soit chez Meta. */
  contient(tenantId: string, jeton: string): boolean;
}

/**
 * CE QUE META ACCEPTE, DÉCIDÉ SUR LA SIGNATURE DU FICHIER.
 *
 * 🔴 LA NATURE VIENT DES OCTETS, jamais du type que le navigateur déclare : même doctrine que
 * `src/rcs/image.ts` et que la pièce jointe de l'agent IA, dont `reconnaitre()` est réutilisé tel quel.
 *
 * ⚠️ LE NOM NE DÉCIDE QUE D'UNE CHOSE, et seulement entre deux formes de TEXTE : Meta nomme `text/csv` et
 * refuse `text/plain`. La signature dit « c'est du texte, pas un binaire déguisé » ; l'extension `.csv` dit
 * lequel des deux textes on déclare. Un fichier qui ment sur sa nature est refusé avant ce point.
 *
 * ⚠️ CE QUE `reconnaitre()` NE SAIT PAS NOMMER RESTE REFUSÉ ICI (`.doc`, `.xlsx`), et le message le dit :
 * l'onglet Documents, lui, les accepte. Élargir `reconnaitre()` pour eux changerait ce que la conversation de
 * construction d'un agent IA accepte, alors qu'elle ne sait en extraire aucun texte.
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

/** Le plafond est celui de l'onglet Documents, importé et non recopié : deux limites différentes feraient
 *  qu'un fichier accepté par la conversation serait refusé par l'écran, ou l'inverse. */
export { MAX_FICHIER };

interface Rangee extends PieceJointePrete {
  tenantId: string;
  deposeeLe: number;
}

/**
 * Le magasin en mémoire.
 *
 * `maintenant` est injecté pour que l'expiration s'éprouve sans attendre deux heures.
 */
export function magasinPiecesJointes(maintenant: () => number = () => Date.now()): MagasinPiecesJointes {
  const pieces = new Map<string, Rangee>();

  const purger = (): void => {
    const limite = maintenant() - DUREE_PIECE_MS;
    for (const [cle, p] of pieces) if (p.deposeeLe <= limite) pieces.delete(cle);
  };

  return {
    deposer(tenantId, piece) {
      purger();
      // 🔴 La borne est PAR ESPACE : un espace bavard ne doit pas faire perdre sa pièce à un autre.
      const siens = [...pieces.entries()].filter(([, p]) => p.tenantId === tenantId);
      for (const [cle] of siens.sort((a, b) => a[1].deposeeLe - b[1].deposeeLe).slice(0, Math.max(0, siens.length - (MAX_PIECES_PAR_ESPACE - 1)))) {
        pieces.delete(cle);
      }
      const jeton = randomBytes(16).toString('hex');
      pieces.set(`${tenantId}\n${jeton}`, { ...piece, tenantId, deposeeLe: maintenant() });
      /**
       * La borne globale se pose APRÈS l'insertion, sur le total réel. La poser avant, sur une
       * estimation, laisserait passer le dépôt qui fait justement déborder, c'est-à-dire le seul qui
       * compte.
       */
      let total = [...pieces.values()].reduce((n, x) => n + x.octets.length, 0);
      for (const [cle, x] of [...pieces.entries()].sort((u, v) => u[1].deposeeLe - v[1].deposeeLe)) {
        if (total <= MAX_OCTETS_MAGASIN) break;
        // ⚠️ Jamais celle qu'on vient de ranger : l'évincer rendrait un jeton mort dans la seconde.
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
      // ⚠️ LA CLÉ PORTE L'ESPACE : un jeton deviné ne sert à rien s'il n'est pas présenté par le sien.
      const p = pieces.get(`${tenantId}\n${jeton}`);
      if (!p) return null;
      /**
       * ⚠️ ON NE CONSOMME PAS. `appliquer` s'arrête à la première erreur : si Meta nous demande de ralentir
       * pile sur ce dépôt, le client réessaie le même diff. Consommer ici rendrait la seconde tentative
       * impossible, et le message parlerait d'un document « plus disponible » qu'on vient de déposer.
       */
      // ⚠️ `new Uint8Array(...)` plutôt que le `Buffer` tel quel : un `Buffer` peut être une VUE sur un
      // tampon partagé, ce que le type de `Blob` refuse. La copie est faite une fois, à l'application.
      return { nom: p.nom, contenu: new Blob([new Uint8Array(p.octets)], { type: p.mime }) };
    },
  };
}
