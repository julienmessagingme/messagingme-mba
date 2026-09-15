import { cacheCourt } from '../lib/cache-court';

/**
 * LE NUMÉRO META DE L'ESPACE, DEMANDÉ UNE FOIS ET PAS UNE FOIS PAR DESTINATAIRE.
 *
 * 🔴 CE QUE ÇA COÛTAIT. `getTenantPhoneNumberId` est un `select ... limit 1` sur `phone_numbers`, et le
 * câblage du runtime de scénario l'appelait à CHAQUE envoi : cinq sites le faisaient dans la boucle. Sur une
 * campagne de 5 000 destinataires, cela fait 5 000 requêtes pour une réponse qui ne bouge pas. Le pool
 * applicatif porte 8 connexions pour TOUT le process, partagées par les campagnes (4 en vol), les tours
 * d'agent (12) et les webhooks (3) : ces requêtes-là ne tombent pas dans le vide, elles prennent la place
 * d'autre chose.
 *
 * 🔴 ON NE MET EN CACHE QUE LES RÉPONSES POSITIVES, ET C'EST LA DÉCISION QUI REND CE CACHE SÛR.
 *
 * `cache-court.ts` prévient que son cache « convient à ce qui tolère d'être en retard de quelques secondes,
 * jamais à une décision ». Le numéro d'envoi EST une décision. Ce qui lève l'objection n'est pas la durée de
 * vie, c'est l'asymétrie des deux réponses :
 *
 * - une réponse POSITIVE ne devient fausse que si le numéro change d'espace. Vérifié : le seul écrit qui
 *   puisse changer la réponse est l'`insert` de l'Embedded Signup (`src/account/es-store.pg.ts`), les autres
 *   `update` de `phone_numbers` ne touchent aucune colonne lue ici. Et si elle devenait fausse, l'envoi
 *   échouerait VISIBLEMENT chez Meta, il ne partirait pas au mauvais endroit en silence ;
 * - une réponse NULLE, elle, devient fausse au moment exact où un client branche son premier numéro. La
 *   mettre en cache gèlerait « aucun numéro » pendant toute sa durée de vie, dans le WORKER, alors que
 *   l'écriture a lieu dans l'API : les deux process ont chacun leur cache et rien ne les synchronise, donc
 *   aucune invalidation ne peut rattraper ça. Un client qui vient de connecter son numéro et lance une
 *   campagne la verrait échouer sans comprendre.
 *
 * D'où la règle : `null` est relu à chaque fois. Un espace sans numéro paie une requête par appel, ce qui est
 * sans conséquence puisqu'il ne peut de toute façon rien envoyer.
 *
 * ⚠️ PAR PROCESS, comme tout `cacheCourt`. L'API et le worker ont chacun le leur.
 */

/**
 * Durée de vie du cache.
 *
 * ⚠️ Elle borne la seule fenêtre de risque qui reste (un numéro déplacé d'un espace à l'autre pendant qu'il
 * est en cache), qui n'est pas un geste de production mais d'embarquement.
 */
export const NUMERO_ESPACE_TTL_MS = 60_000;

/**
 * Rend l'accesseur mis en cache. UNE instance par process : deux instances auraient deux caches, donc deux
 * fois les requêtes qu'on vient d'économiser.
 */
export function creerNumeroDeLEspace(
  lire: (tenantId: string) => Promise<string | null>,
  ttlMs: number = NUMERO_ESPACE_TTL_MS,
  maintenant: () => number = Date.now,
): (tenantId: string) => Promise<string | null> {
  const cache = cacheCourt<string | null>(ttlMs, maintenant);
  return async function numeroDeLEspace(tenantId: string): Promise<string | null> {
    const numero = await cache.lire(tenantId, () => lire(tenantId));
    // La mutualisation des appels en vol a déjà joué pour les appels simultanés ; on retire seulement la
    // valeur nulle de la DURÉE DE VIE, pour qu'elle ne soit pas resservie plus tard.
    if (numero === null) cache.invalider(tenantId);
    return numero;
  };
}
