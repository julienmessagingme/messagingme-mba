import { createHmac } from 'node:crypto';

/**
 * Signature des appels Channels Me. Une seule dérivation : la même chaîne canonique est signée et envoyée
 * comme corps. Signer un objet et en sérialiser un autre produit une signature qui ne correspond pas, et
 * l'API répond 401 sans dire pourquoi.
 *
 * Une seule exception, mesurée : `media_url` est envoyé mais pas signé (`CHAMPS_HORS_SIGNATURE`), isolée là
 * pour qu'on ne l'élargisse pas par inadvertance. À ne pas confondre avec `src/lib/signature.ts` (format
 * `v1=` vers mm-hubspot) ni `src/crypto/secretbox.ts` (chiffrement au repos).
 */

/**
 * Chaîne canonique d'un corps : JSON sans espaces, slashes non échappés, clés triées alphabétiquement en
 * profondeur. Le tri en profondeur est mesuré (le vecteur d'or de la documentation n'a qu'une clé plate) :
 * seule la forme imbriquée triée a passé l'authentification sur des POST volontairement invalides. L'ordre
 * d'un tableau est une donnée, jamais trié.
 */
export function corpsCanonique(v: unknown): string {
  // Un objet qui sait se sérialiser (une Date) se ramène d'abord à sa valeur JSON, comme avec JSON.stringify :
  // sinon il sortirait en `{}`, un corps faux en silence.
  if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
    return corpsCanonique((v as { toJSON: () => unknown }).toJSON());
  }
  if (Array.isArray(v)) return `[${v.map((x) => corpsCanonique(x)).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const objet = v as Record<string, unknown>;
    const membres = Object.keys(objet)
      .sort()
      // `undefined`, fonction ou Symbol : la propriété entière tombe, comme avec JSON.stringify. C'est ce qui
      // permet d'écrire `{ media_url: mediaUrl }` sans brancher sur l'absence d'image.
      .filter((cle) => {
        const valeur = objet[cle];
        return valeur !== undefined && typeof valeur !== 'function' && typeof valeur !== 'symbol';
      })
      .map((cle) => `${JSON.stringify(cle)}:${corpsCanonique(objet[cle])}`);
    return `{${membres.join(',')}}`;
  }
  // Primitives. Le `?? 'null'` couvre ce que JSON.stringify ne sait pas écrire (undefined, fonction,
  // symbole), exactement comme il le fait lui-même à l'intérieur d'un tableau.
  return JSON.stringify(v) ?? 'null';
}

/**
 * base64 des octets bruts du HMAC-SHA256, tenu par le vecteur d'or de `tests/channels-me-signature.test.ts`.
 * Zadarma, lui, encode l'hexadécimal (`signZadarma`) : une signature correcte fait 44 caractères, 88 veut
 * dire qu'on a encodé l'hexadécimal, et l'API rend 401.
 */
export function signer(canonique: string, secret: string): string {
  return createHmac('sha256', secret).update(canonique, 'utf8').digest('base64');
}

/**
 * Les champs que le fournisseur retire de son côté avant de vérifier la signature, mesurés :
 *
 *   | corps envoyé          | signature calculée sur | verdict |
 *   |-----------------------|------------------------|---------|
 *   | texte seul            | tout                   | auth OK |
 *   | texte + `media_url`   | tout                   | **401** |
 *   | texte + `media_url`   | tout sauf `media_url`  | auth OK |
 *
 * Leur documentation ne l'écrit que pour le multipart (`media` omis, `media_checksum` signé) ; `media_url`
 * suit la même règle. `media_checksum` reste signé, comme leur spec le demande ; `media` figure ici sur la
 * foi de leur spec (nous n'envoyons pas de multipart).
 */
export const CHAMPS_HORS_SIGNATURE: readonly string[] = ['media_url', 'media'];

/**
 * Le corps, privé des champs que le fournisseur ne signe pas.
 *
 * Récursif : le corps réel est imbriqué (`{ message: { ... } }`), donc un filtre de surface ne verrait rien.
 */
export function corpsASigner(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(corpsASigner);
  if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON !== 'function') {
    const entrees = Object.entries(v as Record<string, unknown>)
      .filter(([cle]) => !CHAMPS_HORS_SIGNATURE.includes(cle))
      .map(([cle, valeur]) => [cle, corpsASigner(valeur)] as const);
    return Object.fromEntries(entrees);
  }
  return v;
}
