import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '../lib/signature';

/**
 * LE SECOND FACTEUR DES ADMINISTRATEURS : TOTP (RFC 6238) et codes de secours, sur `node:crypto` seul.
 *
 * HMAC-SHA1, pas de 30 secondes, 6 chiffres : c'est ce que toutes les applications d'authentification lisent
 * dans une URI `otpauth://` sans paramètre exotique. Une dépendance pour quarante lignes aurait ajouté une
 * chaîne d'approvisionnement de plus sur le chemin de la connexion.
 *
 * ⚠️ LE BASE32 EST CELUI DE LA RFC 4648, PAS CELUI DE `src/ids/code.ts`. Ce dernier est l'alphabet Crockford
 * (sans I, L, O, U), fait pour des identifiants lisibles ; une application d'authentification décode l'alphabet
 * RFC 4648 (A-Z puis 2-7). Réutiliser l'autre donnerait un secret que l'application décoderait autrement que
 * nous, donc des codes toujours faux, sans aucune erreur nulle part.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** La durée d'un pas, en secondes. */
export const PAS_SECONDES = 30;
const CHIFFRES = 6;
/** Octets d'un secret : 160 bits, la taille du bloc de HMAC-SHA1 que recommande la RFC 4226. */
const OCTETS_SECRET = 20;

/** Encode en base32 RFC 4648, sans bourrage (les applications n'en veulent pas). */
export function base32(octets: Uint8Array): string {
  let sortie = '';
  let valeur = 0;
  let bits = 0;
  for (const o of octets) {
    valeur = (valeur << 8) | o;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      sortie += ALPHABET[(valeur >> bits) & 31]!;
    }
    valeur &= (1 << bits) - 1;
  }
  if (bits > 0) sortie += ALPHABET[(valeur << (5 - bits)) & 31]!;
  return sortie;
}

/** Décode du base32 RFC 4648 (casse, espaces et bourrage tolérés). `null` sur un caractère hors alphabet. */
export function base32Decode(texte: string): Buffer | null {
  const propre = texte.replace(/[\s=]/g, '').toUpperCase();
  const octets: number[] = [];
  let valeur = 0;
  let bits = 0;
  for (const c of propre) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    valeur = (valeur << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      octets.push((valeur >> bits) & 0xff);
    }
    valeur &= (1 << bits) - 1;
  }
  return Buffer.from(octets);
}

/** Un secret neuf, en base32 : c'est la forme qu'on stocke (chiffrée) et qu'on montre pour la saisie à la main. */
export function genererSecret(): string {
  return base32(randomBytes(OCTETS_SECRET));
}

/** Le pas courant : le nombre de pas de 30 secondes écoulés depuis l'époque Unix. */
export function pasDe(maintenantMs: number): number {
  return Math.floor(maintenantMs / 1000 / PAS_SECONDES);
}

/**
 * Le code à 6 chiffres d'un pas (RFC 4226, troncature dynamique). Le compteur s'écrit sur 8 octets gros-boutiste.
 * Lève si le secret n'est pas du base32 : un secret illisible est une donnée corrompue, pas un code faux.
 */
export function codeAuPas(secret: string, pas: number): string {
  const cle = base32Decode(secret);
  if (cle === null || cle.length === 0) throw new Error('secret TOTP illisible');
  const compteur = Buffer.alloc(8);
  compteur.writeBigUInt64BE(BigInt(pas));
  const h = createHmac('sha1', cle).update(compteur).digest();
  const o = h[h.length - 1]! & 0x0f;
  const binaire = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(binaire % 10 ** CHIFFRES).padStart(CHIFFRES, '0');
}

