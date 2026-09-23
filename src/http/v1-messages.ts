import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { normalizePhone } from '../crm/phone';
import { repondreDansLaFenetre, type DepsRepondre } from '../inbox/repondre';
import { TEXTE_MAX_CARACTERES } from '../traduction/traduire';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';

/**
 * API PUBLIQUE /v1 DES MESSAGES : envoyer un simple texte dans la fenêtre de service de 24 h.
 *
 * Lot 7 de la liste de Julien du 2026-09-23. Ce que le produit exposait jusqu'ici, c'était `POST /v1/sends`,
 * c'est-à-dire un TEMPLATE approuvé ou un scénario, vers un lot de destinataires. Il manquait le geste le
 * plus simple, et le seul que l'on fait en répondant à quelqu'un : une phrase, à une personne qui vient
 * d'écrire.
 *
 * 🔴 ELLE N'A AUCUNE LOGIQUE À ELLE, ET C'EST TOUT LE POINT. Les quatre gestes (la fenêtre, le
 * désabonnement, l'envoi, la trace dans l'Inbox) vivent dans `repondreDansLaFenetre`, qui sert déjà la
 * console et le serveur MCP. Recopier cette séquence ici aurait produit un TROISIÈME jeu de garde-fous sur
 * le même chemin d'envoi, et c'est la faute que ce dépôt paie déjà (l'audit du 2026-08-18 a retiré une
 * centaine de copies). Le jour où la règle de la fenêtre change, elle change pour les trois d'un coup.
 *
 * 🔴 LE CONTACT BLOQUÉ EST ÉCARTÉ PAR `ouvrirConversation`, PAS PAR UNE GARDE DE PLUS ICI. C'est la même
 * fonction que le bouton « Ouvrir la conversation » du mini-CRM (lot 6) : elle refuse un contact supprimé
 * comme un contact bloqué, parce qu'un fil qu'on ne peut plus voir ne doit pas non plus pouvoir recevoir.
 * Une seconde garde écrite ici aurait pu diverger de celle-là, et un contact bloqué aurait reçu un message
 * par une porte pendant qu'on le lui refusait par l'autre.
 *
 * ⚠️ AUCUN `Idempotency-Key`, À LA DIFFÉRENCE DE `/v1/sends`, et c'est délibéré. Un envoi de campagne est un
 * lot coûteux dont le rejeu duplique jusqu'à 50 destinataires, d'où l'en-tête obligatoire ; un message de
 * session est le pendant exact de la barre de réponse de l'Inbox, qui n'en a pas non plus (un opérateur qui
 * double-clique envoie deux fois). Imposer l'en-tête ici aurait fait de « envoyer un simple message » la
 * route la plus cérémonieuse de l'API.
 */
export interface V1MessagesRouteDeps {
  /**
   * Les dépendances de `repondreDansLaFenetre`, passées telles quelles.
   *
   * 🔴 OBJET IMBRIQUÉ, TRANSMIS D'UN SEUL COUP, jamais recopié champ par champ. Un `Pick<>` recopié pour
   * être RETRANSMIS est une liste à tenir alignée à la main, et elle dérive : vécu en production le
   * 2026-09-02, deux capacités câblées dans le worker et absentes du contrat, donc jamais vues par le
   * moteur. Ici, la capacité qu'on perdrait en l'oubliant s'appelle `estDesabonne`.
   */
  repondre: DepsRepondre;
  /** Le contact de ce numéro, dans cet espace. `null` = inconnu (il n'a jamais écrit). */
  findContactByPhone(tenantId: string, phoneE164: string): Promise<{ id: string } | null>;
  /**
   * Le fil de ce contact, créé s'il n'existe pas. `null` = contact supprimé, bloqué, ou sans identité
   * joignable. MÊME fonction que le bouton « Ouvrir la conversation » du mini-CRM.
   */
  ouvrirConversation(tenantId: string, contactId: string): Promise<string | null>;
  /**
   * Le garde d'usage, injecté au bootstrap. OBLIGATOIRE, comme sur les deux autres modules /v1 :
   * optionnel, il manquerait un jour à une route et le compteur de cette route disparaîtrait sans bruit.
   */
  usage: ApiUsageGuard;
}

/**
 * ⚠️ `safeParse`, JAMAIS `parse`, et jamais un `as` sur ce corps : c'est une entrée non fiable, au même
 * titre qu'un webhook (convention de code, CLAUDE.md global).
 */
const schemaMessage = z.object({
  /** Le numéro du destinataire. Normalisé ensuite : ce schéma ne vérifie que la forme la plus grossière. */
  to: z.string().min(1).max(32),
  text: z.string().min(1).max(TEXTE_MAX_CARACTERES),
});

