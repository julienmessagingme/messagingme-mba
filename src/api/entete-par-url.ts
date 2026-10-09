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

/**
 * Les marques d'un fichier MP4 (octets 8 à 12, après `ftyp`) : `ftyp` seul couvre toute la famille ISO, dont HEIC, M4A et
 * MOV (`qt  `), que Meta refuserait plus tard avec un message moins clair.
 */
const MARQUES_MP4: ReadonlySet<string> = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ']);

/** Le type réel du fichier pour ce format, d'après ses octets, ou `null` s'il ne convient pas. */
function typeReel(format: FormatEntete, octets: Buffer): string | null {
  if (format === 'IMAGE') {
    const t = typeImage(octets);
    return t === 'image/jpeg' || t === 'image/png' ? t : null;
  }
  if (format === 'VIDEO') {
    const mp4 = octets.length >= 12 && octets.subarray(4, 8).toString('latin1') === 'ftyp' && MARQUES_MP4.has(octets.subarray(8, 12).toString('latin1'));
    return mp4 ? 'video/mp4' : null;
  }
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
    if (!res.ok) {
      // Le corps n'est pas lu : il est rendu tout de suite, sinon la connexion reste tenue sur l'agent PARTAGÉ (webhooks
      // sortants, client MCP, connecteurs) jusqu'au ramasse-miettes.
      await res.body?.cancel().catch(() => {});
      return { refus: `le serveur du fichier a répondu HTTP ${res.status}` };
    }
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
 * Combien d'en-têtes cette copie télécharge et dépose en même temps : chacun peut peser 16 Mo en mémoire, du
 * téléchargement à la fin du dépôt chez Meta (`creerModeleDepuisMeta` tient la place sur les deux). Pas la place
 * « lourde » de l'usage (`estLourde`), qui vaut 1 par copie et qu'un téléchargement de 20 s prendrait aux envois.
 */
export const PLACES_TELECHARGEMENT = 3;
let enCours = 0;

/** Les places de la copie : `prendre` rend la fonction qui la rend, ou `null` quand toutes sont prises. */
export const placesDeTelechargement = {
  prendre(): (() => void) | null {
    if (enCours >= PLACES_TELECHARGEMENT) return null;
    enCours += 1;
    let rendue = false;
    return () => {
      if (rendue) return;
      rendue = true;
      enCours -= 1;
    };
  },
};

/**
 * 🔴 Le téléchargement de production : `fetchPublic` et `resolutionPublique`, câblés ICI et non par l'appelant, qui ne
 * peut donc pas les oublier.
 */
export function telechargerEnteteProduction(format: FormatEntete, url: string): Promise<{ octets: Buffer; mime: string } | { refus: string }> {
  return telechargerEntete({ fetch: fetchPublic, verifier: (u) => resolutionPublique(u) }, format, url);
}
