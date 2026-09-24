import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { repondreDansLaFenetre, type DepsRepondre } from '../inbox/repondre';
import { TEXTE_MAX_CARACTERES } from '../traduction/traduire';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import { STATUT_PAR_CODE, refuser } from '../api/erreurs';
import { MESSAGE_RESOLUTION, normaliserCles, schemaClesFiche, type ClesFiche, type ModeCreation, type ResolutionFiche } from '../api/fiche';
import { messageDeForme } from '../api/forme';

/**
 * API PUBLIQUE /v1 DES MESSAGES SIMPLES : `POST /v1/messages/whatsapp`, un texte, à UNE fiche, dans la
 * fenêtre de service de 24 h (spec 2026-09-24, § 4). Elle remplace `POST /v1/messages` : le canal se lit dans
 * l'adresse, jamais dans un paramètre, et la personne se désigne par sa FICHE (`contactId`, `externalId`,
 * `phone` ou `bsuid`). Son pendant RCS, `POST /v1/messages/rcs`, vit dans son propre module (`v1-messages-rcs.ts`) :
 * leurs règles n'ont presque rien en commun.
 *
 * 🔴 ELLE N'A AUCUNE LOGIQUE D'ENVOI À ELLE, ET C'EST TOUT LE POINT. Les gestes (la fenêtre, le désabonnement,
 * l'envoi, la trace dans l'Inbox) vivent dans `repondreDansLaFenetre`, qui sert déjà la console et le serveur
 * MCP. Le jour où la règle de la fenêtre change, elle change pour les trois d'un coup.
 *
 * 🔴 LA FICHE BLOQUÉE EST ÉCARTÉE PAR `ouvrirConversation`, PAS PAR UNE GARDE DE PLUS ICI : c'est la même
 * fonction que le bouton « Ouvrir la conversation » du mini-CRM, qui refuse une fiche supprimée comme une
 * fiche bloquée. Une seconde garde écrite ici aurait pu diverger de celle-là.
 *
 * ⚠️ ELLE NE CRÉE JAMAIS DE FICHE (`creer: 'jamais'`) : un message simple ne fonde pas une relation, un envoi
 * (`POST /v1/sends`) le fait. ⚠️ MAIS ELLE RATTACHE une clé neuve à la fiche trouvée (un `externalId`, un
 * numéro, un BSUID), comme toute résolution du lot 1 (spec § 1), ET MÊME QUAND LE MESSAGE EST ENSUITE REFUSÉ
 * (fiche bloquée, désabonnée, fenêtre fermée). C'est l'inverse de `/v1/contacts`, où un refus ne laisse rien :
 * le choix reste à trancher, et un cas de `tests/v1-messages.test.ts` fige le comportement actuel.
 *
 * ⚠️ AUCUNE CLÉ D'IDEMPOTENCE, À LA DIFFÉRENCE DE `/v1/sends`, et c'est délibéré : un message de session est le
 * pendant exact de la barre de réponse de l'Inbox, qui n'en a pas non plus.
 */
export interface V1MessagesRouteDeps {
  /**
   * Les dépendances de `repondreDansLaFenetre`, passées telles quelles.
   *
   * 🔴 OBJET IMBRIQUÉ, TRANSMIS D'UN SEUL COUP, jamais recopié champ par champ : un `Pick<>` recopié pour être
   * RETRANSMIS dérive. La capacité qu'on perdrait en l'oubliant s'appelle `estDesabonne`.
   */
  repondre: DepsRepondre;
  /** La résolution de fiche du lot 1, liée à ses dépendances par le câblage. */
  resoudreFiche(tenantId: string, cles: ClesFiche, opts: { creer: ModeCreation }): Promise<ResolutionFiche>;
  /**
   * Le fil de cette fiche, créé s'il n'existe pas. `null` = fiche supprimée, bloquée, ou sans identité
   * joignable. MÊME fonction que le bouton « Ouvrir la conversation » du mini-CRM.
   */
  ouvrirConversation(tenantId: string, contactId: string): Promise<string | null>;
  /** Le garde d'usage, injecté au bootstrap. OBLIGATOIRE, comme sur les autres modules /v1. */
  usage: ApiUsageGuard;
}

/**
 * ⚠️ `safeParse`, jamais `parse`, jamais un `as` sur ce corps. STRICT : l'ancienne forme `{ to, text }` est
 * refusée en nommant `to`, et un `tenantId` glissé dans le corps aussi (le tenant vient de la CLÉ).
 */