/**
 * Le tenant vient à 100 % de `req.auth` (posé par `makeRequireApiKey`), jamais de l'URL.
 * Guard attendu : `[makeRequireApiKey, requireScope('sends:create')]`.
 *
 * ⚠️ `sends:create` ET NON UN DROIT NEUF, et il faut dire ce que ça élargit. Les droits d'une clé se fixent
 * à sa CRÉATION et ne s'éditent pas : un droit neuf aurait obligé chaque intégrateur à refabriquer sa clé
 * pour un geste que son droit « Déclencher des envois » décrit déjà. La contrepartie est réelle et
 * assumée : une clé qui pouvait déclencher un template approuvé peut désormais écrire un texte libre, borné
 * par la fenêtre de 24 h (donc aux seules personnes qui viennent d'écrire) et par le désabonnement.
 */
export function registerV1Messages(app: FastifyInstance, deps: V1MessagesRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.post('/v1/messages', opts, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'clé d’API requise' });
    const tenantId = req.auth.tenantId;

    const valide = schemaMessage.safeParse(req.body);
    if (!valide.success) {
      return reply.code(400).send({ error: 'to (numéro) et text (1 à 4096 caractères) requis' });
    }
    // ⚠️ `PhoneResult` a ses DEUX champs optionnels, donc `'error' in tel` ne narrow rien : c'est `e164`
    // qu'il faut interroger, sinon on passerait `undefined` a la recherche de contact.
    const { e164, error } = normalizePhone(valide.data.to);
    if (!e164) return reply.code(400).send({ error: error ?? 'numero invalide' });

    // Compté APRÈS la validation, comme sur `/v1/contacts` : un corps malformé n'a demandé aucun travail.
    if (!await compterOuRefuser(deps.usage, req, reply, 'messages.send')) return reply;

    const contact = await deps.findContactByPhone(tenantId, e164);
    /**
     * ⚠️ 404 ET NON 422 : un numéro inconnu de cet espace n'a par construction jamais écrit, donc sa fenêtre
     * ne peut pas être ouverte. Le dire ainsi évite à l'intégrateur de chercher du côté de la fenêtre un
     * défaut qui est du côté du contact. ⚠️ Et on ne CRÉE pas le contact au passage, à la différence de
     * `/v1/sends` : là-bas l'envoi est un template, qui part hors fenêtre et fonde donc une relation ; ici
     * l'envoi ne peut réussir que si la relation existe déjà.
     */
    if (!contact) return reply.code(404).send({ error: 'aucun contact pour ce numéro', code: 'contact_inconnu' });

    const conversationId = await deps.ouvrirConversation(tenantId, contact.id);
    if (!conversationId) {
      return reply.code(409).send({ error: 'ce contact est bloqué ou supprimé', code: 'contact_indisponible' });
    }

    /**
     * `auteur` à `null` : personne ne SIGNE ce message dans l'Inbox, aucun opérateur ne l'a écrit.
     * `origine` à `'api'` : c'est le système du client qui parle (migration 0166). Les deux champs
     * répondent à deux questions différentes, et les confondre a déjà fait enregistrer les réponses de
     * l'agent MCP comme du scripté (migration 0101).
     */
    const res = await repondreDansLaFenetre(deps.repondre, tenantId, conversationId, valide.data.text, null, 'api');
    if ('refus' in res) {
      if (res.refus.motif === 'contact_desabonne') {
        return reply.code(409).send({ error: 'ce contact a demandé à ne plus recevoir de messages', code: 'contact_desabonne' });
      }
      if (res.refus.motif === 'aucun_numero') {
        return reply.code(409).send({ error: 'aucun numéro WhatsApp sur cet espace', code: 'aucun_numero' });
      }
      /**
       * ⚠️ `conversation_inconnue` EST INATTEIGNABLE ICI et se traite quand même : le fil vient d'être
       * ouvert par la ligne du dessus, avec le même espace. Sans branche explicite, un motif ajouté demain
       * sortirait sous le message « fenêtre fermée », c'est-à-dire une raison fausse rendue à un
       * intégrateur, qui chercherait un template à faire approuver pour rien. Le repli est le refus le plus
       * général qui reste.
       */
      if (res.refus.motif === 'conversation_inconnue') {
        return reply.code(404).send({ error: 'conversation introuvable', code: 'conversation_inconnue' });
      }
      return reply.code(422).send({
        error: 'fenêtre de 24 h fermée : ce contact n’a pas écrit récemment. Utilisez un template (POST /v1/sends).',
        code: 'window_closed',
      });
    }
    return reply.code(200).send({ messageId: res.messageId, conversationId });
  });
}
