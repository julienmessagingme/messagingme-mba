import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PreHandler } from '../auth/middleware';
import type { ConversationSummary, ConversationMessage, ListConversationsOptions } from '../inbox/store.pg';
import type { OutboundCarouselCard } from '../meta/template-components';
import { scopeTenant, nonEmpty } from './scope';
import { RCS_TEXTE_MAX } from '../rcs/schema';
import { peutEcrire, peutAffecter } from '../inbox/assignment';

/** Template à envoyer dans une conversation (hors fenêtre 24 h). */
export interface OutboundTemplate {
  name: string;
  language: string;
  /** Valeurs des variables du corps {{1}}, {{2}}... dans l'ordre. */
  bodyParams: string[];
  /** URL publique du média de header (image/vidéo/document), si le template en a un. */
  headerMediaUrl?: string;
  /** Format du header média, pour construire le bon type de paramètre côté Meta. */
  headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  /** Cartes d'un template CAROUSEL, visuels DÉJÀ re-téléversés (`mediaId`). Absent = template classique. */
  carousel?: { cards: OutboundCarouselCard[] };
}

export interface InboxRouteDeps {
  listConversations(tenantId: string, opts?: ListConversationsOptions): Promise<ConversationSummary[]>;
  /** Nombre de conversations non lues (pastille du menu). Optionnel : absent -> 0, la pastille ne s'affiche pas. */
  countUnread?(tenantId: string): Promise<number>;
  /** Nombre de conversations « À traiter ». Optionnel : absent -> le compteur n'est pas rendu. */
  countATraiter?(tenantId: string): Promise<number>;
  /**
   * À qui la conversation est confiée. `undefined` = conversation inconnue, `null` = confiée à personne.
   * Optionnelle : absente, aucune conversation n'est considérée comme affectée et tout le monde écrit,
   * c'est-à-dire exactement le comportement d'avant l'affectation.
   */
  getAssignee?(tenantId: string, conversationId: string): Promise<string | null | undefined>;
  /** Affecte (ou libère avec `null`). `false` = conversation inconnue, ou membre étranger au tenant. */
  setAssignee?(tenantId: string, conversationId: string, assignee: string | null, parUserId: string | null): Promise<boolean>;
  /** Marque un fil comme lu (un opérateur vient de l'ouvrir). Optionnel (deps de test minimales). */
  markConversationRead?(tenantId: string, conversationId: string): Promise<void>;
  /** wa_id + état de la fenêtre de service 24 h + surcharge de reprise du fil (C.4). null si conversation absente/autre tenant. */
  getConversationContext(
    conversationId: string,
    tenantId: string,
  ): Promise<{ waId: string; lastInboundAt: string | null; windowOpen: boolean } | null>;
  /** Pose/retire la surcharge de reprise d'UN fil (C.4). null = suit le défaut du tenant. Optionnel (deps de test minimales). */
  getMessages(conversationId: string): Promise<ConversationMessage[]>;
  /**
   * Un opérateur vient d'écrire : il PREND le fil. Posé depuis la route et non depuis le store, parce que
   * seule la route sait qu'un humain authentifié est à l'origine de l'envoi. Sans condition `only` : un
   * humain prend toujours la main, y compris sur MBA (côté Meta, envoyer suffit à prendre le contrôle).
   * Optionnel pour ne pas casser les suites de tests qui construisent des deps minimales.
   */
  takeControl?(tenantId: string, waId: string): Promise<void>;
  /**
   * L'opérateur REND la main : la conversation repart en automatique. Renvoie qui la détient désormais.
   *
   * Quand MBA sera actif sur le numéro, c'est ici qu'il faudra aussi appeler `thread_control` avec
   * l'action `release` côté Meta, pour que l'agent redevienne le répondeur principal. Aujourd'hui la
   * fonction se contente de l'état local, ce qui est exactement ce qu'il faut sans MBA.
   */
  releaseControl?(tenantId: string, waId: string): Promise<'app_workflow' | 'mba'>;
  /** Détenteur courant du fil, pour l'afficher dans le détail de la conversation. */
  getControlOwner?(tenantId: string, waId: string): Promise<'app_workflow' | 'app_human' | 'mba'>;
  recordOutbound(
    conversationId: string,
    body: string,
    messageId: string | null,
    type?: string,
    templateCategory?: string | null,
    templateName?: string | null,
    senderUserId?: string | null,
    /** Canal de la bulle. Absent -> WhatsApp. */
    channel?: 'whatsapp' | 'rcs',
  ): Promise<void>;
  /** Numéro du tenant depuis lequel répondre. */
  getTenantPhoneNumberId(tenantId: string): Promise<string | null>;
  /**
   * Variables d'un template DÉJÀ résolues sur la fiche de ce contact, avec le libellé du champ qui les
   * alimente. C'est ce que l'écran d'envoi affiche : l'opérateur voit les vraies valeurs, pas `{{1}}`.
   *
   * OPTIONNELLE : absente, l'écran retombe sur des champs vides à remplir à la main (comportement d'avant).
   */
  resolveTemplateParams?(
    tenantId: string,
    waId: string,
    template: { name: string; language: string; count: number },
  ): Promise<{ values: string[]; labels: string[] }>;
  /**
   * Envoie un message de la bibliothèque RCS à ce contact, variables résolues sur sa fiche.
   *
   * Rend `{ messageId, apercu }` quand c'est parti, ou `{ refus }` avec une raison DESTINÉE À L'OPÉRATEUR
   * (canal éteint, message supprimé depuis, contact désabonné du RCS). Optionnelle : absente, la route
   * répond 422 « canal RCS non disponible » au lieu de 500 sur des deps de test minimales.
   */
  sendRcsFromInbox?(
    tenantId: string,
    waId: string,
    contenu: { rcsMessageId: string } | { text: string },
  ): Promise<{ messageId: string; apercu: string } | { refus: string }>;
  /** Envoie une réponse texte (fenêtre de service 24 h). `tenantId` -> token Meta PAR TENANT (B1). Retourne le message_id. */
  sendReply(tenantId: string, phoneNumberId: string, to: string, text: string): Promise<string>;
  /** Envoie un template (autorisé hors fenêtre). `tenantId` -> token Meta PAR TENANT. Retourne le message_id. */
  sendTemplateMessage(tenantId: string, phoneNumberId: string, to: string, tpl: OutboundTemplate): Promise<string>;
  /**
   * Template CAROUSEL : relit ses cartes chez Meta et prépare leurs visuels pour l'envoi (re-téléversement).
   * `null` = ce template n'est pas un carousel (envoi inchangé). `{ refus }` = il en est un mais n'est pas
   * envoyable, et la raison est destinée à l'opérateur.
   *
   * Pourquoi la route en dépend au lieu de laisser l'envoi échouer : sans re-téléversement, Meta ACCEPTE
   * l'envoi (200 + id) puis ne le livre jamais (131053). Un « envoyé » à l'écran sans message sur le
   * téléphone est exactement ce qu'on ne veut plus. Absente -> aucun carousel n'est envoyable depuis l'inbox.
   */
  prepareCarousel?(
    tenantId: string,
    name: string,
    language: string,
  ): Promise<{ cards: OutboundCarouselCard[] } | { refus: string } | null>;
  /**
   * Démarre un SCÉNARIO sur cette conversation (l'opérateur le déclenche depuis l'Inbox).
   *
   * `windowOpen` décide de ce qui est permis, et c'est toute la règle métier : fenêtre OUVERTE, le scénario
   * peut ouvrir par un message rapide ou un formulaire ; fenêtre FERMÉE, seul un scénario qui ouvre par un
   * template configuré peut partir, les autres seraient refusés par Meta (131047).
   *
   * Rendu : `true` = parti. Une CHAÎNE = pas parti, avec la raison exacte à montrer à l'opérateur.
   * `null` = scénario inconnu pour ce workspace. Absente -> la fonctionnalité est indisponible (503).
   */
  startWorkflow?(tenantId: string, workflowId: string, waId: string, windowOpen: boolean): Promise<true | string | null>;
}

