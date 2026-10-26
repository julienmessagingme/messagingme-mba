import type { InboxDep, InboxRouteDeps, OutboundTemplate } from '../http/inbox';
import type { AuteurDuChangement } from './evenements';
import { journaliserEnvoiAccepte, type EtatJournalSortant } from './journal-sortant';

/**
 * CE QU'UN OPÉRATEUR ENVOIE DANS UN FIL HORS DE LA RÉPONSE TEXTE : un modèle WhatsApp, un message RCS (audit de structure
 * du 2026-10-25, lot C du plan `docs/superpowers/plans/2026-10-26-audits-simplicite-structure.md`). Le pendant de
 * `repondreAvec` (`repondre.ts`) pour la réponse texte. Les routes (`send-template`, `send-rcs`) lisent le corps,
 * vérifient le fil et son affectation, puis traduisent l'issue ; le protocole vit ici (invariant 60 du manuel).
 */

/** Le fil où l'opérateur écrit, déjà relu dans l'espace et dont l'affectation a été contrôlée par la route. */
export interface FilOperateur {
  conversationId: string;
  waId: string;
}

/** Un refus porte le statut HTTP que la route rend tel quel, et le code que l'écran lit quand il y en a un. */
export type IssueEnvoiOperateur =
  | { ok: true; messageId: string; journal: EtatJournalSortant }
  | { ok: false; statut: 400 | 409 | 422; error: string; code?: string };

/**
 * Après un envoi que le fournisseur a accepté : prendre le fil, puis inscrire le message. La queue des envois d'un
 * opérateur et de `POST /v1/messages/rcs` ; la réponse texte (`repondreAvec`) garde la sienne, à cause de l'exception
 * du fil que tient l'application (`laisserALApplication`), voulue. 🔴 La prise du fil est au mieux : le message est parti, un échec d'état
 * ne doit pas faire croire à un message perdu ; l'inscription seule est rejouée, jamais l'envoi (invariant 59).
 */
export async function prendreLeFilPuisInscrire(
  deps: { takeControl(tenantId: string, waId: string, par: AuteurDuChangement): Promise<void> },
  tenantId: string,
  fil: FilOperateur,
  par: AuteurDuChangement,
  messageId: string,
  inscrire: () => Promise<void>,
): Promise<EtatJournalSortant> {
  await deps.takeControl(tenantId, fil.waId, par).catch(() => {});
  return journaliserEnvoiAccepte(tenantId, fil.conversationId, messageId, inscrire);
}

export type DepsEnvoiModeleDansLeFil = Pick<
  InboxRouteDeps,
  'repo' | 'estDesabonne' | 'categorieDuModele' | 'prepareCarousel' | 'sendTemplateMessage' | 'takeControl'
> & { inbox: Pick<InboxDep, 'recordOutbound'> };

/**
 * Un modèle envoyé par un opérateur dans un fil (le seul moyen de ré-engager hors de la fenêtre de 24 heures). Un modèle
 * envoyé à la main est un acte d'opérateur : il prend le fil, comme une réponse texte. `operateur` : l'utilisateur de la
 * session, jamais le corps de la requête.
 */
export async function envoyerModeleDansLeFil(
  deps: DepsEnvoiModeleDansLeFil,
  tenantId: string,
  fil: FilOperateur,
  modele: Omit<OutboundTemplate, 'carousel'>,
  operateur: string | null,
): Promise<IssueEnvoiOperateur> {
  const phoneNumberId = await deps.repo.getTenantPhoneNumberId(tenantId);
  if (!phoneNumberId) return { ok: false, statut: 400, error: 'aucun numéro pour ce tenant' };

  /**
   * 🔴 Un contact désabonné ne reçoit plus de modèle marketing, même envoyé à la main : un modèle rouvre une
   * conversation, le geste dont la personne a demandé qu'il cesse. Le service passe (livraison, rendez-vous, compte).
   * La catégorie est lue chez Meta, pas dans la requête, et un modèle dont la catégorie est illisible est refusé
   * (échouer fermé). Cette lecture n'a lieu que pour un contact désabonné. L'API et les campagnes, elles, n'écrivent
   * jamais à un désabonné : la différence est voulue.
   */
  if (await deps.estDesabonne(tenantId, fil.waId)) {
    const categorie = await deps.categorieDuModele(tenantId, modele.name, modele.language).catch(() => null);
    if (categorie !== 'utility') {
      return {
        ok: false,
        statut: 409,
        error: categorie === null
          ? 'ce contact s’est désabonné, et la catégorie de ce modèle n’a pas pu être vérifiée : l’envoi est refusé par prudence. Vous pouvez encore lui répondre à la main si la conversation est ouverte.'
          : 'ce contact s’est désabonné : seuls les modèles de catégorie « Service » peuvent encore lui être envoyés. Vous pouvez lui répondre à la main si la conversation est ouverte.',
        code: 'contact_desabonne',
      };
    }
  }

  // Carousel : ses cartes se relisent chez Meta et leurs visuels doivent être re-téléversés. Un refus (carte sans
  // visuel exploitable, variable de carte) sort en 422 avant l'envoi, plutôt qu'un message accepté jamais livré.
  const prep = await deps.prepareCarousel(tenantId, modele.name, modele.language);
  if (prep && 'refus' in prep) return { ok: false, statut: 422, error: prep.refus };

  const messageId = await deps.sendTemplateMessage(tenantId, phoneNumberId, fil.waId, { ...modele, ...(prep ? { carousel: prep } : {}) });
  const journal = await prendreLeFilPuisInscrire(deps, tenantId, fil, { collaborateur: operateur }, messageId, () =>
    deps.inbox.recordOutbound(fil.conversationId, `[template] ${modele.name}`, messageId, 'humain', 'template', modele.templateCategory ?? null, modele.name, operateur));
  return { ok: true, messageId, journal };
}

export type DepsEnvoiRcsDansLeFil = Pick<InboxRouteDeps, 'sendRcsFromInbox' | 'takeControl'> & {
  inbox: Pick<InboxDep, 'recordOutbound'>;
};

/**
 * Un message RCS envoyé par un opérateur dans un fil, sans garde de fenêtre de 24 heures (une règle de WhatsApp, le RCS
 * n'en a pas). Un refus (canal éteint, contact désabonné du RCS) est une situation à corriger par l'opérateur : 422.
 */
export async function envoyerRcsDansLeFil(
  deps: DepsEnvoiRcsDansLeFil,
  tenantId: string,
  fil: FilOperateur,
  contenu: { rcsMessageId: string } | { text: string },
  operateur: string | null,
): Promise<IssueEnvoiOperateur> {
  const issue = await deps.sendRcsFromInbox(tenantId, fil.waId, contenu);
  if ('refus' in issue) return { ok: false, statut: 422, error: issue.refus };
  const journal = await prendreLeFilPuisInscrire(deps, tenantId, fil, { collaborateur: operateur }, issue.messageId, () =>
    deps.inbox.recordOutbound(fil.conversationId, issue.apercu, issue.messageId, 'humain', 'rcs', null, null, operateur, 'rcs'));
  return { ok: true, messageId: issue.messageId, journal };
}
