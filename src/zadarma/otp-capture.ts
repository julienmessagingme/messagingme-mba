import { extraireCodeOtp } from './otp-extract';
import type { AppelEntrant, Transcription } from './api';

/**
 * Capture automatique du code de vérification que Meta dicte par téléphone : Meta appelle notre numéro, quelque
 * chose décroche et enregistre, Zadarma transcrit, on lit le code. Orchestration sans IO (tout est injecté).
 *
 * Rien ne garantit qu'un appel de Meta soit décroché par un répondeur : sans enregistrement, pas de code. L'échec
 * rend donc une cause distincte par étape, pour savoir quel maillon a cédé.
 */

export type CauseEchec =
  /** Aucun appel entrant nouveau : Meta n'a pas appelé, ou pas ce numéro. */
  | 'aucun_appel'
  /** L'appel est bien arrivé mais aucun enregistrement : rien n'a décroché. */
  | 'appel_non_enregistre'
  /** Enregistrement présent, mais la reconnaissance vocale n'a rien rendu d'exploitable à temps. */
  | 'transcription_indisponible'
  /** Transcription obtenue, mais aucun code à 6 chiffres certain dedans (règle d'unanimité). */
  | 'code_introuvable';

export type ResultatCapture =
  | { ok: true; code: string; callId: string; transcription: string }
  | { ok: false; cause: CauseEchec; callId?: string; transcription?: string; details?: string };

export interface CaptureDeps {
  /** Appels entrants récents (fenêtre large : c'est la différence avec l'instantané qui identifie le bon appel). */
  appelsRecents(): Promise<AppelEntrant[]>;
  /** Déclenche l'appel de Meta (`request_code` en VOICE). Appelé après l'instantané, jamais avant. */
  demanderAppel(): Promise<void>;
  demanderTranscription(callId: string): Promise<void>;
  lireTranscription(callId: string): Promise<Transcription>;
  attendre(ms: number): Promise<void>;
  maintenant(): number;
}

export interface CaptureOptions {
  /** Notre numéro, dans n'importe quel format (« +33189480136 », « 0189480136 », « 33189480136 »). */
  numero: string;
  /** Délai total avant abandon. Défaut 120 s : au-delà, l'opérateur reprend la main. */
  delaiTotalMs?: number;
  /** Intervalle entre deux relectures. Défaut 3 s : assez court pour un humain qui attend. */
  intervalleMs?: number;
}

/**
 * Deux numéros désignent-ils la même ligne ? Comparaison sur les 9 derniers chiffres : les formats se mélangent, et
 * une égalité stricte ferait rater tous les appels.
 */
export function memeNumero(a: string, b: string): boolean {
  const fin = (v: string): string => v.replace(/\D/g, '').slice(-9);
  const x = fin(a);
  return x !== '' && x === fin(b);
}

const DELAI_TOTAL_DEFAUT = 120_000;
const INTERVALLE_DEFAUT = 3_000;

export async function capturerOtp(deps: CaptureDeps, options: CaptureOptions): Promise<ResultatCapture> {
  const delaiTotal = options.delaiTotalMs ?? DELAI_TOTAL_DEFAUT;
  const intervalle = options.intervalleMs ?? INTERVALLE_DEFAUT;
  const limite = deps.maintenant() + delaiTotal;

  // 1. Instantané avant de déclencher quoi que ce soit : il distingue l'appel de Meta d'un appel antérieur, sans
  //    raisonner sur des heures. Une erreur ici remonte : aucune tentative Meta n'a encore été consommée.
  const dejaVus = new Set((await deps.appelsRecents()).map((a) => a.callId));

  await deps.demanderAppel();

  let appelVu: AppelEntrant | undefined;
  let transcriptionDemandee = false;
  let derniereTranscription: Transcription | undefined;
  let derniereErreur: string | undefined;

  while (deps.maintenant() < limite) {
    await deps.attendre(intervalle);

    // 🔴 Un hoquet réseau ne doit pas tuer la capture : `demanderAppel` a déjà consommé une des 10 tentatives que
    // Meta accorde par numéro sur 72 h. La boucle est le rejeu ; on garde la dernière erreur pour le diagnostic.
    try {
      if (!appelVu?.enregistre) {
        const nouveaux = (await deps.appelsRecents()).filter((a) => !dejaVus.has(a.callId) && memeNumero(a.destination, options.numero));
        // Le plus récent qui porte un enregistrement, à défaut n'importe lequel : pour distinguer « Meta n'a pas
        // appelé » de « rien n'a décroché ».
        appelVu = nouveaux.find((a) => a.enregistre) ?? nouveaux[0] ?? appelVu;
      }
      if (!appelVu?.enregistre) continue; // l'enregistrement n'apparaît qu'à la fin de l'appel

      if (!transcriptionDemandee) {
        await deps.demanderTranscription(appelVu.callId);
        transcriptionDemandee = true;
        continue; // la reconnaissance est asynchrone : inutile de relire dans la foulée
      }

      derniereTranscription = await deps.lireTranscription(appelVu.callId);
    } catch (err) {
      derniereErreur = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (!derniereTranscription.pret) continue;

    const code = extraireCodeOtp(derniereTranscription.texte);
    if (code) return { ok: true, code, callId: appelVu.callId, transcription: derniereTranscription.texte };
    // Transcription lisible mais sans code certain : inutile d'attendre, le texte ne changera plus.
    return { ok: false, cause: 'code_introuvable', callId: appelVu.callId, transcription: derniereTranscription.texte };
  }

  // La dernière erreur est toujours reportée : sans elle, une panne Zadarma se lirait « Meta n'a pas appelé ».
  if (!appelVu) return { ok: false, cause: 'aucun_appel', ...(derniereErreur ? { details: `dernière erreur pendant l'attente : ${derniereErreur}` } : {}) };
  if (!appelVu.enregistre) {
    return {
      ok: false,
      cause: 'appel_non_enregistre',
      callId: appelVu.callId,
      details: `appel reçu de ${appelVu.appelant} (${appelVu.etat}) mais aucun enregistrement : rien n’a décroché sur ce numéro`,
    };
  }
  return {
    ok: false,
    cause: 'transcription_indisponible',
    callId: appelVu.callId,
    details: `reconnaissance vocale non aboutie (état « ${derniereTranscription?.etat ?? 'jamais lue'} »)${derniereErreur ? `, dernière erreur : ${derniereErreur}` : ''}`,
  };
}
