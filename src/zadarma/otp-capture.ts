import { extraireCodeOtp } from './otp-extract';
import type { AppelEntrant, Transcription } from './api';

/**
 * Capture automatique du code de vérification que Meta dicte par téléphone.
 *
 * L'enchaînement réel est : Meta appelle NOTRE numéro -> quelque chose décroche et enregistre -> Zadarma
 * transcrit -> on lit le code. Cette fonction orchestre ces étapes SANS IO (tout est injecté), pour qu'elle
 * soit éprouvable de bout en bout sans téléphoner à qui que ce soit.
 *
 * 🔴 CE QUI N'EST PAS ACQUIS, et que ce module rend mesurable plutôt que de le masquer : la documentation de
 * Meta dit qu'un appel de vérification « ne sait pas naviguer dans un serveur vocal », et le comportement
 * face à un répondeur n'est documenté nulle part. Si rien ne décroche, il n'y a pas d'enregistrement, donc
 * pas de transcription, donc pas de code. C'est pourquoi l'échec est rendu avec une CAUSE distincte par
 * étape : au premier essai réel, la cause dit exactement lequel des maillons a cédé, au lieu d'un « ça n'a
 * pas marché » qu'il faudrait rejouer pour comprendre.
 */

export type CauseEchec =
  /** Aucun appel entrant nouveau : Meta n'a pas appelé, ou pas ce numéro. */
  | 'aucun_appel'
  /** L'appel est bien arrivé mais aucun enregistrement : RIEN N'A DÉCROCHÉ (le point dur du pilote). */
  | 'appel_non_enregistre'
  /** Enregistrement présent, mais la reconnaissance vocale n'a rien rendu d'exploitable à temps. */
  | 'transcription_indisponible'
  /** Transcription obtenue, mais aucun code à 6 chiffres certain dedans (cf. la règle d'unanimité). */
  | 'code_introuvable';

export type ResultatCapture =
  | { ok: true; code: string; callId: string; transcription: string }
  | { ok: false; cause: CauseEchec; callId?: string; transcription?: string; details?: string };

export interface CaptureDeps {
  /** Appels entrants récents (fenêtre large : c'est la DIFFÉRENCE avec l'instantané qui identifie le bon appel). */
  appelsRecents(): Promise<AppelEntrant[]>;
  /** Déclenche l'appel de Meta (`request_code` en VOICE). Appelé APRÈS l'instantané, jamais avant. */
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
 * Deux numéros désignent-ils la même ligne ? Comparaison sur les 9 derniers chiffres : les formats se
 * mélangent en permanence (« +33 1 89 48 01 36 », « 0189480136 », « 33189480136 ») et un test d'égalité
 * stricte ferait silencieusement rater tous les appels.
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

  // 1. Instantané AVANT de déclencher quoi que ce soit. C'est lui qui distingue l'appel de Meta d'un appel
  //    antérieur, sans jamais raisonner sur des heures (le fuseau du compte Zadarma n'est pas garanti).
  //    Une erreur ICI remonte volontairement : aucune tentative Meta n'a encore été consommée, et mieux vaut
  //    échouer avant d'appeler que déclencher un appel qu'on serait incapable de rattacher.
  const dejaVus = new Set((await deps.appelsRecents()).map((a) => a.callId));

  await deps.demanderAppel();

  let appelVu: AppelEntrant | undefined;
  let transcriptionDemandee = false;
  let derniereTranscription: Transcription | undefined;
  let derniereErreur: string | undefined;

  while (deps.maintenant() < limite) {
    await deps.attendre(intervalle);

    // 🔴 Un hoquet réseau ne doit PAS tuer la capture. À ce stade `demanderAppel` a déjà consommé une des
    // 10 tentatives que Meta accorde par numéro sur 72 h : laisser remonter un 5xx passager la gaspillerait,
    // alors que l'appel de Meta, lui, est bel et bien parti et que son enregistrement nous attend. La boucle
    // EST le rejeu ; on retient la dernière erreur pour le diagnostic et on retente au tour suivant.
    try {
      if (!appelVu?.enregistre) {
        const nouveaux = (await deps.appelsRecents()).filter((a) => !dejaVus.has(a.callId) && memeNumero(a.destination, options.numero));
        // On garde le plus récent qui porte un enregistrement ; à défaut, n'importe lequel, pour pouvoir
        // distinguer « Meta n'a pas appelé » de « Meta a appelé mais rien n'a décroché ».
        appelVu = nouveaux.find((a) => a.enregistre) ?? nouveaux[0] ?? appelVu;
      }
      if (!appelVu?.enregistre) continue; // l'enregistrement n'apparaît qu'à la FIN de l'appel

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

  // La dernière erreur rencontrée est TOUJOURS reportée quand il y en a eu une : sans elle, une panne
  // Zadarma qui aurait duré tout le sondage se lirait « Meta n'a pas appelé », ce qui enverrait chercher le
  // problème du mauvais côté.
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
