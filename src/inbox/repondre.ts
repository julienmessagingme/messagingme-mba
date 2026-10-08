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
import { auteurDeLEnvoi, type AuteurDuChangement } from './evenements';

/** Ce que la réponse lit et écrit des conversations. */
export interface ConversationsRepondre {
  getConversationContext(
    conversationId: string,
    tenantId: string,
  ): Promise<{ waId: string; lastInboundAt: string | null; windowOpen: boolean } | null>;
  recordOutbound(
    conversationId: string,
    body: string,
    messageId: string | null,
    /** D'où vient le message. Obligatoire : déduite, elle a menti dès qu'un appelant sans expéditeur humain est
    *  apparu (le serveur MCP). */
    origine: OrigineMessage,
    type?: string,
    templateCategory?: string | null,
    templateName?: string | null,
    senderUserId?: string | null,
    /** Canal de la bulle. Absent -> WhatsApp. */
    channel?: 'whatsapp' | 'rcs',
    /**
     * Ce que l'opérateur avait écrit avant de faire traduire. `body`, lui, porte ce qui est parti. Absent -> les
     * deux sont la même chose, ce qui est le cas de tout envoi non traduit.
     */
    redactionOrigine?: string | null,
  ): Promise<void>;
}

export interface DepsRepondre {
  inbox: ConversationsRepondre;
  repo: { getTenantPhoneNumberId(tenantId: string): Promise<string | null> };
  sendReply(tenantId: string, phoneNumberId: string, to: string, text: string): Promise<string>;
  /**
   * Prend le fil. `par` : qui écrit, l'opérateur ou la machine (`auteurDeLEnvoi`), pour le journal du panneau
   * Détail de l'Inbox, qui dit « prise à l'agent de Meta par ... ».
   */
  takeControl(tenantId: string, waId: string, par: AuteurDuChangement): Promise<void>;
  /**
   * 🔴 Ce contact a-t-il demandé à ne plus être contacté ? Requise, lue seulement pour une origine machine :
   * la réponse d'un opérateur ne paie aucune requête.
   */
  estDesabonne(tenantId: string, waId: string): Promise<boolean>;
  /**
   * « Mon application répond » (lot 12, B) : le fil est-il tenu par l'application du client ? Lue seulement pour l'origine
   * `api` : sa réponse ne prend alors pas le fil, et le message suivant du client lui revient (`ControleDuFil`).
   */
  filTenuParLApplication(tenantId: string, waId: string): Promise<boolean>;
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
  const ctx = await deps.inbox.getConversationContext(conversationId, tenantId);
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

  const phoneNumberId = await deps.repo.getTenantPhoneNumberId(tenantId);
  if (!phoneNumberId) return { refus: { motif: 'aucun_numero' } };

  const messageId = await deps.sendReply(tenantId, phoneNumberId, ctx.waId, texte);
  // Le fil est pris : le scénario cesse d'avancer tout seul sur ce contact et MBA cesse de répondre, quel que
  // soit le tiers qui écrit. Ce que ça n'arrête pas : une campagne (déclenchée par un opérateur) et un clic sur un
  // bouton de chaîne (geste explicite de l'abonné), dont le type de lancement reprend le fil
  // (`POLITIQUE_DE_LANCEMENT`, `src/workflow/lancements.ts`). Une automation ordinaire par mot-clé reste arrêtée.
  // Sauf la réponse de l'application à un fil qu'elle tient (mode « mon application répond ») : prendre le fil
  // l'écarterait de la conversation, et le message suivant du client irait à « À traiter » au lieu de lui revenir.
  const laisserALApplication = origine === 'api' && await deps.filTenuParLApplication(tenantId, ctx.waId).catch(() => false);
  if (!laisserALApplication) await deps.takeControl(tenantId, ctx.waId, auteurDeLEnvoi(origine, auteur)).catch(() => {});
  await deps.inbox.recordOutbound(conversationId, texte, messageId, origine, 'text', null, null, auteur, 'whatsapp', redactionOrigine);
  return { messageId };
}
