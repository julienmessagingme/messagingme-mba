import { classifyWaId } from '../crm/identity';
import { aDesLiensTracables } from '../links/rcs-liens';
import { TTL_MS } from './reachability';
import { apercuRcsSortant } from './schema';
import type { RcsSendOutcome } from './sender';
import type { RcsOutbound } from './types';
import { aDesVariables, appliquerVariables } from './variables';

/**
 * L'ENVOI D'UN RCS LIBRE : UNE implémentation, deux appelants (spec 2026-09-24, § 4).
 *
 * Le bouton RCS de l'Inbox (un OPÉRATEUR) et `POST /v1/messages/rcs` (une MACHINE) passent par ici, sur le
 * modèle de `repondreDansLaFenetre` pour WhatsApp : une copie des gardes dans la route de l'API aurait fait
 * deux jeux de règles sur le même envoi.
 *
 * L'ORDRE est celui de la spec : un numéro ; pas désabonné (en général ni du RCS) ; consenti OU a déjà écrit ;
 * canal actif ; pas connu injoignable (désabonnement général, consentement et joignabilité : pour une machine
 * seulement). Le contact inconnu et le contact bloqué sont refusés AVANT, par la route
 * de l'API (elle seule sait résoudre une fiche) ; l'Inbox part d'une conversation qui existe.
 *
 * 🔴 UNE MACHINE NE PARLE PAS À QUI N'A NI CONSENTI NI ÉCRIT, NI À QUI A DIT STOP ; UN OPÉRATEUR SI. Même
 * doctrine que `repondreDansLaFenetre` (décision du 2026-09-13) : la garde se pose sur « tout ce qui n'est pas
 * un opérateur humain », jamais sur une liste d'appelants. Le STOP RCS arrête quand même l'opérateur, par le
 * point de passage unique de l'envoi (`RcsSender.sendTo`).
 *
 * 🔴 LA JOIGNABILITÉ SE LIT DANS LE CACHE, DIRECTEMENT, ET POUR UNE MACHINE SEULEMENT. `RcsSender` saute ce
 * contrôle quand le fournisseur ne sait pas vérifier avant l'envoi (smsmode) : le cache n'est alors nourri que
 * par les rapports de livraison (`traiterRapportRcs`, qui écrit la clé en E.164). Un « injoignable » plus vieux
 * que `TTL_MS` ne refuse plus rien : un parc mobile bascule. L'OPÉRATEUR n'y est pas soumis : la spec (§ 17)
 * veut le bouton RCS de l'Inbox IDENTIQUE, et smsmode range en échec définitif un téléphone simplement éteint
 * (UNDELIVERED), qui aurait refusé l'opérateur sept jours durant sur un numéro redevenu joignable.
 */

export type RefusRcsLibre = 'rcs_not_enabled' | 'rcs_unreachable' | 'opted_out' | 'no_consent' | 'no_phone' | 'rcs_message_not_found';

export interface DepsRcsLibre {
  agentIdForTenant(tenantId: string): Promise<string | null>;
  /** STOP général. REQUISE ; lue seulement pour une origine machine. */
  estDesabonne(tenantId: string, waId: string): Promise<boolean>;
  /** STOP RCS (`contacts.rcs_optout_at`). Lue seulement pour une origine machine ; l'envoi la relit pour tous. */
  estDesabonneRcs(tenantId: string, e164: string): Promise<boolean>;
  /** A consenti (`opted_in`) OU nous a déjà écrit (un entrant, tout canal). Lue seulement pour une machine. */
  aConsentiOuEcrit(tenantId: string, waId: string): Promise<boolean>;
  /** Le cache de joignabilité, clé (agent, E.164). Lu seulement pour une origine machine. */
  lireJoignabilite(agentId: string, e164: string): Promise<{ reachable: boolean; checkedAt: number } | null>;
  lireMessageRcs(tenantId: string, id: string): Promise<{ content: RcsOutbound | null } | null>;
  variablesDeLaFiche(tenantId: string, waId: string): Promise<Record<string, string | null>>;
  jetonDuContact(tenantId: string, waId: string): Promise<string | undefined>;
  envoyer(tenantId: string, agentId: string, waId: string, msg: RcsOutbound, messageId: string, jeton?: string): Promise<RcsSendOutcome>;
  nouvelId(): string;
  maintenant(): number;
}

