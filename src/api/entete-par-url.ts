import { estRedirectionRefusee, estRefusAdresseInterne, fetchPublic } from '../lib/connexion-publique';
import { resolutionPublique, type VerdictResolution } from '../lib/adresse-privee';
import { lireOctetsBornes } from '../lib/corps-borne';
import { urlRecuperable } from '../lib/page-distante';
import { typeImage } from '../rcs/image';
import { texteDe } from '../lib/erreur';

/**
 * L'EN-TÊTE D'UN MODÈLE DONNÉ PAR SON ADRESSE (lot 13, domaine 3, spec § 5) : notre serveur télécharge le fichier, puis
 * l'appelant le dépose chez Meta (`MetaMediaClient.uploadImage`, comme l'écran Modèles), qui rend le `header_handle`.
 *
 * 🔴 L'adresse est saisie par un client et le serveur tourne dans le réseau Docker du VPS : toutes les gardes d'une telle
 * adresse (texte de l'hôte, résolution publique, connexion vérifiée, AUCUNE redirection suivie, lecture bornée en octets,
 * délai qui couvre la lecture). Inventorié par `tests/lib-adresse-privee.test.ts`.
 * 🔴 Le type est décidé par la SIGNATURE des octets, jamais par le `content-type` annoncé : c'est un fichier qu'on dépose
 * chez Meta sous l'identité du client.
 */

export type FormatEntete = 'IMAGE' | 'VIDEO' | 'DOCUMENT';

/** Les plafonds : ceux de Meta pour une image (5 Mo) et une vidéo (16 Mo) ; le nôtre pour un document (en mémoire). */
export const PLAFONDS_ENTETE: Readonly<Record<FormatEntete, number>> = {
  IMAGE: 5 * 1024 * 1024,
  VIDEO: 16 * 1024 * 1024,
  DOCUMENT: 16 * 1024 * 1024,
};

const DELAI_TELECHARGEMENT_MS = 20_000;

export interface DepsTelechargement {
  /** `fetchPublic` en production : la connexion s'ouvre sur l'adresse vérifiée (DNS rebinding fermé). */
  fetch: typeof fetch;
  /** `resolutionPublique` en production : un refus lisible avant l'appel, une adresse interne n'est jamais appelée. */
  verifier(url: string): Promise<VerdictResolution>;
  delaiMs?: number;
}

/** Le type réel du fichier pour ce format, d'après ses octets, ou `null` s'il ne convient pas. */
function typeReel(format: FormatEntete, octets: Buffer): string | null {
  if (format === 'IMAGE') {
    const t = typeImage(octets);
    return t === 'image/jpeg' || t === 'image/png' ? t : null;
  }
  if (format === 'VIDEO') return octets.length >= 12 && octets.subarray(4, 8).toString('latin1') === 'ftyp' ? 'video/mp4' : null;
  return octets.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf' : null;
}

const ATTENDU: Readonly<Record<FormatEntete, string>> = {
  IMAGE: 'une image JPEG ou PNG',
  VIDEO: 'une vidéo MP4',
  DOCUMENT: 'un document PDF',
};

/** Télécharge le fichier d'en-tête, ou dit pourquoi on ne le fait pas. Ne lève jamais : un refus est une réponse. */
export async function telechargerEntete(
  deps: DepsTelechargement,
  format: FormatEntete,
  url: string,
): Promise<{ octets: Buffer; mime: string } | { refus: string }> {
  if (!url.startsWith('https://') || !urlRecuperable(url)) return { refus: 'adresse refusée : https et un hôte public sont attendus' };
  const verdict = await deps.verifier(url);
  if (!verdict.ok) return { refus: verdict.raison ?? 'adresse refusée' };
  const delai = deps.delaiMs ?? DELAI_TELECHARGEMENT_MS;
  const controle = new AbortController();
  const minuteur = setTimeout(() => controle.abort(), delai);
  try {
    const res = await deps.fetch(url, { method: 'GET', redirect: 'error', signal: controle.signal });
    if (!res.ok) return { refus: `le serveur du fichier a répondu HTTP ${res.status}` };
    const plafond = PLAFONDS_ENTETE[format];
    const lu = await lireOctetsBornes(res, plafond);
    if (lu.octets === null) {
      return { refus: lu.trop_gros ? `fichier trop lourd : ${Math.round(plafond / 1024 / 1024)} Mo au plus pour cet en-tête` : 'le fichier est arrivé incomplet' };
    }
    const mime = typeReel(format, lu.octets);
    if (mime === null) return { refus: `le fichier n’est pas ${ATTENDU[format]}` };
    return { octets: lu.octets, mime };
  } catch (err) {
    if (controle.signal.aborted) return { refus: `pas de réponse en ${Math.round(delai / 1000)} s` };
    if (estRefusAdresseInterne(err)) return { refus: 'ce nom pointe vers une adresse interne' };
    if (estRedirectionRefusee(err)) return { refus: 'l’adresse répond par une redirection, qui n’est pas suivie : donnez l’adresse finale du fichier' };
    return { refus: `le fichier n’a pas pu être téléchargé (${texteDe(err).slice(0, 200)})` };
  } finally {
    clearTimeout(minuteur);
  }
}

/**
 * Combien de fichiers d'en-tête cette copie télécharge en même temps : chacun peut peser 16 Mo en mémoire. Pas la place
 * « lourde » de l'usage (`estLourde`), qui vaut 1 par copie et qu'un téléchargement de 20 s prendrait aux envois.
 */
export const PLACES_TELECHARGEMENT = 3;
let enCours = 0;

/** Le refus quand toutes les places sont prises : à réessayer, d'où un 429 et non un refus du fichier. */
export const OCCUPE = { refus: 'trop de fichiers d’en-tête en cours de téléchargement, réessayez dans un instant', reessayer: true } as const;

/**
 * 🔴 Le téléchargement de production : `fetchPublic` et `resolutionPublique`, câblés ICI et non par l'appelant, qui ne
 * peut donc pas les oublier. Borné à {@link PLACES_TELECHARGEMENT} en vol.
 */
export async function telechargerEnteteProduction(
  format: FormatEntete,
  url: string,
): Promise<{ octets: Buffer; mime: string } | { refus: string; reessayer?: true }> {
  if (enCours >= PLACES_TELECHARGEMENT) return OCCUPE;
  enCours += 1;
  try {
    return await telechargerEntete({ fetch: fetchPublic, verifier: (u) => resolutionPublique(u) }, format, url);
  } finally {
    enCours -= 1;
  }
}
