import type { ZadarmaClient } from './client';

/** Un numéro que le compte possède (`GET /v1/direct_numbers/`). */
export interface NumeroDirect {
  /** Format international sans « + » tel que Zadarma le rend (ex. « 33189480136 »). */
  numero: string;
  /** `on`, `parking`, `checking`... Seul `on` est utilisable. */
  statut: string;
  pays: string;
  description: string;
  /** Nom libre donné dans le panneau : sert à savoir à quoi le numéro est déjà affecté. */
  nom: string;
  /** Faux sur les numéros français, voix seule : l'OTP par SMS est exclu. */
  recoitSms: boolean;
  fraisMensuel: number;
  devise: string;
}

/** Un appel entrant (`GET /v1/statistics/pbx/` version 2). */
export interface AppelEntrant {
  /** Identifiant de l'appel, celui qui apparaît dans le nom du fichier d'enregistrement. Clé de la transcription. */
  callId: string;
  /** Numéro appelant (Meta, pour un appel d'OTP). */
  appelant: string;
  /** Numéro appelé, c'est-à-dire notre numéro. */
  destination: string;
  /** `answered`, `no answer`, `busy`... */
  etat: string;
  /** Un enregistrement existe et peut être transcrit. Passe à vrai à la fin de l'appel, pas pendant. */
  enregistre: boolean;
  debut: string;
}

/**
 * Transcription d'un enregistrement d'appel téléphonique (`GET /v1/speech_recognition/`), par Zadarma. À ne pas
 * confondre avec `TranscriptionAudio` (`src/agent/llm/transcription.ts`), qui transcrit un audio WhatsApp.
 */
export interface Transcription {
  /** La reconnaissance est terminée et le texte est exploitable. */
  pret: boolean;
  texte: string;
  /** État brut rendu par Zadarma, journalisé tel quel quand rien n'est exploitable. */
  etat: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const bool = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === '1';
const nombre = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

/** Numéros possédés par le compte. */
export async function listerNumeros(client: ZadarmaClient): Promise<NumeroDirect[]> {
  const res = (await client.call('GET', '/v1/direct_numbers/')) as { info?: unknown };
  const rows = (Array.isArray(res?.info) ? res.info : []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    numero: str(r.number),
    statut: str(r.status),
    pays: str(r.country),
    description: str(r.description),
    nom: str(r.number_name),
    recoitSms: bool(r.receive_sms),
    fraisMensuel: nombre(r.monthly_fee),
    devise: str(r.currency),
  }));
}

/** Horodatage au format attendu par Zadarma : « AAAA-MM-JJ HH:MM:SS ». */
function horodatage(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Appels entrants d'une fenêtre récente, volontairement large : elle ne sert jamais à identifier le bon appel, le
 * fuseau du compte Zadarma n'étant pas garanti. L'identification se fait par différence avec un instantané pris
 * avant l'appel (`capturerOtp`).
 */
export async function appelsEntrantsRecents(client: ZadarmaClient, maintenant: number, heures = 6): Promise<AppelEntrant[]> {
  const res = (await client.call('GET', '/v1/statistics/pbx/', {
    start: horodatage(new Date(maintenant - heures * 3600_000)),
    end: horodatage(new Date(maintenant + heures * 3600_000)),
    version: '2',
    call_type: 'in',
  })) as { stats?: unknown };
  const rows = (Array.isArray(res?.stats) ? res.stats : []) as Array<Record<string, unknown>>;
  return rows
    .map((r) => ({
      callId: str(r.call_id),
      appelant: str(r.clid),
      destination: str(r.destination),
      etat: str(r.disposition),
      enregistre: bool(r.is_recorded),
      debut: str(r.callstart),
    }))
    .filter((a) => a.callId !== '');
}

/** Lance la reconnaissance vocale d'un enregistrement (asynchrone : le résultat se relit ensuite). */
export async function demanderTranscription(client: ZadarmaClient, callId: string, langue = 'fr-FR'): Promise<void> {
  await client.call('PUT', '/v1/speech_recognition/', { call_id: callId, lang: langue });
}

/**
 * Relit une transcription. Prête quand `recognitionStatus` vaut « recognized » ; tout autre état rend
 * `pret:false`, l'appelant réessaie ou abandonne.
 */
export async function lireTranscription(client: ZadarmaClient, callId: string, langue = 'fr-FR'): Promise<Transcription> {
  const res = (await client.call('GET', '/v1/speech_recognition/', { call_id: callId, lang: langue })) as {
    recognitionStatus?: unknown;
    phrases?: unknown;
    words?: unknown;
  };
  const etat = str(res?.recognitionStatus);
  // Zadarma rend des phrases ou des mots (paramètre `return`) : on accepte les deux.
  const phrases = (Array.isArray(res?.phrases) ? res.phrases : []) as Array<Record<string, unknown>>;
  const mots = (Array.isArray(res?.words) ? res.words : []) as Array<Record<string, unknown>>;
  const texte = phrases.length > 0
    ? phrases.map((p) => str(p.result ?? p.text ?? p.phrase)).filter((t) => t !== '').join(' ')
    : mots.map((m) => str(m.w)).filter((t) => t !== '').join(' ');
  return { pret: etat === 'recognized' && texte.trim() !== '', texte: texte.trim(), etat };
}