export async function envoyerRcsLibre(
  deps: DepsRcsLibre,
  tenantId: string,
  waId: string,
  contenu: { text: string } | { rcsMessageId: string },
  origine: 'humain' | 'api',
): Promise<{ messageId: string; apercu: string } | { refus: RefusRcsLibre }> {
  // Le RCS s'adresse à un NUMÉRO : un wa_id qui n'en est pas un (un BSUID) ne peut pas le recevoir.
  const { phoneE164 } = classifyWaId(waId);
  if (!phoneE164) return { refus: 'no_phone' };

  if (origine !== 'humain') {
    if ((await deps.estDesabonne(tenantId, waId)) || (await deps.estDesabonneRcs(tenantId, phoneE164))) return { refus: 'opted_out' };
    if (!(await deps.aConsentiOuEcrit(tenantId, waId))) return { refus: 'no_consent' };
  }

  const agentId = await deps.agentIdForTenant(tenantId);
  if (!agentId) return { refus: 'rcs_not_enabled' };

  // Machine seulement : le bouton RCS de l'Inbox reste identique (spec § 17, cf. le docblock).
  if (origine !== 'humain') {
    const connu = await deps.lireJoignabilite(agentId, phoneE164);
    if (connu && !connu.reachable && deps.maintenant() - connu.checkedAt <= TTL_MS) return { refus: 'rcs_unreachable' };
  }

  // Réponse LIBRE : rien à relire, rien à substituer. Une accolade tapée par erreur n'est pas un trou.
  let message: RcsOutbound;
  if ('text' in contenu) {
    message = { kind: 'text', text: contenu.text };
  } else {
    const enregistre = await deps.lireMessageRcs(tenantId, contenu.rcsMessageId);
    if (!enregistre?.content) return { refus: 'rcs_message_not_found' };
    message = aDesVariables(enregistre.content)
      ? appliquerVariables(enregistre.content, await deps.variablesDeLaFiche(tenantId, waId))
      : enregistre.content;
  }

  // QUI a cliqué : lu SEULEMENT si le message porte un lien tracé, et jamais bloquant.
  const jeton = aDesLiensTracables(message) ? await deps.jetonDuContact(tenantId, waId) : undefined;
  const issue = await deps.envoyer(tenantId, agentId, waId, message, deps.nouvelId(), jeton);
  if ('skipped' in issue) return { refus: issue.skipped === 'rcs_optout' ? 'opted_out' : 'rcs_unreachable' };
  return { messageId: issue.messageId, apercu: apercuRcsSortant(message) };
}

/**
 * La raison d'un refus, DESTINÉE À L'OPÉRATEUR de l'Inbox : « le canal n'est pas activé » et « ce contact s'est
 * désabonné » demandent deux gestes différents. Les quatre premières phrases sont celles qu'il lisait déjà.
 */
export function phraseOperateur(refus: RefusRcsLibre): string {
  switch (refus) {
    case 'rcs_not_enabled': return "Le canal RCS n'est pas activé sur cet espace (page d'accueil, sous le numéro WhatsApp).";
    case 'rcs_message_not_found': return 'Ce message RCS n’existe plus, ou son format n’est plus reconnu.';
    case 'opted_out': return 'Ce contact s’est désabonné du RCS (il a répondu STOP). Passez par WhatsApp.';
    case 'rcs_unreachable': return 'Ce contact n’est pas joignable en RCS.';
    case 'no_phone': return 'Ce contact n’a pas de numéro de téléphone : le RCS ne peut pas lui parvenir. Passez par WhatsApp.';
    case 'no_consent': return 'Ce contact n’a ni consenti ni jamais écrit.';
  }
}
