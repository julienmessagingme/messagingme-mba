import { transcrire, TranscriptionError } from '../agent/llm/transcription';
import { MediaExpire, estMediaExpireChezMeta } from './media-entrant';
import type { HttpTransport } from '../meta/http';
import type { LangueConsole } from '../traduction/traduire';

/**
 * Transcrire le vocal d'un message, à la demande de l'opérateur : il peut l'écouter ou le faire transcrire, et
 * transcrire tout ferait payer un service que personne n'a demandé. L'agent, lui, ne sait pas écouter : sa
 * transcription est automatique, sur un autre chemin qui ne partage que ce module.
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
  /** Le vocal a-t-il dépassé le délai de Meta (sept jours) ? Absent vaut « non », Meta le dira (`100/33`). */
  mediaExpire?: boolean;
  /** Déjà transcrit ? On rend l'existant sans repayer. */
  transcription: string | null;
  /**
   * La langue dans laquelle le vocal a été dit : évite de payer la traduction d'un vocal déjà dans la langue du
   * lecteur. Absente sur les anciennes transcriptions : on traduit.
   */
  transcriptionLangue?: string | null;
  /** Une traduction déjà rangée pour ce message, et sa langue : on la relit au lieu de la repayer. */
  traduction?: string | null;
  traductionLangue?: string | null;
}

export interface DepsTranscrire {
  /**
   * 🔴 Le message, relu dans l'espace appelant : c'est là que se joue l'isolation entre clients.
   * `conversationId` n'ajoute aucune isolation, il empêche seulement l'URL de viser une autre conversation.
   */
  lireMessage(tenantId: string, messageId: string, conversationId?: string): Promise<MessageATranscrire | null>;
  /**
   * `langue` est le cinquième paramètre : une flèche à quatre paramètres reste assignable à ce contrat, et la
   * langue partirait en silence si le câblage l'oubliait.
   */
  ecrireTranscription(tenantId: string, messageId: string, texte: string, modele: string, langue: string | null): Promise<void>;
  /**
   * Traduit la transcription vers la langue du lecteur. Absente -> aucune traduction, jamais d'erreur. La
   * source est la transcription, jamais `body` (qui vaut `[audio]` ou la légende pour un vocal).
   */
  traduire?(tenantId: string, texte: string, cible: string, source?: string | null): Promise<{ texte: string; langueSource: string | null } | null>;
  /** Range la traduction à côté du message, comme pour un message texte. Absente -> on ne range rien. */
  rangerTraduction?(tenantId: string, messageId: string, texte: string, langue: LangueConsole): Promise<void>;
  telecharger(mediaId: string, tailleMaxOctets: number): Promise<{ bytes: Buffer; mime: string | null }>;
  transport: HttpTransport;
  /** Ce que cet appel a coûté, en dollars : la clé maison paie, ce chiffre dira s'il faut refacturer. */
  noterCout?(tenantId: string, messageId: string, coutDollars: number | null, secondes: number | null): void;
  /**
   * La clé qui paie la transcription : la clé maison, rien n'est débité au client. Le jour où ça change, c'est
   * le seul endroit à toucher (`PgCleGatewayStore.lire` résout déjà par espace).
   */
  cle: string;
  modele: string;
  tailleMaxOctets: number;
}

export interface VocalLu {
  /** Ce qui a été dit, dans la langue où ça a été dit. Jamais remplacé par la traduction. */
  texte: string;
  /** Le message était déjà transcrit : aucun appel de transcription n'a été payé. */
  deja: boolean;
  /** La langue détectée du vocal, quand le modèle la rend. */
  langue: string | null;
  /** Notre lecture de la transcription, dans la langue du lecteur. `null` = rien demandé, ou rien n'a abouti. */
  traduction: string | null;
}

