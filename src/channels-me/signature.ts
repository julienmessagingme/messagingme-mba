import { createHmac } from 'node:crypto';

/**
 * Signature des appels Channels Me.
 *
 * UNE seule dérivation, et c'est ce qui rend l'ensemble correct : la MÊME chaîne canonique est signée et
 * envoyée comme corps de la requête. Dériver deux fois (signer un objet, sérialiser l'autre) est le moyen
 * le plus sûr de produire une signature qui ne correspond pas au corps, et l'API répond alors 401 sans
 * dire pourquoi. Même leçon que `zadarmaQuery` (src/zadarma/client.ts), où la chaîne signée EST la query
 * appelée.
 *
 * 🔴 IL EXISTE UNE EXCEPTION, UNE SEULE, ET ELLE EST MESURÉE : `media_url` est envoyé mais N'EST PAS SIGNÉ,
 * cf. `CHAMPS_HORS_SIGNATURE` plus bas. Elle est isolée là pour que la règle générale reste vraie partout
 * ailleurs, et pour qu'on ne puisse pas l'élargir par inadvertance.
 *
 * ⚠️ Trois modules, trois usages, à ne pas confondre : ici la signature d'un tiers ; `src/lib/signature.ts`
 * le format `v1=` cross-repo (préimage horodatée, sortie hexadécimale) ; `src/crypto/secretbox.ts` le
 * chiffrement au repos.
 */

/**
 * Chaîne canonique d'un corps : JSON sans espaces, slashes NON échappés, clés triées alphabétiquement
 * EN PROFONDEUR.
 *
 * 🔴 LE TRI EN PROFONDEUR EST MESURÉ, PAS SUPPOSÉ (spec du 2026-09-04, §2.2). Le vecteur d'or de la
 * documentation n'a qu'UNE clé plate : il ne dit rien de la façon de signer un corps imbriqué, et un tri
 * de surface le passe quand même. Ce qui a tranché, ce sont des POST volontairement invalides :
 * l'authentification passant avant la validation, une signature fausse rend 401 et une signature juste
 * rend 422, sans jamais rien créer. Seule la forme imbriquée, triée en profondeur, a rendu 422.
 *
 * L'ordre d'un TABLEAU est une donnée, pas une présentation : il n'est jamais trié.
 */
export function corpsCanonique(v: unknown): string {
  // Un objet qui sait se sérialiser (une Date, par exemple) se ramène d'abord à sa valeur JSON, comme le
  // ferait JSON.stringify. Sans cette ligne il tomberait dans la branche « objet », n'aurait aucune clé
  // propre énumérable, et sortirait en `{}` : un corps faux, en silence.
  if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
    return corpsCanonique((v as { toJSON: () => unknown }).toJSON());
  }
  if (Array.isArray(v)) return `[${v.map((x) => corpsCanonique(x)).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const objet = v as Record<string, unknown>;
    const membres = Object.keys(objet)
      .sort()
      // `undefined`, une fonction ou un Symbol ne s'écrivent pas en JSON : JSON.stringify laisse tomber la
      // propriété entière (pas de `"clé":null`), on fait pareil. C'est ce qui permet d'écrire
      // `{ media_url: mediaUrl }` sans brancher sur l'absence d'image.
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
 * base64 des OCTETS BRUTS du HMAC-SHA256. Tenu par le vecteur d'or de la documentation, figé dans
 * `tests/channels-me-signature.test.ts`.
 *
 * ⚠️ Piège déjà payé ailleurs dans ce dépôt : Zadarma encode en base64 la représentation HEXADÉCIMALE du
 * HMAC (`signZadarma`, src/zadarma/client.ts). Ici c'est le binaire. Une signature correcte fait 44
 * caractères ; 88 signifie qu'on a encodé l'hexadécimal, et l'API rend 401 sans dire pourquoi.
 */
export function signer(canonique: string, secret: string): string {
  return createHmac('sha256', secret).update(canonique, 'utf8').digest('base64');
}

/**
 * Les champs que le fournisseur RETIRE de son côté avant de vérifier la signature.
 *
 * 🔴 MESURÉ LE 2026-09-08, APRÈS UN ÉCHEC EN PRODUCTION. Julien a publié un texte avec une image : refus.
 * Notre message d'erreur accusait son texte et son image ; la vraie réponse du fournisseur était
 * `401 Bad Authorization or X-Signature header`, c'est-à-dire NOTRE signature. Trois sondes, avec le vrai
 * `kind` et sur des brouillons (donc invisibles des abonnés, et rien n'a été créé) ont isolé la règle :
 *
 *   | corps envoyé          | signature calculée sur | verdict |
 *   |-----------------------|------------------------|---------|
 *   | texte seul            | tout                   | auth OK |
 *   | texte + `media_url`   | tout                   | **401** |
 *   | texte + `media_url`   | tout SAUF `media_url`  | auth OK |
 *
 * Leur documentation ne l'écrit que pour le multipart (« the signature should be computed with the
 * `media_checksum` and the `media` parameter should be ommited ») ; la mesure montre que `media_url` suit la
 * même règle. Une sonde de contrôle a montré qu'une clé INCONNUE quelconque casse aussi la signature : leur
 * vérification porte donc sur les paramètres qu'ils RETIENNENT, pas sur le corps brut.
 *
 * ⚠️ CONSÉQUENCE : toute publication AVEC IMAGE échouait, depuis toujours. Ce n'est pas une régression du
 * lot « téléverser une photo » ; ce lot a seulement rendu le chemin facile à emprunter, donc visible.
 *
 * ⚠️ `media_checksum` n'est PAS dans cette liste, et c'est délibéré : leur spec dit explicitement de signer
 * AVEC lui. `media` y figure sur la foi de leur spec, pas d'une mesure (nous n'envoyons pas de multipart).
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