/**
 * Boîte de réception : lister/lire une conversation, répondre (texte dans la fenêtre 24 h,
 * template hors fenêtre). Lectures + réponse ouvertes à tout compte authentifié.
 */
export function registerInbox(app: FastifyInstance, deps: InboxRouteDeps, requireAuth?: PreHandler): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.get('/tenants/:tenantId/conversations', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    // Query string = entrée NON FIABLE. Chaque paramètre est lu dans sa forme attendue et ignoré sinon : un
    // filtre mal formé doit rendre la page normale, jamais une page vide qui se lirait « aucune conversation ».
    const q = (req.query ?? {}) as { limit?: unknown; beforeAt?: unknown; beforeId?: unknown; aTraiter?: unknown; signalees?: unknown };
    const opts: ListConversationsOptions = {};
    const limit = Number(q.limit);
    if (Number.isInteger(limit) && limit > 0) opts.limit = limit;
    if (q.aTraiter === '1' || q.aTraiter === 'true') opts.aTraiter = true;
    if (q.signalees === '1' || q.signalees === 'true') opts.signalees = true;
    // Le curseur n'a de sens qu'ENTIER : une moitié rendrait une page arbitraire, donc on exige les deux.
    if (typeof q.beforeAt === 'string' && q.beforeAt !== '' && typeof q.beforeId === 'string' && q.beforeId !== '') {
      opts.before = { at: q.beforeAt, id: q.beforeId };
    }
    const conversations = await deps.listConversations(tenant, opts);
    // `assignedToMe` est calculé ICI plutôt que déduit à l'écran : la session du navigateur ne porte pas
    // d'identifiant d'utilisateur, et lui en ajouter un toucherait l'authentification pour un besoin
    // d'affichage. Le serveur, lui, sait déjà qui appelle.
    const moi = req.auth?.userId ?? null;
    return reply.code(200).send({
      conversations: conversations.map((c) => ({ ...c, assignedToMe: moi !== null && c.assignedTo === moi })),
    });
  });

  /**
   * Compteur « À traiter ». Route dédiée, même raison que le compteur de non-lus : l'écran le calculait sur
   * les conversations chargées, donc il plafonnait à la taille de la page et affichait moins que la réalité.
   * Déclarée AVANT `/conversations/:conversationId` : `todo-count` n'est pas un identifiant.
   */
  app.get('/tenants/:tenantId/conversations/todo-count', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ count: deps.countATraiter ? await deps.countATraiter(tenant) : 0 });
  });

  /**
   * Compteur de non-lus, pour la pastille du menu. Route DÉDIÉE et non un champ de la liste : le menu est
   * monté sur toutes les pages et la rafraîchit régulièrement, il ne doit pas rapatrier 100 conversations.
   * Déclarée AVANT `/conversations/:conversationId/...` : `unread-count` n'est pas un identifiant.
   */
  app.get('/tenants/:tenantId/conversations/unread-count', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ count: deps.countUnread ? await deps.countUnread(tenant) : 0 });
  });

  /** Un opérateur vient d'OUVRIR le fil : il est lu. C'est le seul événement qui éteint la pastille. */
  app.post('/tenants/:tenantId/conversations/:conversationId/read', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    if (!deps.markConversationRead) return reply.code(503).send({ error: 'suivi des non-lus indisponible sur cette instance' });
    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    await deps.markConversationRead(tenant, conversationId);
    return reply.code(200).send({ ok: true });
  });

  app.get('/tenants/:tenantId/conversations/:conversationId/messages', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    return reply.code(200).send({
      waId: ctx.waId,
      windowOpen: ctx.windowOpen,
      lastInboundAt: ctx.lastInboundAt,
      // Qui détient le fil : sans cette information, l'opérateur voit le scénario se taire sans comprendre
      // pourquoi et ne sait pas s'il doit rendre la main. Défaut `app_workflow` quand le dep est absent,
      // qui est l'état d'une conversation dont personne n'a pris le contrôle.
      controlOwner: deps.getControlOwner ? await deps.getControlOwner(tenant, ctx.waId) : 'app_workflow',
      // Surcharge de reprise de CE fil (C.4) : null = suit le défaut du tenant. L'inbox l'affiche pour que
      // l'opérateur sache si, à la reprise, ce fil précis restera à l'humain ou repartira au scénario.
      messages: await deps.getMessages(conversationId),
    });
  });

  /**
   * Cet acteur a-t-il le droit d'écrire dans cette conversation ? Rend un message d'erreur, ou `null` si
   * c'est permis.
   *
   * 🔴 Appelé par CHAQUE route qui écrit vers le client. C'est la seule barrière réelle : l'écran grise un
   * bouton, mais rien n'empêche d'appeler l'API directement. Sans dépendance `getAssignee` câblée, tout est
   * permis, c'est-à-dire le comportement d'avant l'affectation.
   */
  async function refusAffectation(req: FastifyRequest, tenant: string, conversationId: string): Promise<string | null> {
    if (!deps.getAssignee) return null;
    const assignee = await deps.getAssignee(tenant, conversationId);
    // `undefined` (conversation inconnue) est laissé aux gardes existantes des routes, qui rendent un 404
    // plus précis. On ne se prononce que sur une conversation qui existe.
    if (assignee === undefined) return null;
    if (peutEcrire({ userId: req.auth?.userId ?? null, role: req.auth?.role ?? null }, assignee)) return null;
    return 'Cette conversation est affectée à un autre membre de l’équipe.';
  }

  /**
   * Affecter une conversation à un membre, ou la libérer. Réservé aux managers et aux admins : c'est la
   * première prérogative réelle du rôle `manager`, qui n'accordait rien depuis sa création.
   */
  app.patch('/tenants/:tenantId/conversations/:conversationId/assignee', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.setAssignee) return reply.code(503).send({ error: 'affectation indisponible' });
    if (!peutAffecter({ userId: req.auth?.userId ?? null, role: req.auth?.role ?? null })) {
      return reply.code(403).send({ error: 'réservé aux managers et aux admins' });
    }
    const { conversationId } = req.params as { conversationId: string };
    const brut = (req.body as { assignee?: unknown } | null)?.assignee;
    // `null` explicite = libérer. Toute autre forme qu'une chaîne non vide est refusée : une valeur bancale
    // ne doit pas se traduire par une libération silencieuse, qui rouvrirait la conversation à tous.
    if (brut !== null && !nonEmpty(brut)) return reply.code(400).send({ error: 'assignee requis (identifiant de membre, ou null pour libérer)' });
    const assignee = brut === null ? null : (brut as string);
    const ok = await deps.setAssignee(tenant, conversationId, assignee, req.auth?.userId ?? null);
    if (!ok) return reply.code(404).send({ error: 'conversation inconnue, ou membre étranger à cet espace' });
    return reply.code(200).send({ conversationId, assignee });
  });

  app.post('/tenants/:tenantId/conversations/:conversationId/reply', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const text = (req.body as { text?: unknown } | null)?.text;
    if (!nonEmpty(text)) return reply.code(400).send({ error: 'text requis' });

    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    const refus = await refusAffectation(req, tenant, conversationId);
    if (refus) return reply.code(403).send({ error: refus, code: 'assigned_to_other' });
    // Hors fenêtre 24 h : Meta refuse le texte libre. On bloque et on dit les DEUX chemins qui restent.
    // Le message ne parlait que du template, alors que le même écran propose le RCS juste en dessous : un
    // opérateur croyait devoir faire approuver un template alors qu'il avait un chemin immédiat.
    // Le code `window_closed` ne bouge pas, l'écran s'en sert.
    if (!ctx.windowOpen) {
      return reply.code(422).send({ error: 'Fenêtre de 24 h fermée : envoie un template, ou un message RCS si le contact y est joignable.', code: 'window_closed' });
    }
    const phoneNumberId = await deps.getTenantPhoneNumberId(tenant);
    if (!phoneNumberId) return reply.code(400).send({ error: 'aucun numéro pour ce tenant' });

    const messageId = await deps.sendReply(tenant, phoneNumberId, ctx.waId, text);
    // L'opérateur prend le fil : le scénario cesse d'avancer sur ce contact, et une campagne ne l'écrasera
    // pas. Best-effort, APRÈS l'envoi réussi : un échec d'état ne doit pas faire croire à un message perdu.
    await deps.takeControl?.(tenant, ctx.waId).catch(() => {});
    await deps.recordOutbound(conversationId, text, messageId, 'text', null, null, req.auth?.userId ?? null);
    return reply.code(200).send({ messageId });
  });

  /**
   * Envoi d'un message RCS depuis une conversation.
   *
   * 🔴 Volontairement SANS garde de fenêtre 24 h, à la différence de `reply` : cette fenêtre est une règle de
   * WhatsApp, pas une règle du monde. Le RCS n'en a pas, et c'est précisément quand la fenêtre WhatsApp est
   * fermée qu'il devient le moyen de reprendre contact sans template à faire approuver.
   *
   * Le message vient de la BIBLIOTHÈQUE (comme un template vient de Meta) : un opérateur d'inbox n'a pas à
   * composer une carte, un visuel et des boutons dans une barre de réponse. Ses variables sont résolues sur la
   * fiche du contact, exactement comme dans une campagne.
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/send-rcs', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    // Deux formes, EXCLUSIVES : un message de la bibliothèque, ou une réponse écrite à la main. La seconde
    // existe parce qu'un contact joignable SEULEMENT en RCS n'était atteignable qu'à travers la bibliothèque :
    // l'opérateur ne pouvait pas répondre une phrase sur le canal où le client venait de lui parler.
    const corps = (req.body ?? {}) as { rcsMessageId?: unknown; text?: unknown };
    const aId = nonEmpty(corps.rcsMessageId);
    const aTexte = nonEmpty(corps.text);
    if (aId === aTexte) return reply.code(400).send({ error: 'rcsMessageId OU text requis, pas les deux' });
    // Même borne que le schéma RCS : refuser ici plutôt que d'aller se faire refuser par le fournisseur.
    if (aTexte && (corps.text as string).trim().length > RCS_TEXTE_MAX) {
      return reply.code(400).send({ error: `texte trop long (${RCS_TEXTE_MAX} caractères maximum)` });
    }
    const contenu = aId ? { rcsMessageId: (corps.rcsMessageId as string).trim() } : { text: (corps.text as string).trim() };

    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    const refusAff = await refusAffectation(req, tenant, conversationId);
    if (refusAff) return reply.code(403).send({ error: refusAff, code: 'assigned_to_other' });
    if (!deps.sendRcsFromInbox) return reply.code(422).send({ error: 'canal RCS non disponible' });

    const issue = await deps.sendRcsFromInbox(tenant, ctx.waId, contenu);
    // 422 et non 5xx : c'est une situation à corriger par l'opérateur (canal éteint, contact désabonné), et
    // Cloudflare remplacerait le corps d'un 5xx par sa page d'erreur, donc la raison n'arriverait jamais.
    if ('refus' in issue) return reply.code(422).send({ error: issue.refus });

    // L'opérateur prend le fil, comme sur une réponse texte. Best-effort et APRÈS l'envoi réussi : un échec
    // d'état ne doit pas faire croire à un message perdu.
    await deps.takeControl?.(tenant, ctx.waId).catch(() => {});
    await deps.recordOutbound(conversationId, issue.apercu, issue.messageId, 'rcs', null, null, req.auth?.userId ?? null, 'rcs');
    return reply.code(200).send({ messageId: issue.messageId });
  });

  /**
   * Variables d'un template, résolues pour CE contact.
   *
   * 🔴 Pourquoi cette route existe. L'écran d'envoi de l'Inbox demandait les variables une par une, en texte
   * libre, sans dire ce qu'elles attendaient : l'opérateur devait se souvenir que `{{1}}` était le prénom et
   * le retaper, alors que la fiche du contact le porte et que le template dit déjà quel champ l'alimente
   * (`template_param_hints`, posés à la création). On rend donc les valeurs DÉJÀ remplies, avec le libellé du
   * champ à côté, et elles restent modifiables.
   */
  app.get('/tenants/:tenantId/conversations/:conversationId/template-params', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const q = req.query as { name?: string; language?: string; count?: string };
    if (!nonEmpty(q.name) || !nonEmpty(q.language)) return reply.code(400).send({ error: 'name et language requis' });
    const count = Number(q.count ?? 0);
    if (!Number.isInteger(count) || count < 0 || count > 20) return reply.code(400).send({ error: 'count invalide' });

    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    if (!deps.resolveTemplateParams || count === 0) return reply.code(200).send({ values: [], labels: [] });

    const r = await deps.resolveTemplateParams(tenant, ctx.waId, { name: q.name as string, language: q.language as string, count });
    return reply.code(200).send(r);
  });

  // Envoi d'un template dans une conversation (le seul moyen de ré-engager hors fenêtre 24 h).
  app.post('/tenants/:tenantId/conversations/:conversationId/send-template', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const b = (req.body ?? {}) as Partial<{
      templateName: string;
      language: string;
      bodyParams: unknown;
      headerMediaUrl: unknown;
      headerFormat: unknown;
      templateCategory: unknown;
    }>;
    if (!nonEmpty(b.templateName)) return reply.code(400).send({ error: 'templateName requis' });
    if (!nonEmpty(b.language)) return reply.code(400).send({ error: 'language requis' });
    let bodyParams: string[] = [];
    if (b.bodyParams !== undefined) {
      if (!Array.isArray(b.bodyParams) || !b.bodyParams.every((x) => typeof x === 'string')) {
        return reply.code(400).send({ error: 'bodyParams invalide (tableau de chaînes)' });
      }
      bodyParams = b.bodyParams as string[];
    }
    const headerMediaUrl = nonEmpty(b.headerMediaUrl) ? b.headerMediaUrl : undefined;
    const headerFormat =
      b.headerFormat === 'IMAGE' || b.headerFormat === 'VIDEO' || b.headerFormat === 'DOCUMENT' ? b.headerFormat : undefined;
    // Catégorie du template (pour les stats) : normalisée en minuscules marketing|utility.
    const catRaw = typeof b.templateCategory === 'string' ? b.templateCategory.toLowerCase() : '';
    const templateCategory = catRaw === 'marketing' || catRaw === 'utility' ? catRaw : null;

    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    const refusTpl = await refusAffectation(req, tenant, conversationId);
    if (refusTpl) return reply.code(403).send({ error: refusTpl, code: 'assigned_to_other' });
    const phoneNumberId = await deps.getTenantPhoneNumberId(tenant);
    if (!phoneNumberId) return reply.code(400).send({ error: 'aucun numéro pour ce tenant' });

    // Carousel : ses cartes ne sont pas dans la requête, elles se relisent chez Meta, et leurs visuels doivent
    // être re-téléversés. Un refus (carte sans visuel exploitable, variable de carte) sort en 422 AVANT
    // l'envoi : mieux vaut le dire que laisser Meta accepter un message qu'il ne livrera pas.
    let carousel: { cards: OutboundCarouselCard[] } | undefined;
    if (deps.prepareCarousel) {
      const prep = await deps.prepareCarousel(tenant, b.templateName, b.language);
      if (prep && 'refus' in prep) return reply.code(422).send({ error: prep.refus });
      if (prep) carousel = prep;
    }

    const messageId = await deps.sendTemplateMessage(tenant, phoneNumberId, ctx.waId, {
      name: b.templateName,
      language: b.language,
      bodyParams,
      ...(headerMediaUrl ? { headerMediaUrl } : {}),
      ...(headerFormat ? { headerFormat } : {}),
      ...(carousel ? { carousel } : {}),
    });
    // Même prise de main que sur la réponse texte : un template envoyé à la main est un acte d'opérateur.
    await deps.takeControl?.(tenant, ctx.waId).catch(() => {});
    await deps.recordOutbound(conversationId, `[template] ${b.templateName}`, messageId, 'template', templateCategory, b.templateName, req.auth?.userId ?? null);
    return reply.code(200).send({ messageId });
  });

  /**
   * Lance un SCÉNARIO sur cette conversation. L'opérateur clique, donc il doit savoir TOUT DE SUITE si c'est
   * parti et sinon pourquoi : la raison est rendue telle quelle en 422, jamais un 200 muet.
   *
   * C'est l'état RÉEL de la fenêtre au moment du clic qui décide, pas ce que l'écran croyait afficher : la
   * liste proposée est filtrée côté navigateur, mais un fil peut sortir de la fenêtre entre l'affichage et
   * le clic. Le serveur reste le juge.
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/workflow', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const workflowId = (req.body as { workflowId?: unknown } | null)?.workflowId;
    if (!nonEmpty(workflowId)) return reply.code(400).send({ error: 'workflowId requis' });
    if (!deps.startWorkflow) return reply.code(503).send({ error: 'lancement de scénario indisponible sur cette instance' });

    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    // Lancer un scénario ÉCRIT au client : même règle que répondre à la main.
    const refusWf = await refusAffectation(req, tenant, conversationId);
    if (refusWf) return reply.code(403).send({ error: refusWf, code: 'assigned_to_other' });

    const issue = await deps.startWorkflow(tenant, workflowId, ctx.waId, ctx.windowOpen);
    if (issue === null) return reply.code(404).send({ error: 'scénario inconnu' });
    // Une CHAÎNE porte la raison exacte du refus (ouverture par un message de session hors fenêtre, scénario
    // vide, bloc de départ supprimé, template introuvable chez Meta...). On l'affiche telle quelle.
    if (typeof issue === 'string') return reply.code(422).send({ error: issue });
    return reply.code(200).send({ ok: true });
  });

  /**
   * L'opérateur rend la main : le scénario (ou, demain, l'agent de Meta) reprend la conversation.
   *
   * Sans cette route, le seul chemin de retour serait le garde-fou d'inactivité : un opérateur qui règle
   * une question en deux minutes devrait attendre le délai configuré avant que l'automatisme reparte.
   */
  app.post('/tenants/:tenantId/conversations/:conversationId/release', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (!ctx) return reply.code(404).send({ error: 'conversation inconnue' });
    if (!deps.releaseControl) return reply.code(503).send({ error: 'reprise indisponible sur cette instance' });
    const owner = await deps.releaseControl(tenant, ctx.waId);
    return reply.code(200).send({ controlOwner: owner });
  });

}
