/**
 * RÉPONDRE dans la fenêtre de service de 24 h. Une seule implémentation, deux appelants.
 *
 * 🔴 C'est LE point de cette extraction, et il vaut plus que le code qu'elle déplace. La console appelait
 * cette séquence depuis sa route d'inbox ; le serveur MCP doit faire exactement la même chose, et la
 * recopier aurait été la faute que ce dépôt paie déjà (l'audit du 2026-08-18 a retiré une centaine de
 * copies). Une copie qui dérive ici ne produit pas un affichage bancal : elle produit un agent tiers qui
 * envoie des WhatsApp avec des garde-fous différents de ceux de l'interface. La règle du lot MCP est
 * celle-ci, écrite une fois : un outil MCP n'a JAMAIS de logique métier à lui, il appelle la fonction que
 * la route de console appelle.
 *
 * L'ordre des quatre gestes n'est pas indifférent, et il est repris tel quel de la route :
 *   1. la conversation existe et appartient à cet espace (sinon on ne dit rien de plus, cf. IDOR) ;
 *   2. la fenêtre est ouverte (Meta refuse le texte libre en dehors, autant refuser AVANT d'appeler) ;
 *   3. l'envoi ;
 *   4. la prise du fil et le journal, APRÈS l'envoi réussi et en best-effort : un échec d'état ne doit
 *      jamais faire croire à un message perdu alors qu'il est parti.
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
     * Ce que l'opérateur avait ÉCRIT avant de faire traduire (migration 0137).
     *
     * ⚠️ EN DERNIÈRE POSITION ET OPTIONNELLE, donc un câblage qui l'oublie compile toujours : c'est
     * le piège connu de ce dépôt (une flèche à moins de paramètres est assignable à un contrat qui
     * en déclare plus, et le reste est avalé en silence). Les deux câblages de `src/index.ts` la
     * transmettent, et l'intégration le vérifie sur la vraie base plutôt que sur un faux.
     */
    redactionOrigine?: string | null,
  ): Promise<void>;
  takeControl?(tenantId: string, waId: string): Promise<void>;
}

/**
 * Le refus est TYPÉ, pas une chaîne libre : la route HTTP doit en faire un code de statut (404 / 422 / 400)
 * et l'outil MCP un message d'erreur lisible par un agent. Une chaîne unique aurait obligé l'un des deux à
 * deviner, et c'est ainsi qu'une fenêtre fermée finit en 500.
 */
export type RefusReponse =
  | { motif: 'conversation_inconnue' }
  | { motif: 'fenetre_fermee' }
  | { motif: 'aucun_numero' };

export type ResultatReponse = { messageId: string } | { refus: RefusReponse };

/**
 * `auteur` = l'identifiant de l'humain qui écrit, ou `null` quand ce n'est pas un humain (un agent tiers via
 * MCP). Il finit dans `sender_user_id`, qui décide de la pastille d'auteur dans l'inbox.
 *
 * 🔴 `origine` est SÉPARÉE d'`auteur` et obligatoire, et cette séparation est le correctif d'un vrai bug.
 * On la déduisait d'`auteur` (« pas d'auteur, donc un scénario »), ce qui a fait enregistrer les réponses
 * de l'agent MCP comme du scripté. Les deux champs répondent à deux questions différentes : QUI signe le
 * message dans l'inbox, et QU'EST-CE QUI l'a écrit. Un agent tiers ne signe personne, et n'est pas un
 * scénario pour autant.
 */
export async function repondreDansLaFenetre(
  deps: DepsRepondre,
  tenantId: string,
  conversationId: string,
  texte: string,
  auteur: string | null,
  origine: OrigineMessage,
  /**
   * 🔴 `texte` EST CE QUI PART, y compris quand il a été traduit : c'est ce que le client recevra, et
   * notre trace doit y correspondre le jour d'un litige. `redactionOrigine` garde ce que l'opérateur
   * avait écrit avant de faire traduire, sans quoi il ne peut plus se relire.
   *
   * `null` (le cas de tous les appelants d'avant ce lot, et de tout envoi non traduit) : rien de plus
   * n'est enregistré, `body` est à la fois ce qui est parti et ce qui a été écrit.
   */
  redactionOrigine: string | null = null,
): Promise<ResultatReponse> {
  const ctx = await deps.getConversationContext(conversationId, tenantId);
  if (ctx === null) return { refus: { motif: 'conversation_inconnue' } };
  if (!ctx.windowOpen) return { refus: { motif: 'fenetre_fermee' } };

  const phoneNumberId = await deps.getTenantPhoneNumberId(tenantId);
  if (!phoneNumberId) return { refus: { motif: 'aucun_numero' } };

  const messageId = await deps.sendReply(tenantId, phoneNumberId, ctx.waId, texte);
  // Le fil est PRIS : le scénario cesse d'avancer tout seul sur ce contact, et MBA cesse de répondre. Vrai
  // aussi quand c'est un agent tiers qui écrit : ce qui compte est qu'un tiers parle, pas lequel.
  //
  // ⚠️ Ce que ça n'arrête PAS, et ce commentaire a affirmé le contraire jusqu'au 2026-09-02 : une CAMPAGNE
  // part quand même. C'est délibéré et écrit dans `executor.ts` (`ignoreHumanControl`) : la campagne est
  // déclenchée par un opérateur, donc c'est un humain qui a la main, et elle REPREND la conduite du fil pour
  // pouvoir avancer ensuite. Deux règles écrites en sens contraire valent moins qu'une seule, même imparfaite.
  // Le câblage réel est gardé par `tests/campagne-controle-humain.test.ts`.
  //
  // ⚠️ ET DEPUIS LE 2026-09-08, un CLIC SUR UN BOUTON DE CHAÎNE non plus : l'abonné a fait un geste explicite
  // vers ce scénario, et sans ça son clic ne lançait rien dès que le fil était tenu. Gardé par
  // `tests/automation-chaine-reprend-la-main.test.ts`. Une automation ordinaire par mot-clé, elle, reste bien
  // arrêtée par la prise de main.
  await deps.takeControl?.(tenantId, ctx.waId).catch(() => {});
  await deps.recordOutbound(conversationId, texte, messageId, origine, 'text', null, null, auteur, 'whatsapp', redactionOrigine);
  return { messageId };
}
