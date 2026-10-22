import { z } from 'zod';
import { lireCorpsBorne } from '../lib/corps-borne';
import { texteDe } from '../lib/erreur';
import { fetchPublic } from '../lib/connexion-publique';

/**
 * VÉRIFIER QU'UNE APP SHOPIFY OUVRE BIEN LA BOUTIQUE (plan 2026-10-21, lot 1), avant de garder son secret.
 *
 * Le marchand a créé l'app dans SON organisation (la skill du plugin pilote la CLI) et l'a installée d'un clic. Le flux
 * `client_credentials` rend alors un jeton de 24 h ; on le demande UNE fois, on lit la boutique (nom, pays, devise), et on
 * ne le garde pas : les webhooks portent tout ce qu'un message utilise.
 *
 * Mesuré le 2026-10-21 (lot 0) : sans `Accept: application/json`, une erreur revient en page HTML ; avec lui, une app
 * désinstallée rend `400 {"error": "app_not_installed"}`. Une app hors de l'organisation de la boutique rend
 * `shop_not_permitted`. Chaque échec est rendu avec le geste qui le règle, jamais comme une panne.
 *
 * 🔴 Le domaine vient du marchand : il est contraint à `<nom>.myshopify.com` AVANT tout appel, et l'appel passe par
 * `fetchPublic` (inventaire de `tests/lib-adresse-privee.test.ts`).
 */

export const API_VERSION_SHOPIFY = '2026-10';
export const DOMAINE_SHOPIFY = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const DOMAINE_MAX = 100;
const CORPS_MAX = 64_000;
const DELAI_MS = 10_000;

/** Le domaine `*.myshopify.com` d'une saisie (adresse complète ou nom nu tolérés), ou `null`. */
export function domaineShopify(brut: unknown): string | null {
  if (typeof brut !== 'string') return null;
  let d = brut.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (d !== '' && !d.includes('.')) d = `${d}.myshopify.com`;
  return d.length <= DOMAINE_MAX && DOMAINE_SHOPIFY.test(d) ? d : null;
}

/** Le lien qui installe l'app sur la boutique (mesuré) ; le même fait approuver un accès ajouté plus tard. */
export function lienInstallation(domaine: string, clientId: string): string {
  return `https://admin.shopify.com/store/${domaine.replace(/\.myshopify\.com$/, '')}/oauth/install?client_id=${encodeURIComponent(clientId)}`;
}

/** La page des apps de la boutique, d'où le marchand désinstalle l'app : aucune API ne le fait à sa place. */
export function pageApps(domaine: string): string {
  return `https://admin.shopify.com/store/${domaine.replace(/\.myshopify\.com$/, '')}/settings/apps`;
}

export type IssueVerification =
  | { ok: true; nom: string | null; pays: string | null; devise: string | null }
  | { ok: false; code: 'app_non_installee' | 'hors_organisation' | 'identifiants' | 'boutique_inconnue' | 'passager'; message: string };

const schemaJeton = z.object({ access_token: z.string().min(1) });
const schemaErreur = z.object({ error: z.string() });
const schemaBoutique = z.object({
  shop: z.object({ name: z.string().nullish(), country_code: z.string().nullish(), currency: z.string().nullish() }),
});

async function json(res: Response): Promise<unknown> {
  const corps = await lireCorpsBorne(res, CORPS_MAX);
  if (corps.trop_gros || corps.casse) return null;
  try {
    return JSON.parse(corps.texte);
  } catch {
    return null;
  }
}

export type IssueJeton = { ok: true; jeton: string } | Extract<IssueVerification, { ok: false }>;

/**
 * Le jeton `client_credentials` de l'app (24 h), demandé à chaque usage et jamais gardé : la vérification d'une connexion
 * et l'import des clients (lot 3). Chaque refus est rendu avec le geste qui le règle.
 */
export async function demanderJeton(
  domaine: string, clientId: string, secret: string,
  /** `fetchPublic` en production ; injectable pour éprouver la demande sans réseau. */
  appeler: typeof fetch = fetchPublic,
): Promise<IssueJeton> {
  try {
    const res = await appeler(`https://${domaine}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(DELAI_MS),
    });
    const corps = await json(res);
    const ok = schemaJeton.safeParse(corps);
    if (res.status === 200 && ok.success) return { ok: true, jeton: ok.data.access_token };
    const err = schemaErreur.safeParse(corps);
    const code = err.success ? err.data.error : '';
    if (code === 'app_not_installed') {
      return { ok: false, code: 'app_non_installee', message: `L’app n’est pas installée sur la boutique : cliquez « Installer » sur ${lienInstallation(domaine, clientId)}, puis réessayez.` };
    }
    if (code === 'shop_not_permitted') {
      return { ok: false, code: 'hors_organisation', message: 'Cette app n’est pas dans l’organisation Shopify qui porte la boutique : créez-la dans cette organisation (shopify organization list), puis réessayez.' };
    }
    if (code === 'invalid_client' || res.status === 401) {
      return { ok: false, code: 'identifiants', message: 'Shopify refuse cet identifiant ou ce secret : relisez-les avec « shopify app env show ».' };
    }
    if (res.status === 404) return { ok: false, code: 'boutique_inconnue', message: 'Shopify ne connaît pas cette boutique, ou elle est inactive.' };
    if (res.status >= 500) return passager(`statut ${res.status}`);
    return { ok: false, code: 'identifiants', message: `Shopify refuse la connexion (${code || `statut ${res.status}`}).` };
  } catch (err) {
    return passager(texteDe(err));
  }
}

function passager(detail: string): Extract<IssueVerification, { ok: false }> {
  return { ok: false, code: 'passager', message: `Shopify n’a pas répondu (${detail}) : réessayez dans un instant.` };
}

export async function verifierBoutique(
  domaine: string, clientId: string, secret: string,
  /** `fetchPublic` en production ; injectable pour éprouver la vérification sans réseau. */
  appeler: typeof fetch = fetchPublic,
): Promise<IssueVerification> {
  const j = await demanderJeton(domaine, clientId, secret, appeler);
  if (!j.ok) return j;
  const jeton = j.jeton;
  try {
    const res = await appeler(`https://${domaine}/admin/api/${API_VERSION_SHOPIFY}/shop.json`, {
      headers: { accept: 'application/json', 'x-shopify-access-token': jeton },
      redirect: 'manual',
      signal: AbortSignal.timeout(DELAI_MS),
    });
    const lu = schemaBoutique.safeParse(await json(res));
    if (res.status !== 200 || !lu.success) return passager(`fiche de la boutique, statut ${res.status}`);
    return { ok: true, nom: lu.data.shop.name ?? null, pays: lu.data.shop.country_code ?? null, devise: lu.data.shop.currency ?? null };
  } catch (err) {
    return passager(texteDe(err));
  }
}
