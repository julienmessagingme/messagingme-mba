import { lienWaMe } from '../lib/wa-me';

/**
 * Ce que le widget distribue, écrit UNE fois : l'adresse du script, la balise à coller, et le lien `wa.me` de la
 * bulle. La route publique (`src/http/widget-public.ts`) les sert, la console et le MCP les montrent : deux
 * fabrications de la même adresse divergeraient, et la seconde partirait quand même chez un client.
 */

/**
 * Le chemin de la route publique, tel que Fastify le monte. 🔴 UNE PORTE À SENS UNIQUE : dès qu'une balise est
 * posée chez un client, cette adresse doit répondre pour toujours (spec, « Ce que le lot engage »).
 */
export const ROUTE_SCRIPT = '/widget/:code.js';

/**
 * L'adresse du script d'un widget. `base` est celle des routes d'API (`adressesPubliques(...).avecPrefixe`) : la
 * route vit sur l'API, comme `/w/<code>`, et non à la racine du front comme `/r/<code>`. Avec `PUBLIC_API_URL`,
 * c'est `https://api.messagingme.app/widget/<code>.js`, la forme que la spec promet ; sans, elle passe par le
 * préfixe du proxy, qui relaie tout chemin vers l'API.
 */
export function adresseDuScript(base: string, code: string): string {
  return `${base.replace(/\/+$/, '')}${ROUTE_SCRIPT.replace(':code', code)}`;
}

/**
 * La balise à coller sur le site. `async` n'est pas un détail : une panne de l'API fait alors disparaître la bulle
 * sans jamais bloquer le rendu de la page qui l'héberge.
 */
export function baliseDuScript(adresse: string): string {
  return `<script src="${adresse}" async></script>`;
}

/** Ce que le lien a besoin de savoir du numéro de l'espace (`PhoneNumberRecord`, lu par `getPhoneNumber`). */
export interface NumeroDuWidget {
  displayPhoneNumber: string | null;
  delieLe: string | null;
}

/**
 * Le lien `wa.me` de la bulle, ou null quand la bulle est GRISÉE : aucun numéro, numéro délié, ou numéro sans
 * chiffre (`lienWaMe` rend alors null).
 *
 * 🔴 JAMAIS SUR `health_status` À `BLOCKED`. Mesuré en production le 2026-10-02 : un compte BLOCKED (moyen de
 * paiement en erreur, entreprise non vérifiée) REÇOIT et RÉPOND normalement dans la fenêtre de 24 h ; seules les
 * conversations que l'entreprise ouvre sont bloquées. Or le visiteur du widget écrit le premier, donc il ouvre
 * lui-même la fenêtre : griser sur BLOCKED éteindrait un widget qui marche.
 */
export function lienDuWidget(numero: NumeroDuWidget | null, phrase: string): string | null {
  if (numero === null || numero.delieLe !== null) return null;
  return lienWaMe(numero.displayPhoneNumber, phrase.trim());
}
