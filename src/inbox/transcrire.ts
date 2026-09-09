import { transcrire, TranscriptionError } from '../agent/llm/transcription';
import { MediaTropGros } from '../meta/media';
import type { HttpTransport } from '../meta/http';

/**
 * TRANSCRIRE le vocal d'un message, à la demande (2026-09-09, demande de Julien).
 *
 * 🔴 À LA DEMANDE, ET C'EST LUI QUI L'A TRANCHÉ : « il faut qu'il ait le choix quand il récupère un vocal,
 * soit l'écouter avec un petit bouton lecture, soit le demander à transcrire ». Ce choix vaut mieux qu'un
 * automatisme, et pas seulement pour le coût : neuf fois sur dix un opérateur écoute, c'est plus rapide que
 * de lire. Transcrire tout ferait payer un service que personne n'a demandé.
 *
 * ⚠️ Le chemin de l'AGENT est différent et n'est pas ici : lui ne sait pas écouter (aucun des neuf modèles
 * proposables n'accepte l'audio, vérifié dans le catalogue), donc pour lui la transcription est automatique
 * et obligatoire. Les deux ne partagent que ce module.
 */

/** Un message sans vocal à transcrire. Distinct d'une panne : il n'y a rien à faire, pas quelque chose de cassé. */
export class RienATranscrire extends Error {
  constructor() {
    super('ce message ne porte aucun media a transcrire');
    this.name = 'RienATranscrire';
  }
}

export interface MessageATranscrire {
  id: string;
  mediaId: string | null;
  mediaMime: string | null;
  /** Déjà transcrit ? On rend l'existant sans repayer. */
  transcription: string | null;
}

export interface DepsTranscrire {
  /**
   * Le message, RELU dans l'espace appelant : c'est là que se joue l'isolation entre clients.
   *
   * ⚠️ `conversationId` s'y ajoute quand la route en nomme une : elle n'apporte AUCUNE isolation
   * supplémentaire (le filtre d'espace la porte entièrement), elle empêche seulement l'URL de mentir en
   * transcrivant le message d'une autre conversation du même espace.
   */
  lireMessage(tenantId: string, messageId: string, conversationId?: string): Promise<MessageATranscrire | null>;
  ecrireTranscription(tenantId: string, messageId: string, texte: string, modele: string): Promise<void>;
  telecharger(mediaId: string, tailleMaxOctets: number): Promise<{ bytes: Buffer; mime: string | null }>;
  transport: HttpTransport;
  /**
   * Ce que CET appel a coûté, en dollars.
   *
   * ⚠️ Le coût était LU (`providerMetadata.gateway.cost`) puis JETÉ. Julien a décidé que la clé maison paie,
   * donc rien n'est débité au client ; mais sans trace, « combien nous coûte la transcription » est une
   * question sans réponse, et c'est exactement le chiffre qui décidera de la refacturer ou non.
   */
  noterCout?(tenantId: string, messageId: string, coutDollars: number | null, secondes: number | null): void;
  /**
   * La clé qui PAIE la transcription.
   *
   * ⚠️ La clé MAISON pour l'instant, décision de Julien du 2026-09-09 : « on va le payer nous-mêmes sur la
   * clé API générale, et on verra après si je la refacture au client ». Le jour où ça change, c'est le seul
   * endroit à toucher, et le résolveur par espace existe déjà (`PgCleGatewayStore.lire`).
   */
  cle: string;
  modele: string;
  tailleMaxOctets: number;
}

/**
 * ⚠️ IDEMPOTENT : un message déjà transcrit rend son texte SANS rappeler le modèle. Sans ça, deux clics sur
 * le bouton (ou deux opérateurs sur la même conversation) paieraient deux fois la même seconde d'audio, et
 * la seconde transcription écraserait la première par une variante légèrement différente, ce qui ferait
 * douter de celle qu'on venait de lire.
 *
 * ⚠️ LE MIME VIENT DU MESSAGE, ET LE TÉLÉCHARGEMENT NE FAIT QUE LE COMPLÉTER. L'API de transcription EXIGE
 * un `mediaType` : le déduire de l'extension n'a pas de sens ici (il n'y a pas de nom de fichier), et un
 * mime faux fait échouer l'appel après l'avoir payé.
 */
export async function transcrireMessage(deps: DepsTranscrire, tenantId: string, messageId: string, conversationId?: string): Promise<{ texte: string; deja: boolean }> {
  const msg = await deps.lireMessage(tenantId, messageId, conversationId);
  if (!msg) throw new RienATranscrire();
  if (msg.transcription !== null && msg.transcription !== '') return { texte: msg.transcription, deja: true };
  if (!msg.mediaId) throw new RienATranscrire();

  const fichier = await deps.telecharger(msg.mediaId, deps.tailleMaxOctets);
  const mime = msg.mediaMime ?? fichier.mime;
  if (!mime) throw new TranscriptionError(null, 'type de media inconnu');

  const r = await transcrire(deps.transport, {
    cle: deps.cle,
    modele: deps.modele,
    bytes: fichier.bytes,
    // WhatsApp annonce `audio/ogg; codecs=opus` : le paramètre après le point-virgule n'est pas un type, et
    // le passer tel quel a été refusé par des fournisseurs. On ne garde que le type.
    mime: mime.split(';')[0]!.trim(),
  });
  // ⚠️ ÉCRIT AVANT DE RENDRE, et l'ordre compte : un appel payé dont le résultat n'est pas enregistré serait
  // repayé au clic suivant, indéfiniment.
  await deps.ecrireTranscription(tenantId, messageId, r.texte, deps.modele);
  deps.noterCout?.(tenantId, messageId, r.coutDollars, r.secondes);
  return { texte: r.texte, deja: false };
}

export { TranscriptionError, MediaTropGros };
