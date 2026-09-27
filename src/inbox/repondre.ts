/**
 * Répondre dans la fenêtre de service de 24 h. Une seule implémentation pour la console et le serveur MCP :
 * un outil MCP n'a jamais de logique métier à lui, sinon un agent tiers enverrait des WhatsApp avec d'autres
 * garde-fous que l'interface.
 *
 * L'ordre des gestes compte :
 *   1. la conversation existe et appartient à cet espace (sinon rien de plus, IDOR) ;
 *   2. la fenêtre est ouverte (Meta refuse le texte libre en dehors : on refuse avant d'appeler) ;
 *   3. l'envoi ;
 *   4. la prise du fil et le journal, après l'envoi et en best-effort : un échec d'état ne doit jamais faire
 *      croire à un message perdu.
 */
import type { OrigineMessage } from './origine';

export interface DepsRepondre {
  getConversationContext(
    conversationId: string,
    tenantId: string,
  ): Promise<{ waId: string; lastInboundAt: string | null; windowOpen: boolean } | null>;
  getTenantPhoneNumberId(tenantId: string): Promise<string | null>;
  sendReply(tenantId: string, phoneNumberId: string, to: string, text: string): Promise<string>;
  recordOutbound(
    conversationId: string,
    body: string,
    messageId: string | null,
    origine: OrigineMessage,
    type?: string,
    templateCategory?: string | null,
    templateName?: string | null,
    senderUserId?: string | null,
    channel?: 'whatsapp' | 'rcs',
    /**
     * Ce que l'opérateur avait écrit avant de faire traduire. En dernière position et optionnel : un câblage
     * qui l'oublie compile quand même, l'intégration vérifie qu'il est transmis.
     */
    redactionOrigine?: string | null,
  ): Promise<void>;
  takeControl(tenantId: string, waId: string): Promise<void>;
  /**
   * 🔴 Ce contact a-t-il demandé à ne plus être contacté ? Requise, lue seulement pour une origine machine :
   * la réponse d'un opérateur ne paie aucune requête.
   */
  estDesabonne(tenantId: string, waId: string): Promise<boolean>;
}

/**
 * Le refus est typé : la route HTTP en fait un code de statut (404 / 422 / 400), l'outil MCP un message
 * lisible par un agent. Une chaîne unique obligerait l'un des deux à deviner.
 */
export type RefusReponse =
  | { motif: 'conversation_inconnue' }
  | { motif: 'fenetre_fermee' }
  | { motif: 'aucun_numero' }
  | { motif: 'contact_desabonne' };

export type ResultatReponse = { messageId: string } | { refus: RefusReponse };

/**
 * `auteur` = l'humain qui écrit, ou `null` (agent tiers via MCP) : il finit dans `sender_user_id` et signe le
 * message dans l'inbox. `origine` est séparée et obligatoire : elle dit ce qui l'a écrit, et un agent tiers
 * qui ne signe personne n'est pas un scénario pour autant.
 */
export async function repondreDansLaFenetre(
  deps: DepsRepondre,
  tenantId: string,
  conversationId: string,
  texte: string,
  auteur: string | null,
  origine: OrigineMessage,
  /**
   * `texte` est ce qui part, traduit ou non : c'est ce que le client recevra, notre trace doit y correspondre.
   * `redactionOrigine` garde ce que l'opérateur avait écrit avant traduction ; `null` pour un envoi non traduit.
   */
  redactionOrigine: string | null = null,
): Promise<ResultatReponse> {
  const ctx = await deps.getConversationContext(conversationId, tenantId);
  if (ctx === null) return { refus: { motif: 'conversation_inconnue' } };
  if (!ctx.windowOpen) return { refus: { motif: 'fenetre_fermee' } };

  /**
   * 🔴 Une machine ne parle pas à quelqu'un qui a dit STOP, un opérateur si : sans cette exception, il ne
   * pourrait même plus accuser réception d'un opt-out. La règle vise tout ce qui n'est pas un humain, pas une
   * liste d'appelants, pour qu'une nouvelle machine ne passe pas à travers. La requête n'est payée que par
   * l'origine machine.
   */
  if (origine !== 'humain' && await deps.estDesabonne(tenantId, ctx.waId)) {
    return { refus: { motif: 'contact_desabonne' } };
  }

  const phoneNumberId = await deps.getTenantPhoneNumberId(tenantId);
  if (!phoneNumberId) return { refus: { motif: 'aucun_numero' } };

  const messageId = await deps.sendReply(tenantId, phoneNumberId, ctx.waId, texte);
  // Le fil est pris : le scénario cesse d'avancer tout seul sur ce contact et MBA cesse de répondre, quel que
  // soit le tiers qui écrit. Ce que ça n'arrête pas : une campagne (`ignoreHumanControl` dans `executor.ts`,
  // déclenchée par un opérateur) et un clic sur un bouton de chaîne (geste explicite de l'abonné). Une
  // automation ordinaire par mot-clé reste arrêtée.
  await deps.takeControl(tenantId, ctx.waId).catch(() => {});
  await deps.recordOutbound(conversationId, texte, messageId, origine, 'text', null, null, auteur, 'whatsapp', redactionOrigine);
  return { messageId };
}
