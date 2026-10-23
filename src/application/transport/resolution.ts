import type { Correspondances } from './etat-auth';

/**
 * L'ADRESSE D'UN CLIENT QUI N'A JAMAIS ÉCRIT (plan 2026-10-23, tâche 1). Une réponse envoyée au NUMÉRO d'un contact
 * restait « En attente de ce message » sur son mobile (essai réel du 2026-10-22) : il faut son identifiant masqué, et
 * pour un inconnu aucun message reçu ne l'a appris. On le demande à WhatsApp avant d'écrire, et on le retient : l'envoi
 * qui suit passe par `adresseDeReponse`, qui le retrouve.
 */

/**
 * Ce que rend `onWhatsApp` de Baileys 6.7.23 (`Socket/chats.js`) : seulement les numéros PRÉSENTS sur WhatsApp (il
 * filtre `!!contact`), donc un absent ne rend AUCUNE entrée et non `exists: false`, et la liste peut manquer.
 */
export interface SocketVerification {
  onWhatsApp(...jids: string[]): Promise<{ jid: string; exists: unknown; lid?: unknown }[] | undefined>;
}

/** L'identifiant masqué rendu par WhatsApp (`attrs.val` du protocole « lid »), ou `null` pour une forme inconnue. */
function lidValide(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (/^[0-9]{1,30}@lid$/.test(v)) return v;
  return /^[0-9]{1,30}$/.test(v) ? `${v}@lid` : null;
}

/**
 * Le numéro est-il sur WhatsApp ? S'il l'est et que WhatsApp donne son identifiant masqué, il est retenu.
 *
 * 🔴 Seulement sous le numéro que WhatsApp CONFIRME (relecture du lot A). Il normalise certains numéros (Brésil, Mexique) :
 * retenu sous la forme demandée, l'identifiant écraserait la correspondance d'un contact connu sous sa forme canonique, et
 * ses réponses repartiraient à son numéro, donc « En attente » sur son mobile.
 */
export async function resoudreDestinataire(
  sock: SocketVerification, c: Pick<Correspondances, 'retenir'>, numero: string,
): Promise<{ present: true; lid: string | null } | { present: false }> {
  if (!/^[0-9]{8,15}$/.test(numero)) throw new Error('numéro invalide');
  const trouve = (await sock.onWhatsApp(`${numero}@s.whatsapp.net`))?.[0];
  if (!trouve) return { present: false };
  const confirme = trouve.jid.split('@')[0]?.split(':')[0] === numero;
  const lid = confirme ? lidValide(trouve.lid) : null;
  if (lid) await c.retenir(lid, numero);
  return { present: true, lid };
}