/**
 * Transcrire, puis traduire, en un seul geste pour l'opérateur.
 *
 * Idempotent : un message déjà transcrit rend son texte sans rappeler le modèle (deux clics ne paient pas deux
 * fois et ne remplacent pas le texte lu par une variante). Le mime vient du message, le téléchargement ne fait
 * que le compléter : l'API exige un `mediaType`, et un mime faux fait échouer l'appel après l'avoir payé.
 *
 * On n'utilise pas le mode « traduire » des API de transcription : il ne cible que l'anglais et détruit
 * l'original. On transcrit fidèlement, puis on traduit la transcription (deux appels, assumé).
 */
export async function transcrireMessage(
  deps: DepsTranscrire,
  tenantId: string,
  messageId: string,
  conversationId?: string,
  /** La langue du lecteur. `null` / absente = traduction éteinte, rien n'est appelé ni rangé. */
  cible?: LangueConsole | null,
): Promise<VocalLu> {
  const msg = await deps.lireMessage(tenantId, messageId, conversationId);
  if (!msg) throw new RienATranscrire();

  // Déjà transcrit : on rend l'existant sans repayer, mais on traduit si ce n'est pas encore fait dans cette
  // langue (un collègue peut le demander bien après).
  if (msg.transcription !== null && msg.transcription !== '') {
    const langue = msg.transcriptionLangue ?? null;
    return { texte: msg.transcription, deja: true, langue, traduction: await lire(deps, tenantId, msg, msg.transcription, langue, cible) };
  }
  if (!msg.mediaId) throw new RienATranscrire();
  // Après le cas « déjà transcrit » : une transcription faite quand le vocal existait se relit pour toujours.
  if (msg.mediaExpire === true) throw new MediaExpire();

  const fichier = await deps.telecharger(msg.mediaId, deps.tailleMaxOctets).catch((err: unknown) => {
    throw estMediaExpireChezMeta(err) ? new MediaExpire() : err;
  });
  const mime = msg.mediaMime ?? fichier.mime;
  if (!mime) throw new TranscriptionError(null, 'type de media inconnu');

  const r = await transcrire(deps.transport, {
    cle: deps.cle,
    modele: deps.modele,
    bytes: fichier.bytes,
    // WhatsApp annonce `audio/ogg; codecs=opus` : le paramètre après le point-virgule a été refusé par des
    // fournisseurs, on ne garde que le type.
    mime: mime.split(';')[0]!.trim(),
  });
  // Écrit avant de rendre : un appel payé dont le résultat n'est pas enregistré serait repayé au clic suivant.
  // La langue part avec, sinon il faudrait un appel de détection pour savoir s'il y a à traduire.
  await deps.ecrireTranscription(tenantId, messageId, r.texte, deps.modele, r.langue);
  deps.noterCout?.(tenantId, messageId, r.coutDollars, r.secondes);
  return { texte: r.texte, deja: false, langue: r.langue, traduction: await lire(deps, tenantId, msg, r.texte, r.langue, cible) };
}

/**
 * Notre lecture de ce qui a été dit, ou `null`. Trois façons de ne rien payer : traduction éteinte, traduction
 * déjà rangée dans cette langue, ou vocal déjà dans la langue du lecteur (la langue détectée le dit sans appel).
 */
async function lire(
  deps: DepsTranscrire,
  tenantId: string,
  msg: MessageATranscrire,
  transcription: string,
  langue: string | null,
  cible?: LangueConsole | null,
): Promise<string | null> {
  if (!cible || !deps.traduire) return null;
  const deja = msg.traduction?.trim();
  if (deja && msg.traductionLangue === cible) return msg.traduction!;
  // Déjà dans la langue du lecteur : il n'y a rien à traduire, et ce n'est pas un échec. Rendre la
  // transcription ici ferait afficher deux fois le même texte, l'un présenté comme une traduction.
  if (langue !== null && langue.trim().toLowerCase().slice(0, 2) === cible) return null;
  const r = await deps.traduire(tenantId, transcription, cible, langue);
  if (r === null) return null;
  // Rangée pour que le prochain lecteur ne la repaie pas. Best-effort : la lecture est déjà acquise,
  // et un échec d'écriture ne doit pas priver l'opérateur de ce qui vient d'être payé.
  await deps.rangerTraduction?.(tenantId, msg.id, r.texte, cible).catch(() => {});
  return r.texte;
}
