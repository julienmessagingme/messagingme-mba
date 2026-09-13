import { transcrire, TranscriptionError } from '../agent/llm/transcription';
import { MediaTropGros } from '../meta/media';
import type { HttpTransport } from '../meta/http';
import type { LangueConsole } from '../traduction/traduire';

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
  /**
   * La langue dans laquelle le vocal a été DIT (migration 0137).
   *
   * ⚠️ Elle évite un second appel payé pour rien : un vocal déjà en français n'a rien à traduire pour
   * un lecteur francophone. Absente sur les transcriptions d'avant la migration, et c'est sans
   * conséquence : on traduira, ce qui est le comportement d'avant.
   */
  transcriptionLangue?: string | null;
  /** Une traduction DÉJÀ rangée pour ce message, et sa langue : on la relit au lieu de la repayer. */
  traduction?: string | null;
  traductionLangue?: string | null;
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
  /**
   * ⚠️ `langue` EST LE CINQUIÈME PARAMÈTRE, et l'oublier au câblage compilerait quand même : une
   * flèche à quatre paramètres reste assignable à un contrat qui en déclare cinq, et la langue
   * partirait en silence. C'est le piège que ce dépôt connaît et qu'il a déjà payé.
   */
  ecrireTranscription(tenantId: string, messageId: string, texte: string, modele: string, langue: string | null): Promise<void>;
  /**
   * TRADUIT la transcription vers la langue du lecteur. Absente -> aucune traduction, jamais d'erreur.
   *
   * 🔴 ON NE TRADUIT PAS `body` : pour un vocal il vaut `[audio]` ou la légende, donc le traduire ne
   * produirait rien tout en coûtant un appel. La source est la TRANSCRIPTION, c'est-à-dire ce qui a
   * réellement été dit.
   */
  traduire?(tenantId: string, texte: string, cible: string, source?: string | null): Promise<{ texte: string; langueSource: string | null } | null>;
  /** Range la traduction À CÔTÉ du message, comme pour un message texte. Absente -> on ne range rien. */
  rangerTraduction?(tenantId: string, messageId: string, texte: string, langue: LangueConsole): Promise<void>;
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
export interface VocalLu {
  /** Ce qui a été DIT, dans la langue où ça a été dit. Jamais remplacé par la traduction. */
  texte: string;
  /** Le message était DÉJÀ transcrit : aucun appel de transcription n'a été payé. */
  deja: boolean;
  /** La langue détectée du vocal, quand le modèle la rend (migration 0137). */
  langue: string | null;
  /** NOTRE lecture de la transcription, dans la langue du lecteur. `null` = rien n'a été demandé, ou rien n'a abouti. */
  traduction: string | null;
}

/**
 * TRANSCRIRE, PUIS TRADUIRE, EN UN SEUL GESTE POUR L'OPÉRATEUR (2026-09-12).
 *
 * 🔴 L'ORDRE EST IMPOSÉ, ET ON NE SE SERT PAS DU MODE « TRADUIRE » DES API DE TRANSCRIPTION. Celui-ci
 * ne cible que l'anglais : s'en servir donnerait un résultat différent selon que l'opérateur travaille
 * en français ou en anglais, et surtout il DÉTRUIRAIT l'original. On transcrit fidèlement, puis on
 * traduit la transcription. Deux appels, donc deux fois le coût, et c'est assumé.
 *
 * ⚠️ PAS DE FONCTION `transcrireEtTraduire` SÉPARÉE, contrairement à ce que le plan annonçait : elle
 * aurait dû recopier l'idempotence, le contrôle de taille et la lecture du mime, c'est-à-dire tout ce
 * fichier, pour ajouter un appel. La traduction est un PARAMÈTRE du même geste, et `cible` absente
 * rend exactement le comportement d'avant.
 */
export async function transcrireMessage(
  deps: DepsTranscrire,
  tenantId: string,
  messageId: string,
  conversationId?: string,
  /** La langue du LECTEUR. `null` / absente = la traduction est éteinte, rien n'est appelé ni rangé. */
  cible?: LangueConsole | null,
): Promise<VocalLu> {
  const msg = await deps.lireMessage(tenantId, messageId, conversationId);
  if (!msg) throw new RienATranscrire();

  // DÉJÀ TRANSCRIT : on rend l'existant sans repayer la seconde d'audio... mais on traduit quand même
  // si on ne l'a pas encore fait dans cette langue. Les deux appels sont indépendants, et le second
  // peut être demandé longtemps après le premier (par un collègue qui ne lit pas la même langue).
  if (msg.transcription !== null && msg.transcription !== '') {
    const langue = msg.transcriptionLangue ?? null;
    return { texte: msg.transcription, deja: true, langue, traduction: await lire(deps, tenantId, msg, msg.transcription, langue, cible) };
  }
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
  // ⚠️ LA LANGUE PART AVEC, depuis la migration 0137 : elle était rendue et jetée, et sans elle il
  // faudrait un appel de détection pour savoir s'il y a quelque chose à traduire.
  await deps.ecrireTranscription(tenantId, messageId, r.texte, deps.modele, r.langue);
  deps.noterCout?.(tenantId, messageId, r.coutDollars, r.secondes);
  return { texte: r.texte, deja: false, langue: r.langue, traduction: await lire(deps, tenantId, msg, r.texte, r.langue, cible) };
}

/**
 * NOTRE LECTURE de ce qui a été dit, ou `null`.
 *
 * 🔴 LA SOURCE EST LA TRANSCRIPTION, JAMAIS `body` : pour un vocal, `body` vaut `[audio]` ou la
 * légende. Le traduire ne produirait rien et coûterait quand même un appel.
 *
 * Trois façons de ne RIEN payer, et chacune est un cas réel :
 *   - la traduction est éteinte (`cible` absente) ;
 *   - une traduction est DÉJÀ rangée dans cette langue (un collègue est passé avant) ;
 *   - le vocal est déjà DANS la langue du lecteur, ce que la langue détectée nous dit sans appel.
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

export { TranscriptionError, MediaTropGros };