const schemaMessage = z.strictObject({
  ...schemaClesFiche.shape,
  text: z.string().min(1).max(TEXTE_MAX_CARACTERES),
});

/**
 * Le refus d'une résolution de fiche : le statut vient de la table des codes, le message de la résolution
 * PARTAGÉE (`MESSAGE_RESOLUTION`, lot 1), comme sur `/v1/contacts`. Une seule précision propre à cette route :
 * une fiche inconnue n'y est jamais créée, et le message dit où elle l'est. `POST /v1/messages/rcs` le reprend.
 */
export const INCONNUE_POUR_UN_MESSAGE = 'aucune fiche pour cette personne : un message simple ne crée pas de fiche, un envoi (POST /v1/sends) le fait';

/**
 * Le tenant vient à 100 % de `req.auth` (posé par `makeRequireApiKey`), jamais de l'URL ni du corps.
 * Garde attendue : `[makeRequireApiKey, requireScope('sends:create')]`.
 *
 * ⚠️ `sends:create` ET NON UN DROIT NEUF : les droits d'une clé se fixent à sa CRÉATION. La contrepartie est
 * assumée : une clé qui pouvait déclencher un template peut écrire un texte libre, borné par la fenêtre de
 * 24 h (donc aux seules personnes qui viennent d'écrire) et par le désabonnement.
 */
export function registerV1Messages(app: FastifyInstance, deps: V1MessagesRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.post('/v1/messages/whatsapp', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;

    const lu = schemaMessage.safeParse(req.body);
    if (!lu.success) return refuser(reply, 400, 'invalid_body', messageDeForme(lu.error));

    const { text, ...cles } = lu.data;
    // Les défauts de CLÉ (aucune clé, numéro illisible) sont des défauts de forme : refusés avant le compteur,
    // par la même normalisation que la résolution partagée.
    const n = normaliserCles(cles);
    if (!n.ok) return refuser(reply, STATUT_PAR_CODE[n.code], n.code, MESSAGE_RESOLUTION[n.code]);

    // Compté APRÈS la validation, comme sur `/v1/contacts` : un corps malformé n'a demandé aucun travail.
    if (!await compterOuRefuser(deps.usage, req, reply, 'messages.send')) return reply;

    const fiche = await deps.resoudreFiche(tenantId, cles, { creer: 'jamais' });
    if (!fiche.ok) {
      const message = fiche.code === 'unknown_contact' ? INCONNUE_POUR_UN_MESSAGE : MESSAGE_RESOLUTION[fiche.code];
      return refuser(reply, STATUT_PAR_CODE[fiche.code], fiche.code, message);
    }

    const conversationId = await deps.ouvrirConversation(tenantId, fiche.contactId);
    if (!conversationId) return refuser(reply, 409, 'blocked_contact', 'cette fiche est bloquée, supprimée, ou sans adresse WhatsApp');

    /**
     * `auteur` à `null` : personne ne SIGNE ce message dans l'Inbox. `origine` à `'api'` : c'est le système du
     * client qui parle (migration 0166).
     */
    const res = await repondreDansLaFenetre(deps.repondre, tenantId, conversationId, text, null, 'api');
    if (!('refus' in res)) return reply.code(200).send({ messageId: res.messageId, conversationId, channel: 'whatsapp' });
    const motif = res.refus.motif;
    switch (motif) {
      case 'contact_desabonne':
        return refuser(reply, 409, 'opted_out', 'cette personne a demandé à ne plus recevoir de messages');
      case 'aucun_numero':
        return refuser(reply, 409, 'no_whatsapp_number', 'aucun numéro WhatsApp sur cet espace');
      case 'conversation_inconnue':
        // Inatteignable : le fil vient d'être ouvert, avec le même espace. Traité quand même, jamais rangé
        // sous « fenêtre fermée », qui enverrait l'intégrateur faire approuver un template pour rien.
        return refuser(reply, 404, 'unknown_contact', 'conversation introuvable pour cette fiche');
      case 'fenetre_fermee':
        return refuser(reply, 422, 'window_closed', 'fenêtre de 24 h fermée : cette personne n’a pas écrit récemment. Utilisez un template (POST /v1/sends).');
      default: {
        // EXHAUSTIF : un motif ajouté demain à `RefusReponse` ne compile pas ici, au lieu de sortir sous une
        // raison fausse.
        const inconnu: never = motif;
        throw new Error(`motif de refus inconnu : ${String(inconnu)}`);
      }
    }
  });
}
