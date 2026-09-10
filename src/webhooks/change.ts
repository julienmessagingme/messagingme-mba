import { asArray, asRecord } from './json';

/**
 * Le point de passage OBLIGÉ pour lire un `change` d'un webhook Meta.
 *
 * 🔴 CE MODULE EXISTE À CAUSE D'UNE PANNE MUETTE DE DEUX JOURS (2026-09-08 au 2026-09-10). Quand le Meta
 * Business Agent tient le fil, Meta n'envoie plus `field: "messages"` mais `field: "standby"`, et il imbrique
 * `contacts`, `messages` et `statuses` D'UN NIVEAU PLUS PROFOND, sous `value.standby`. `metadata`, lui, reste
 * au premier niveau. Nos sept lecteurs lisaient `value.messages` : ils ne trouvaient rien, ne levaient rien,
 * et le job se terminait « avec succès ». Résultat mesuré : zéro message entrant et zéro statut de livraison
 * enregistrés pendant que l'agent de Meta répondait à tout le monde.
 *
 * ⚠️ LA FORME N'EST PLUS DEVINÉE. `handover.ts` disait d'elle « LA FORME DU PAYLOAD EST DEVINÉE », et c'est
 * exactement ce qui a coûté les deux jours : le code avait été écrit sur une supposition, et le commentaire
 * de `inbound.ts` affirmait même que « l'INBOX enregistre tout ». Le payload ci-dessous est celui que Meta a
 * réellement envoyé le 2026-09-10 à 15h34, sorti de la file de travail :
 *
 * ```json
 * {"entry":[{"id":"<waba_id>","changes":[{"field":"standby","value":{
 *   "standby":{"contacts":[{"wa_id":"33...","profile":{"name":"Julien"}}],
 *              "messages":[{"id":"wamid...","from":"33...","type":"text","text":{"body":"Ok"}}]},
 *   "metadata":{"phone_number_id":"...","display_phone_number":"..."},
 *   "messaging_product":"whatsapp"}}]}]}
 * ```
 *
 * 🔴 IL RÉTABLIT LA FORME, IL NE DÉCIDE RIEN. `field` est rendu tel quel, et les consommateurs qui doivent
 * se taire quand le MBA tient le fil (déclencheurs d'automation, avance de scénario, réponse de l'agent)
 * continuent de tester `field !== 'messages'`. Enregistrer n'est pas répondre : l'Inbox et les statuts
 * doivent tout voir, le reste doit rester muet.
 */
export interface ChangeWebhook {
  /** `field` du change : `'messages'`, `'standby'`, `'messaging_handovers'`... `null` si absent. */
  field: string | null;
  /**
   * La valeur EFFECTIVE : `contacts`, `messages` et `statuses` s'y lisent au PREMIER niveau, que le MBA
   * tienne le fil ou non. `metadata` y est conservé, y compris en standby où Meta le laisse à côté.
   */
  value: Record<string, unknown>;
}

/**
 * Les `changes` d'un payload, à plat, avec leur valeur remise à niveau.
 *
 * ⚠️ Ne lève JAMAIS : c'est de la donnée externe non fiable, une clé manquante donne un vide traversable.
 */
export function changesDuPayload(payload: unknown): ChangeWebhook[] {
  const out: ChangeWebhook[] = [];
  for (const entryRaw of asArray(asRecord(payload)['entry'])) {
    for (const changeRaw of asArray(asRecord(entryRaw)['changes'])) {
      const change = asRecord(changeRaw);
      const field = typeof change['field'] === 'string' ? (change['field'] as string) : null;
      out.push({ field, value: valeurEffective(change['value']) });
    }
  }
  return out;
}

/**
 * Remonte le contenu de `value.standby` au premier niveau.
 *
 * ⚠️ L'ORDRE DU SPREAD PORTE LA CORRECTION : `standby` est étalé EN DERNIER, donc ses clés gagnent, et
 * `metadata` (qui n'y figure pas) survit depuis le premier niveau. L'inverse rendrait un `value` sans
 * messages sur un payload standby, c'est-à-dire exactement la panne qu'on répare.
 *
 * ⚠️ Un payload NORMAL n'a pas de clé `standby` : `asRecord` rend alors `{}` et l'objet ressort inchangé.
 * C'est ce qui rend cette fonction sûre à poser sur TOUS les lecteurs, y compris ceux qui ne verront jamais
 * de standby.
 */
export function valeurEffective(valueRaw: unknown): Record<string, unknown> {
  const value = asRecord(valueRaw);
  return { ...value, ...asRecord(value['standby']) };
}
