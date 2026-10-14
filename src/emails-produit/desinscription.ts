import { createHmac, timingSafeEqual } from 'node:crypto';
import { CATEGORIES, estCoupable, type CategorieCoupable } from './catalogue';

/**
 * LE LIEN DE DÉSINSCRIPTION (lot 7) : une personne et une catégorie, signées, sans connexion. Il voyage dans un e-mail
 * et dans l'en-tête `List-Unsubscribe`, donc il ne donne accès à RIEN d'autre que couper cette catégorie pour cette
 * personne ; « Mon compte » la rétablit.
 *
 * Le jeton : `<identité>.<catégorie>.<signature>`, la signature étant un HMAC SHA-256 du couple avec un secret dérivé
 * de `AUTH_SECRET` pour ce seul usage (un jeton de désinscription ne vaut jamais une session, ni l'inverse). Il n'expire
 * pas : un e-mail d'il y a un an doit encore pouvoir se désabonner.
 */

const USAGE = 'emails-produit:desinscription:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleDerivee(secret: string): Buffer {
  return createHmac('sha256', secret).update(USAGE, 'utf8').digest();
}

function signature(identityId: string, categorie: CategorieCoupable, secret: string): Buffer {
  return createHmac('sha256', cleDerivee(secret)).update(`${identityId.toLowerCase()}.${categorie}`, 'utf8').digest();
}

/** Le jeton d'une personne pour une catégorie. Un secret vide est refusé : il signerait avec une clé connue de tous. */
export function jetonDesinscription(identityId: string, categorie: CategorieCoupable, secret: string): string {
  if (!secret) throw new Error('desinscription : secret absent');
  return `${identityId.toLowerCase()}.${categorie}.${signature(identityId, categorie, secret).toString('base64url')}`;
}

/** Ce qu'un jeton désigne, ou `null` s'il est mal formé, mal signé, ou si le secret manque. Temps constant. */
export function lireJetonDesinscription(jeton: string, secret: string): { identityId: string; categorie: CategorieCoupable } | null {
  if (!secret || typeof jeton !== 'string' || jeton.length > 200) return null;
  const morceaux = jeton.split('.');
  if (morceaux.length !== 3) return null;
  const [identityId, categorie, sig] = morceaux as [string, string, string];
  if (!UUID.test(identityId)) return null;
  if (!(CATEGORIES as readonly string[]).includes(categorie) || !estCoupable(categorie as never)) return null;
  const attendue = signature(identityId, categorie as CategorieCoupable, secret);
  const recue = Buffer.from(sig, 'base64url');
  if (recue.length !== attendue.length || !timingSafeEqual(recue, attendue)) return null;
  return { identityId: identityId.toLowerCase(), categorie: categorie as CategorieCoupable };
}

/** L'adresse publique du lien, servie par l'API (`/e/desinscription/:code`, le code étant le jeton). */
export function lienDesinscription(baseApi: string, jeton: string): string {
  return `${baseApi.trim().replace(/\/+$/, '')}/e/desinscription/${encodeURIComponent(jeton)}`;
}
