import { construireCible } from './http-cible';
import type { AuthSource, PatchSource, SourceVue } from './sources';

/**
 * Configuration commune aux sources d'outils HTTP et MCP.
 *
 * Les routes restent des adaptateurs : elles valident la forme JSON avec Zod et traduisent le verdict en HTTP.
 * Ce module porte la règle métier partagée : une adresse publique en HTTPS et une authentification complète.
 */

type MotifRefusConfigurationSource =
  | 'adresse_refusee'
  | 'secret_requis'
  | 'entete_requis';

interface RefusConfigurationSource {
  ok: false;
  motif: MotifRefusConfigurationSource;
  erreur: string;
}

interface AdresseSourceValide {
  ok: true;
  hote: string | null;
}

type VerdictAdresseSource = AdresseSourceValide | RefusConfigurationSource;

type PreparationCreationSource = AdresseSourceValide | RefusConfigurationSource;

type PreparationPatchSource = RefusConfigurationSource | {
  ok: true;
  authKind: AuthSource;
  adresseChangee: boolean;
  /** Présent seulement quand le patch propose une nouvelle adresse. */
  hote?: string | null;
};

const ERREURS: Record<MotifRefusConfigurationSource, string> = {
  adresse_refusee: 'adresse refusée : elle doit être publique et en HTTPS',
  secret_requis: 'un secret est requis pour ce mode d’authentification',
  entete_requis: 'le nom de l’en-tête est requis',
};

function refuser(motif: MotifRefusConfigurationSource): RefusConfigurationSource {
  return { ok: false, motif, erreur: ERREURS[motif] };
}

function hoteDe(url: string): string | null {
  try { return new URL(url).host; } catch { return null; }
}

/**
 * Vérifie une adresse avec la même primitive que l'appel sortant. Cette fonction reste publique pour permettre au
 * PATCH de refuser une mauvaise adresse avant même de lire la source, comme le contrat HTTP historique le promet.
 */
export function verifierAdresseSource(baseUrl: string): VerdictAdresseSource {
  const cible = construireCible({ baseUrl, binding: { methode: 'GET', chemin: '/' }, args: {} });
  return cible.ok ? { ok: true, hote: hoteDe(baseUrl) } : refuser('adresse_refusee');
}

function verifierAuthentification(
  authKind: AuthSource,
  aSecret: boolean,
  authHeaderName: string | null | undefined,
): RefusConfigurationSource | null {
  if (authKind === 'none') return null;
  if (!aSecret) return refuser('secret_requis');
  if (authKind === 'header' && !authHeaderName) return refuser('entete_requis');
  return null;
}

export function preparerCreationSource(input: {
  baseUrl: string;
  authKind: AuthSource;
  authHeaderName?: string | null;
  authSecret?: string;
}): PreparationCreationSource {
  const adresse = verifierAdresseSource(input.baseUrl);
  if (!adresse.ok) return adresse;
  const refusAuth = verifierAuthentification(input.authKind, Boolean(input.authSecret), input.authHeaderName);
  return refusAuth ?? adresse;
}

/**
 * Calcule la configuration EFFECTIVE après un PATCH. Le secret absent reste inchangé : une route ne le relit jamais
 * et ne doit donc ni l'effacer ni refuser un changement de mode si la source en possède déjà un.
 */
export function preparerPatchSource(
  actuelle: Pick<SourceVue, 'baseUrl' | 'authKind' | 'authHeaderName' | 'aAuthentification'>,
  patch: Pick<PatchSource, 'baseUrl' | 'authKind' | 'authHeaderName' | 'authSecret'>,
): PreparationPatchSource {
  let hote: string | null | undefined;
  if (patch.baseUrl !== undefined) {
    const adresse = verifierAdresseSource(patch.baseUrl);
    if (!adresse.ok) return adresse;
    hote = adresse.hote;
  }

  const authKind = patch.authKind ?? actuelle.authKind;
  const authHeaderName = patch.authHeaderName !== undefined ? patch.authHeaderName : actuelle.authHeaderName;
  const aSecret = patch.authSecret !== undefined ? Boolean(patch.authSecret) : actuelle.aAuthentification;
  const refusAuth = verifierAuthentification(authKind, aSecret, authHeaderName);
  if (refusAuth) return refusAuth;

  return {
    ok: true,
    authKind,
    adresseChangee: patch.baseUrl !== undefined && patch.baseUrl !== actuelle.baseUrl,
    ...(patch.baseUrl !== undefined ? { hote } : {}),
  };
}
