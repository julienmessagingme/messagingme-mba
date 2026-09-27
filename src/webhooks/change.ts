import { asRecord } from './json';

/**
 * 🔴 Le point de passage obligé pour lire un `change` d'un webhook Meta. Quand le Meta Business Agent tient le
 * fil, Meta envoie `field: "standby"` et imbrique `contacts`, `messages` et `statuses` un niveau plus bas, sous
 * `value.standby` ; `metadata` reste au premier niveau. Lire `value.messages` directement ne trouve rien, sans
 * erreur : aucun message entrant ni statut ne serait enregistré. Forme réelle reçue de Meta :
 *
 * ```json
 * {"entry":[{"id":"<waba_id>","changes":[{"field":"standby","value":{
 *   "standby":{"contacts":[{"wa_id":"33...","profile":{"name":"Client"}}],
 *              "messages":[{"id":"wamid...","from":"33...","type":"text","text":{"body":"Ok"}}]},
 *   "metadata":{"phone_number_id":"...","display_phone_number":"..."},
 *   "messaging_product":"whatsapp"}}]}]}
 * ```
 *
 * Il rétablit la forme sans rien décider : `field` est rendu tel quel, et les consommateurs qui doivent se taire
 * quand le MBA tient le fil testent toujours `field !== 'messages'`. L'Inbox et les statuts voient tout.
 */

/**
 * Remonte le contenu de `value.standby` au premier niveau. L'ordre du spread porte la correction : `standby`
 * étalé en dernier, ses clés gagnent, et `metadata` (qui n'y figure pas) survit du premier niveau. Un payload
 * normal n'a pas de `standby` et ressort inchangé : la fonction est sûre sur tous les lecteurs.
 */
export function valeurEffective(valueRaw: unknown): Record<string, unknown> {
  const value = asRecord(valueRaw);
  return { ...value, ...asRecord(value['standby']) };
}