/**
 * Vérifie un code saisi. Rend le PAS accepté, ou `null`.
 *
 * FENÊTRE DE PLUS OU MOINS UN PAS : une horloge de téléphone décalée de quelques secondes, ou un code tapé à la fin
 * de sa période, doit passer. Au-delà, c'est un code d'une autre minute.
 *
 * 🔴 ANTI-REJEU : un pas inférieur ou égal à `dernierPas` est refusé, même si le code est juste. Sans cela, un
 * code vu par-dessus l'épaule (ou intercepté) resterait valable pendant 90 secondes. L'appelant ÉCRIT le pas
 * rendu, et c'est cette écriture, conditionnelle en base, qui ferme la course entre deux présentations
 * simultanées du même code (`MfaStore.marquerPas`).
 *
 * ⚠️ COMPARAISON EN TEMPS CONSTANT sur les trois pas, sans sortie anticipée : la durée de la réponse ne dit pas
 * lequel des trois a correspondu, ni combien de chiffres étaient justes.
 */
export function verifierCode(secret: string, code: string, maintenantMs: number, dernierPas: number | null): number | null {
  const saisi = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(saisi)) return null;
  const courant = pasDe(maintenantMs);
  let accepte: number | null = null;
  for (const pas of [courant - 1, courant, courant + 1]) {
    const juste = timingSafeEqual(Buffer.from(codeAuPas(secret, pas)), Buffer.from(saisi));
    if (juste && accepte === null && (dernierPas === null || pas > dernierPas)) accepte = pas;
  }
  return accepte;
}

/**
 * L'URI qu'une application d'authentification lit dans un QR code. L'émetteur est le nom du PRODUIT, jamais celui
 * d'une infrastructure : c'est ce que la personne verra dans son application, à côté de son adresse.
 */
export function uriOtpauth(emetteur: string, email: string, secret: string): string {
  const libelle = `${encodeURIComponent(emetteur)}:${encodeURIComponent(email)}`;
  const params = new URLSearchParams({
    secret, issuer: emetteur, algorithm: 'SHA1', digits: String(CHIFFRES), period: String(PAS_SECONDES),
  });
  return `otpauth://totp/${libelle}?${params.toString()}`;
}

/** Le nom qui apparaît dans l'application d'authentification. */
export const EMETTEUR_TOTP = 'Engage Me';

// ---------------------------------------------------------------------------------------------------------
// Codes de secours
// ---------------------------------------------------------------------------------------------------------

/** Combien de codes de secours une personne reçoit, à l'activation comme à chaque régénération. */
export const NOMBRE_CODES_SECOURS = 10;

/**
 * Dix codes de 80 bits, affichés `ABCDEFGH-IJKLMNOP`, et leur EMPREINTE, seule chose qu'on stocke.
 *
 * 🔴 SHA-256 ET NON SCRYPT, et c'est délibéré : un hachage lent protège un secret FAIBLE (un mot de passe choisi
 * par un humain) contre une recherche exhaustive. 80 bits tirés au hasard ne se cherchent pas, et un hachage
 * DÉTERMINISTE permet de consommer un code en une seule requête conditionnelle, donc atomique. Un scrypt salé
 * obligerait à lire toutes les empreintes puis à les comparer une par une, et deux présentations simultanées du
 * même code passeraient toutes les deux.
 */
export function genererCodesSecours(): { clairs: string[]; empreintes: string[] } {
  const clairs: string[] = [];
  for (let i = 0; i < NOMBRE_CODES_SECOURS; i += 1) {
    const brut = base32(randomBytes(10));
    clairs.push(`${brut.slice(0, 8)}-${brut.slice(8)}`);
  }
  return { clairs, empreintes: clairs.map((c) => empreinteCodeSecours(c)!) };
}

/**
 * L'empreinte d'un code de secours SAISI : tiret, espaces et casse tolérés. `null` si ce n'est pas la forme d'un
 * code de secours (16 caractères base32), ce qui évite une requête pour un code TOTP ou une faute de frappe.
 */
export function empreinteCodeSecours(saisi: string): string | null {
  const propre = saisi.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z2-7]{16}$/.test(propre)) return null;
  return sha256Hex(propre);
}
