import type { FastifyInstance } from 'fastify';
import { rcsOutboundSchema } from '../rcs/schema';
import type { Queue } from '../queue/queue';
import { createCampaignWithRecipients } from '../campaign/create';
import { avertissementPalier } from '../meta/palier';
import type { CampaignRepoLike } from '../campaign/create';
import type { CreateCampaignInput, CampaignSummary, CampaignDetail, PhoneNumberRow, RetryReset } from '../campaign/store.pg';
import type { CampaignCategory } from '../campaign/types';
import { validateParamMapping } from '../crm/template';
import { campaignJobExpireSeconds, resolveRatePerMinute } from '../campaign/pacing';
import { PLAFOND_DESTINATAIRES_DEFAUT, refusDePlafond } from '../campaign/plafond';
import { scanOpening } from '../workflow/engine';
import type { WorkflowGraph } from '../workflow/graph';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { scopeTenant, nonEmpty } from './scope';
// Le MÊME analyseur de cible que le mini-CRM : les destinataires d'une campagne se désignent exactement
// comme une action en masse, et deux analyseurs finiraient par ne plus viser la même chose.
import { parseBulkTarget } from './contacts';
import type { BulkTarget } from '../crm/contact-store.pg';

export interface CampaignRouteDeps {
  repo: CampaignRepoLike;
  queue: Queue;
  /**
   * Palier d'envoi du numéro de l'espace (`messaging_limit_tier`), pour AVERTIR avant un lancement trop gros.
   * Optionnel : absent -> aucun avertissement, comportement d'avant. Une panne de lecture ne doit jamais
   * empêcher de créer une campagne, d'où le repli silencieux côté appelant.
   */
  getMessagingLimitTier?(tenantId: string): Promise<string | null>;
  /**
   * Brouillons de COMPOSITION (une campagne qu'on est en train d'écrire). Rien à voir avec
   * `campaigns.status = 'draft'`, qui est une campagne complète et non lancée. OPTIONNEL : absent, les routes
   * de brouillon ne sont pas montées et l'écran retombe sur son comportement d'avant.
   */
  drafts?: {
    list(tenantId: string): Promise<Array<{ id: string; name: string; state: Record<string, unknown>; updatedAt: Date }>>;
    create(tenantId: string, name: string, state: Record<string, unknown>): Promise<{ id: string; name: string; state: Record<string, unknown>; updatedAt: Date }>;
    update(tenantId: string, id: string, name: string, state: Record<string, unknown>): Promise<boolean>;
    remove(tenantId: string, id: string): Promise<boolean>;
  };
  /** Le numéro appartient-il au tenant ? (empêche d'envoyer depuis le numéro d'autrui.) */
  phoneNumberBelongsToTenant(phoneNumberId: string, tenantId: string): Promise<boolean>;
  /**
   * Résout une CIBLE (filtres + exclusions, ou identifiants) en liste d'identifiants, dans la base.
   *
   * 🔴 C'est ce qui retire le piège des grosses sélections. L'écran proposait « tout sélectionner » jusqu'à
   * 100 000 contacts, rapatriait leurs identifiants dans le navigateur, et les renvoyait tous dans le corps
   * de la requête, plafonné à 1 Mo : le JSON des seuls identifiants pèse environ 975 Ko à 25 000 contacts.
   * La création échouait donc BIEN AVANT la limite que l'écran annonçait, et sans rien dire.
   *
   * Optionnelle : absente, seule la liste explicite d'identifiants reste acceptée (comportement d'avant).
   */
  contactIdsForTarget?(tenantId: string, target: BulkTarget, limite?: number): Promise<string[]>;
  /**
   * Les identifiants de TOUS les contacts de l'espace, BORNÉS (constat B4 de l'audit externe du 2026-09-02).
   *
   * 🔴 Pourquoi ce n'est plus un COMPTE. Le chemin « tous les contacts » comptait d'abord, validait le
   * plafond sur ce compte, puis chargeait les contacts PLUS TARD, dans une seconde requête. Entre les deux,
   * un import concurrent pouvait faire passer l'espace au-dessus du plafond : la campagne partait avec plus
   * de destinataires que ce que la validation avait autorisé, et personne ne le voyait. Un compte ne peut pas
   * fermer cette course, parce que ce n'est pas lui qu'on utilise ensuite.
   *
   * On résout donc les identifiants UNE fois, bornés à `plafond + 1`, et ce sont EXACTEMENT ceux-là que la
   * campagne emporte. Le `+ 1` est ce qui distingue « pile au plafond » de « au-dessus », sans jamais
   * matérialiser plus d'une ligne de trop.
   *
   * ⚠️ Cela borne aussi la MÉMOIRE : ce chemin chargeait l'intégralité du CRM dans le process à chaque
   * création de campagne, sans aucune limite.
   *
   * Absente du câblage -> ce chemin-là n'est pas plafonné, comme avant. Les deux autres le restent, leur
   * nombre étant connu sans requête.
   */
  identifiantsDeTousLesContacts?(tenantId: string, limite: number): Promise<string[]>;
  /** Plafond de destinataires. Absent -> le défaut de `src/campaign/plafond.ts` (20 000). */
  plafondDestinataires?: number;
  /** L'agent RCS appartient-il au tenant ? Même garde que pour le numéro : sans elle, un tenant enverrait
   *  sous la marque d'un autre. Absente du câblage -> aucune campagne RCS ne peut être créée. */
  rcsAgentBelongsToTenant?(agentId: string, tenantId: string): Promise<boolean>;
  /** Agents RCS du tenant (sélecteur de l'assistant). Absent -> liste vide. */
  listRcsAgents?(tenantId: string): Promise<Array<{ agentId: string; brandName: string; status: string }>>;
  /** La campagne appartient-elle au tenant ? (scope le run, 404 sinon.) */
  campaignBelongsTo(campaignId: string, tenantId: string): Promise<boolean>;
  /**
   * Le webhook entrant appartient-il au tenant, et est-il ACTIF ? Garde d'une campagne AU FIL DE L'EAU : sans
   * elle on brancherait une campagne sur l'adresse d'un autre espace. Absente du câblage -> aucune campagne au
   * fil de l'eau n'est créable, et le refus est explicite (jamais une campagne muette qui n'attrape rien).
   */
  webhookUsableByTenant?(webhookId: string, tenantId: string): Promise<boolean>;
  /** Arrête une campagne au fil de l'eau (scopée tenant) : elle cesse de prendre les arrivants. */
  stopWebhookCampaign?(campaignId: string, tenantId: string): Promise<boolean>;
  /** Suspend une campagne EN COURS d'envoi (scopée tenant, `running` uniquement). false = elle n'envoyait pas. */
  pauseCampaign?(campaignId: string, tenantId: string): Promise<boolean>;
  /** Lève la pause avant d'enfiler le run de reprise (`paused` uniquement, no-op ailleurs). */
  resumeCampaign?(campaignId: string, tenantId: string): Promise<boolean>;
  /** Dimensionnement du job de run : débit choisi + nb de destinataires en attente. null si campagne absente.
   *  Sert à calculer l'expireInSeconds du job (éviter qu'un run throttlé long expire et soit rejoué en parallèle). */
  getRunSizing(campaignId: string): Promise<{ ratePerMinute: number | null; pendingCount: number } | null>;
  /** Programme une campagne (draft/paused) pour un lancement futur (scopé tenant). true si programmée. */
  scheduleCampaign(campaignId: string, tenantId: string, scheduledAt: Date): Promise<boolean>;
  /** Annule une programmation (scopé tenant) : la campagne repasse en brouillon. true si annulée. */
  cancelSchedule(campaignId: string, tenantId: string): Promise<boolean>;
  /**
   * Graphe du workflow du tenant (campagne workflow). null si inconnu/autre tenant (le scope tenant vaut le
   * contrôle de propriété : un workflow d'un autre tenant renvoie null -> 400). Sert aussi à vérifier que le
   * bloc d'entrée est bien un envoi de template.
   */
  getWorkflowGraph(workflowId: string, tenantId: string): Promise<WorkflowGraph | null>;
  listCampaigns(tenantId: string, opts?: { archived?: boolean }): Promise<CampaignSummary[]>;
  /** Archive une campagne (scopée tenant) : masquée de la liste, conservée en base. true si elle était active. */
  archiveCampaign(campaignId: string, tenantId: string): Promise<boolean>;
  /** Sort une campagne de l'archive (scopée tenant). true si elle y était. */
  unarchiveCampaign(campaignId: string, tenantId: string): Promise<boolean>;
  /** Supprime pour de bon une campagne JAMAIS lancée (scopée tenant). false si la garde métier refuse. */
  deleteDraftCampaign(campaignId: string, tenantId: string): Promise<boolean>;
  getCampaignDetail(campaignId: string, tenantId: string): Promise<CampaignDetail | null>;
  /** Renvoi d'un destinataire en échec de variable de template (F7) : re-résout sur le contact à jour + remet en
   *  pending. Résultat discriminé (queued/not_found/not_retryable/missing_var/conflict). */
  resetRecipientForRetry(tenantId: string, campaignId: string, recipientId: string): Promise<RetryReset>;
  listPhoneNumbers(tenantId: string): Promise<PhoneNumberRow[]>;
  /** Débit par défaut (msg/min, 0 = opt-out) des campagnes sans ratePerMinute. Doit être le MÊME que celui
   *  injecté au worker (config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE), pour que l'estimation d'expiration et le
   *  throttle réel voient le même débit. Absent (tests) -> 0 = opt-out, comme avant ce défaut. */
  defaultRatePerMinute?: number;
}

const CATEGORIES = new Set<CampaignCategory>(['marketing', 'utility']);

function isCategory(v: unknown): v is CampaignCategory {
  return typeof v === 'string' && CATEGORIES.has(v as CampaignCategory);
}

/** Routes de campagne : lecture (liste/détail/numéros), création et déclenchement du run. */
export function registerCampaigns(app: FastifyInstance, deps: CampaignRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  /**
   * Brouillons de COMPOSITION. Montés seulement si la dépendance est câblée.
   *
   * Ces routes n'ont AUCUN effet d'envoi : elles n'écrivent qu'un nom et l'état d'un écran. Elles restent
   * pourtant réservées aux admins, comme tout ce groupe (`registerCampaigns` est monté avec `requireAdmin`) :
   * un brouillon de campagne est une campagne en devenir, il n'y a pas de raison d'ouvrir l'un sans l'autre.
   */
  const drafts = deps.drafts;
  if (drafts) {
    /** Nom d'un brouillon : non vide et borné. Le nom sert d'étiquette, il n'est jamais interprété. */
    const lireNom = (body: unknown): string | null => {
      const n = (body as { name?: unknown } | null)?.name;
      if (!nonEmpty(n)) return null;
      const nom = (n as string).trim();
      return nom.length <= 200 ? nom : null;
    };
    /** État de l'écran : un objet, jamais un tableau ni un scalaire. Absent -> objet vide. */
    const lireEtat = (body: unknown): Record<string, unknown> | null => {
      const s = (body as { state?: unknown } | null)?.state;
      if (s === undefined || s === null) return {};
      if (typeof s !== 'object' || Array.isArray(s)) return null;
      return s as Record<string, unknown>;
    };

    app.get('/tenants/:tenantId/campaign-drafts', guard, async (req, reply) => {
      const tenant = scopeTenant(req);
      if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
      return reply.code(200).send({ drafts: await drafts.list(tenant) });
    });

    app.post('/tenants/:tenantId/campaign-drafts', guard, async (req, reply) => {
      const tenant = scopeTenant(req);
      if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
      const nom = lireNom(req.body);
      if (nom === null) return reply.code(400).send({ error: 'name requis (texte non vide, 200 caractères max)' });
      const etat = lireEtat(req.body);
      if (etat === null) return reply.code(400).send({ error: 'state invalide (objet)' });
      return reply.code(201).send({ draft: await drafts.create(tenant, nom, etat) });
    });

    app.put('/tenants/:tenantId/campaign-drafts/:draftId', guard, async (req, reply) => {
      const tenant = scopeTenant(req);
      if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
      const nom = lireNom(req.body);
      if (nom === null) return reply.code(400).send({ error: 'name requis (texte non vide, 200 caractères max)' });
      const etat = lireEtat(req.body);
      if (etat === null) return reply.code(400).send({ error: 'state invalide (objet)' });
      const { draftId } = req.params as { draftId: string };
      // 404 et non création : un identifiant inconnu vient soit d'un brouillon supprimé, soit d'un autre
      // tenant. Créer à la volée sèmerait des brouillons chez autrui en devinant des identifiants.
      const maj = await drafts.update(tenant, draftId, nom, etat);
      if (!maj) return reply.code(404).send({ error: 'brouillon inconnu' });
      return reply.code(200).send({ updated: true, draftId });
    });

    app.delete('/tenants/:tenantId/campaign-drafts/:draftId', guard, async (req, reply) => {
      const tenant = scopeTenant(req);
      if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
      const { draftId } = req.params as { draftId: string };
      const supprime = await drafts.remove(tenant, draftId);
      if (!supprime) return reply.code(404).send({ error: 'brouillon inconnu' });
      return reply.code(200).send({ deleted: true, draftId });
    });
  }

  app.get('/tenants/:tenantId/campaigns', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    // `?archived=1` bascule sur la corbeille. Valeur venue de la query string, donc `unknown` : on n'accepte
    // QUE les deux formes explicites, tout le reste (y compris 'false', '0', 'oui') vaut « campagnes actives ».
    const q = (req.query ?? {}) as { archived?: unknown };
    const archived = q.archived === '1' || q.archived === 'true';
    return reply.code(200).send({ campaigns: await deps.listCampaigns(tenant, { archived }) });
  });

  app.get('/tenants/:tenantId/campaigns/:campaignId', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { campaignId } = req.params as { campaignId: string };
    const detail = await deps.getCampaignDetail(campaignId, tenant);
    if (!detail) return reply.code(404).send({ error: 'campagne inconnue' });
    return reply.code(200).send(detail);
  });

  app.get('/tenants/:tenantId/phone-numbers', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ phoneNumbers: await deps.listPhoneNumbers(tenant) });
  });

  // Agents RCS du tenant, pour le sélecteur de l'assistant de campagne. Monté ICI, à côté du listage des
  // numéros Meta : c'est le même besoin (« depuis quoi j'envoie ? »), vu du même écran, avec la même garde
  // de scope tenant. Absent du câblage -> liste vide, pas d'erreur (le canal RCS est alors simplement
  // inutilisable, ce que l'UI affiche).
  app.get('/tenants/:tenantId/rcs-agents', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ agents: deps.listRcsAgents ? await deps.listRcsAgents(tenant) : [] });
  });

  app.post('/tenants/:tenantId/campaigns', guard, async (req, reply) => {
    const effectiveTenant = scopeTenant(req);
    if (effectiveTenant === null) {
      return reply.code(403).send({ error: 'tenant interdit' });
    }
    if (forbidNonAdmin(req, reply)) return;

    const b = (req.body ?? {}) as Partial<{
      phoneNumberId: string;
      name: string;
      category: CampaignCategory;
      templateName: string;
      templateLanguage: string;
      paramMapping: unknown;
      contactIds: unknown;
      contactTarget: unknown;
      workflowId: string;
      ratePerMinute: unknown;
      channel: string;
      rcsAgentId: string;
      rcsMessage: unknown;
      webhookId: string;
    }>;

    if (!isCategory(b.category)) return reply.code(400).send({ error: 'category invalide (marketing|utility)' });

    // Canal. Absent = 'whatsapp' : un client qui ignore le canal garde le comportement historique. Un canal
    // INCONNU est refusé, jamais silencieusement ramené à WhatsApp (une campagne partie sur le mauvais canal
    // est irrattrapable).
    const channel = b.channel ?? 'whatsapp';
    if (channel !== 'whatsapp' && channel !== 'rcs') {
      return reply.code(400).send({ error: 'channel invalide (whatsapp|rcs)' });
    }
    const isRcs = channel === 'rcs';
    let rcsMessage: unknown;
    if (isRcs) {
      if (!nonEmpty(b.rcsAgentId)) return reply.code(400).send({ error: 'rcsAgentId requis pour une campagne RCS' });
      if (!deps.rcsAgentBelongsToTenant || !(await deps.rcsAgentBelongsToTenant(b.rcsAgentId as string, effectiveTenant))) {
        return reply.code(400).send({ error: 'rcsAgentId inconnu pour ce tenant' });
      }
      const parsed = rcsOutboundSchema.safeParse(b.rcsMessage);
      if (!parsed.success) return reply.code(400).send({ error: 'rcsMessage invalide' });
      rcsMessage = parsed.data;
      if (nonEmpty(b.workflowId)) {
        return reply.code(400).send({ error: "Une campagne RCS envoie un message direct. Le declenchement d'un scenario par campagne n'est pas disponible sur ce canal." });
      }
    }
    // Débit optionnel : entier 1..80 messages/min (le client ne peut que BAISSER sous le plafond métier).
    // Absent/null = aucun throttle. Rejette 0, 81, décimal, négatif -> 400 déterministe.
    let ratePerMinute: number | null | undefined;
    if (b.ratePerMinute !== undefined && b.ratePerMinute !== null) {
      const r = b.ratePerMinute;
      if (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > 80) {
        return reply.code(400).send({ error: 'ratePerMinute invalide (entier 1..80 ou null)' });
      }
      ratePerMinute = r;
    }
    // Numéro Meta : exigé sur WhatsApp uniquement. Une campagne RCS part d'un agent, pas d'un numéro.
    if (!isRcs && !nonEmpty(b.phoneNumberId)) return reply.code(400).send({ error: 'phoneNumberId requis' });
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    // Une campagne envoie SOIT un template SOIT un workflow (exactement un des deux). Sur RCS, ni l'un ni
    // l'autre : le message est porté par la campagne elle-même.
    const isWorkflow = nonEmpty(b.workflowId);
    if (isWorkflow) {
      const graph = await deps.getWorkflowGraph(b.workflowId as string, effectiveTenant);
      if (!graph) {
        return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
      }
      // Une campagne part sur une audience FROIDE : le 1er message doit être un template. Ce n'est PAS la même
      // chose qu'« exiger un bloc template en entrée » : un tag, une action ou une condition avant le template
      // n'envoient rien et ne changent donc rien. On juge sur ce qui OUVRE réellement, pas sur le type du 1er bloc.
      const scan = scanOpening(graph);
      if (scan.sessionOpen) {
        return reply.code(400).send({ error: "Ce scénario ouvre par un message rapide, une question ou un formulaire, qui exigent que le contact ait écrit dans les 24 h. Une campagne part sur une audience froide : il lui faut un envoi de template en ouverture." });
      }
      if (scan.waitBeforeTemplate) {
        return reply.code(400).send({ error: "Ce scénario attend avant son premier envoi : rien ne partirait au lancement. Pour différer une campagne, utilise « Plus tard » au moment de la lancer." });
      }
      // Un bloc RCS configuré ouvre à froid : il ne passe pas par WhatsApp, donc aucune fenêtre de 24 h ne
      // s'y applique. Exiger un template en ouverture fermait la porte à toute campagne RCS par scénario.
      if (!scan.firstTemplate && !scan.rcsOpen) {
        return reply.code(400).send({ error: 'Le scénario doit ouvrir par un envoi : un template WhatsApp, ou un message RCS.' });
      }
      // Les trois contrôles suivants portent sur le TEMPLATE d'ouverture : ils n'ont de sens que s'il y en a
      // un. Un scénario qui ouvre en RCS n'a aucun template à paramétrer.
      //
      // ⚠️ Surtout PAS un `return` nu ici : on est dans un handler Fastify, sortir sans répondre laisserait la
      // requête pendante jusqu'au timeout.
      if (scan.firstTemplate) {
        if (scan.ambiguousTemplate) {
          return reply.code(400).send({ error: "Ce scénario peut ouvrir sur plusieurs templates différents : impossible de savoir lequel paramétrer pour la campagne." });
        }
        // `unnamedOpeningTemplate` couvre AUSSI les branches : une condition dont une sortie mène à un template
        // sans nom laisserait ces destinataires sans message, tout en les comptant « envoyés ».
        if (scan.unnamedOpeningTemplate || String(scan.firstTemplate.data.templateName ?? '').trim() === '') {
          return reply.code(400).send({ error: "Un template d'ouverture du scénario n'est pas encore choisi." });
        }
      }
    } else if (!isRcs) {
      if (!nonEmpty(b.templateName)) return reply.code(400).send({ error: 'templateName ou workflowId requis' });
      if (!nonEmpty(b.templateLanguage)) return reply.code(400).send({ error: 'templateLanguage requis' });
    }

    // Campagne AU FIL DE L'EAU : les destinataires n'existent pas encore, ils arriveront un par un par ce
    // webhook entrant. Trois refus explicites plutôt qu'une campagne qui a l'air créée et n'attrape rien.
    let webhookId: string | undefined;
    if (nonEmpty(b.webhookId)) {
      if (!deps.webhookUsableByTenant) {
        return reply.code(400).send({ error: "Les campagnes alimentées par un webhook ne sont pas disponibles sur cette instance." });
      }
      if (!(await deps.webhookUsableByTenant(b.webhookId as string, effectiveTenant))) {
        return reply.code(400).send({ error: 'webhookId inconnu (ou désactivé) pour ce tenant' });
      }
      // Une liste figée ET un flux d'arrivants sont deux façons contradictoires de désigner les destinataires.
      // Accepter les deux en n'en honorant qu'une laisserait l'appelant croire que sa liste va partir.
      if (Array.isArray(b.contactIds) && b.contactIds.length > 0) {
        return reply.code(400).send({ error: "Une campagne alimentée par un webhook ne prend pas de liste de contacts : ses destinataires arrivent au fil de l'eau." });
      }
      webhookId = b.webhookId as string;
    }

    // Sélection de contacts optionnelle : tableau de chaînes non vides. Absent -> tous les contacts.
    let contactIds: string[] | undefined;
    // Le plafond est lu ICI, avant toute résolution de cible : il sert de BORNE aux requêtes de sélection,
    // pas seulement de verdict après coup. Une garde qui arrive après le chargement ne protège que la suite.
    const plafond = deps.plafondDestinataires ?? PLAFOND_DESTINATAIRES_DEFAUT;
    if (b.contactIds !== undefined) {
      if (!Array.isArray(b.contactIds) || !b.contactIds.every((x) => nonEmpty(x))) {
        return reply.code(400).send({ error: 'contactIds invalide (tableau d\'ids)' });
      }
      /**
       * 🔴 UNE LISTE VIDE N'EST PAS « TOUT LE MONDE ». Un tableau vide est truthy : il traversait la route,
       * et `createCampaignWithRecipients` le voyait vide puis retombait sur « charger tous les contacts de
       * l'espace ». Une sélection explicitement vide devenait donc une campagne à l'espace entier, ce qui
       * est le pire accident que ce chemin puisse produire.
       *
       * `contactIds` ABSENT continue de vouloir dire « tous les contacts » : c'est documenté et voulu. Ce
       * qu'on refuse, c'est de DÉSIGNER une liste et de n'y mettre personne.
       */
      if (b.contactIds.length === 0) {
        return reply.code(422).send({ error: 'Aucun contact ne correspond à cette sélection.' });
      }
      contactIds = b.contactIds as string[];
    }

    /**
     * CIBLE par intention (filtres + exclusions) plutôt que par liste d'identifiants.
     *
     * 🔴 Deux façons de désigner les mêmes destinataires ne peuvent pas coexister dans une requête : on
     * n'en honorerait qu'une, et l'appelant croirait avoir visé l'autre. Même doctrine que le refus
     * `webhookId` + `contactIds` juste au-dessus, et pour la même raison.
     */
    if (b.contactTarget !== undefined) {
      if (contactIds !== undefined) {
        return reply.code(400).send({ error: 'contactIds et contactTarget désignent tous les deux les destinataires : n’en envoyer qu’un.' });
      }
      if (webhookId) {
        return reply.code(400).send({ error: "Une campagne alimentée par un webhook ne prend pas de cible de contacts : ses destinataires arrivent au fil de l'eau." });
      }
      if (!deps.contactIdsForTarget) {
        return reply.code(400).send({ error: 'La désignation par filtres n’est pas disponible sur cette instance.' });
      }
      const target = parseBulkTarget(b.contactTarget);
      // `null` = aucune cible exploitable. On REFUSE plutôt que de retomber sur « tous les contacts » : une
      // cible mal formée qui viserait tout l'espace est exactement l'accident qu'on ne veut jamais.
      if (target === null) return reply.code(400).send({ error: 'contactTarget invalide (ids non vides, ou filters)' });
      // Borné à `plafond + 1` : ce chemin matérialisait jusqu'à 100 000 identifiants avant de se faire
      // refuser à 20 000 par le plafond, c'est-à-dire quatre-vingt mille lignes chargées pour rien.
      contactIds = await deps.contactIdsForTarget(effectiveTenant, target, plafond + 1);
      // Une cible qui ne résout personne est une erreur de l'appelant, pas une campagne à tout le monde :
      // sans ce refus, `contactIds` vide retomberait sur « tous les contacts » un peu plus bas.
      if (contactIds.length === 0) {
        return reply.code(422).send({ error: 'Aucun contact ne correspond à cette sélection.' });
      }
    }

    /**
     * 🔴 LE PLAFOND DE TAILLE (lot 3 du plan post-audit). Placé ICI parce que c'est le seul point où les
     * trois façons de désigner des destinataires se rejoignent : liste explicite, cible par filtres, et
     * « tous les contacts ». Trois vérifications séparées auraient fini par diverger, et c'est justement le
     * troisième chemin, le plus dangereux, qui n'était borné par rien.
     *
     * Une campagne au fil de l'eau est EXCLUE : elle naît vide, ses destinataires arrivent un par un par le
     * webhook, il n'y a rien à compter et le compte de l'espace n'aurait aucun rapport.
     */
    if (!webhookId) {
      /**
       * 🔴 « TOUS LES CONTACTS » RÉSOUT SES IDENTIFIANTS ICI, il ne les compte plus (constat B4 de l'audit
       * externe du 2026-09-02). Le compte et le chargement étaient deux requêtes séparées : un import
       * concurrent entre les deux faisait partir une campagne au-dessus du plafond qu'on venait de valider.
       * Ce n'est pas un défaut de la garde, c'est un défaut de ce qu'elle regardait : elle jugeait un nombre
       * que personne n'utilisait ensuite.
       *
       * En figeant le jeu d'identifiants, la garde juge EXACTEMENT ce que la campagne emportera. Conséquence
       * assumée et voulue : un contact créé après la validation n'entre plus dans la campagne. L'opérateur a
       * confirmé un nombre, il obtient ce nombre.
       */
      if (contactIds === undefined && deps.identifiantsDeTousLesContacts) {
        contactIds = await deps.identifiantsDeTousLesContacts(effectiveTenant, plafond + 1);
      }
      const vises = contactIds ? contactIds.length : 0;
      const refus = refusDePlafond(vises, plafond);
      if (refus) return reply.code(422).send({ error: refus });
    }

    // Le numéro doit appartenir au tenant (sinon envoi depuis le numéro d'un autre client). Sur RCS, c'est
    // l'agent qui a été contrôlé plus haut, il n'y a pas de numéro à vérifier.
    if (!isRcs && !(await deps.phoneNumberBelongsToTenant(b.phoneNumberId as string, effectiveTenant))) {
      return reply.code(400).send({ error: 'phoneNumberId inconnu pour ce tenant' });
    }

    // Valider paramMapping AVANT toute écriture. Pour un workflow AUSSI : le mapping cible les variables du 1er
    // template du workflow (résolues par contact -> pré-validation via buildRecipients, contacts sans la valeur
    // sautés). Invalide -> 400 déterministe (indépendant du nb de contacts), pas un 500.
    const paramMapping = validateParamMapping(b.paramMapping ?? []);
    if (paramMapping === null) {
      return reply.code(400).send({ error: 'paramMapping invalide (positions 1..N contiguës, sources valides)' });
    }

    const input: CreateCampaignInput = {
      tenantId: effectiveTenant,
      phoneNumberId: isRcs ? '' : (b.phoneNumberId as string),
      name: b.name,
      category: b.category,
      templateName: isWorkflow || isRcs ? '' : (b.templateName as string),
      templateLanguage: isWorkflow || isRcs ? '' : (b.templateLanguage as string),
      paramMapping,
      channel,
      ...(contactIds ? { contactIds } : {}),
      ...(isWorkflow ? { workflowId: b.workflowId as string } : {}),
      ...(ratePerMinute !== undefined ? { ratePerMinute } : {}),
      ...(isRcs ? { rcsAgentId: b.rcsAgentId as string, rcsMessage } : {}),
      ...(webhookId ? { webhookId } : {}),
    };
    const result = await createCampaignWithRecipients(input, deps.repo);
    // AVERTISSEMENT de palier (lot 7 du programme II) : dit AVANT ce que le moteur sait déjà gérer APRÈS (il
    // met la campagne en pause sur un code de plafond depuis le lot 1). Best-effort : une lecture en échec ne
    // doit pas empêcher de créer la campagne, elle n'ajoute qu'un message.
    let avertissement: string | undefined;
    if (deps.getMessagingLimitTier) {
      try {
        avertissement = avertissementPalier(await deps.getMessagingLimitTier(effectiveTenant), result.recipientCount);
      } catch { /* le palier est un confort, pas une condition */ }
    }
    return reply.code(201).send({ ...result, ...(avertissement ? { avertissement } : {}) });
  });

  app.post('/campaigns/:campaignId/run', guard, async (req, reply) => {
    if (forbidNonAdmin(req, reply)) return;
    const { campaignId } = req.params as { campaignId: string };
    const authTenant = req.auth?.tenantId ?? '';
    // Scope tenant : 404 si la campagne n'appartient pas à l'appelant (pas d'IDOR cross-tenant).
    if (!(await deps.campaignBelongsTo(campaignId, authTenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }

    // ÉTAPE 2 « plus tard » : un scheduledAt (ISO absolu UTC) programme au lieu de lancer tout de suite. Le
    // sweeper enfilera le run à l'échéance. Doit être une date FUTURE (une date passée = 400, pas un lancement
    // immédiat déguisé). La campagne passe en statut 'scheduled' (annulable via /cancel-schedule).
    const b = (req.body ?? {}) as { scheduledAt?: unknown };
    if (b.scheduledAt !== undefined && b.scheduledAt !== null) {
      if (typeof b.scheduledAt !== 'string') return reply.code(400).send({ error: 'scheduledAt invalide (ISO)' });
      const when = new Date(b.scheduledAt);
      if (Number.isNaN(when.getTime())) return reply.code(400).send({ error: 'scheduledAt invalide (date)' });
      if (when.getTime() <= Date.now()) return reply.code(400).send({ error: 'scheduledAt doit être dans le futur' });
      const ok = await deps.scheduleCampaign(campaignId, authTenant, when);
      if (!ok) return reply.code(409).send({ error: 'campagne non programmable (déjà en cours/terminée)' });
      return reply.code(202).send({ scheduled: true, campaignId, scheduledAt: when.toISOString() });
    }

    // Lancement IMMÉDIAT. Dimensionne l'expiration du job sur le travail réel (nb destinataires en attente /
    // débit choisi) : un run throttlé long ne doit pas expirer et être rejoué en parallèle. Absent -> défaut file.
    const sizing = await deps.getRunSizing(campaignId);
    const expireInSeconds = sizing
      ? campaignJobExpireSeconds(sizing.pendingCount, resolveRatePerMinute(sizing.ratePerMinute, deps.defaultRatePerMinute ?? 0))
      : undefined;
    // REPRISE d'une campagne en pause : la pause est levée AVANT l'enfilement, parce que le job refuse de
    // démarrer une campagne en pause (garde de `campaignRunJob`, qui empêche un job enfilé avant la pause de la
    // ressusciter). No-op sur un brouillon, donc l'appel est inconditionnel.
    await deps.resumeCampaign?.(campaignId, authTenant);
    // ⚠️ Deux POST /run concurrents empilent DEUX jobs, et les deux tourneront : rien ne déduplique ici (cf.
    // `Queue.enqueue`, où le `singletonKey` qu'on croyait protecteur a été retiré). Le claim atomique par
    // destinataire reste le seul garde-fou, et il ne garantit que l'absence de double-envoi, pas le débit.
    try {
      // `groupId` = l'espace : le plafond de concurrence par espace de la file s'applique aussi au lancement
      // manuel, sinon un client qui clique quatre fois occupe les quatre places (lot 5).
      await deps.queue.enqueue('campaign-run', { campaignId }, { ...(expireInSeconds ? { expireInSeconds } : {}), groupId: authTenant });
    } catch (err) {
      // L'enfilement a échoué APRÈS la levée de pause : on la RÉTABLIT. Sans ça la campagne resterait affichée
      // « en cours » sans qu'aucun job ne tourne, et « Reprendre » ne s'affiche pas sur une campagne en cours :
      // l'opérateur serait coincé. `pauseCampaign` est bornée à `running`, elle ne touche donc pas un brouillon.
      await deps.pauseCampaign?.(campaignId, authTenant);
      throw err;
    }
    return reply.code(202).send({ enqueued: true, campaignId });
  });

  /**
   * Renvoi d'UN destinataire en échec de variable de template (F7). Après que l'admin a corrigé la donnée du contact,
   * on re-résout le paramMapping sur le contact À JOUR et on remet le destinataire à `pending` (réutilise runCampaign,
   * pas de nouveau chemin d'envoi). Gardes : famille de codes variables, statut `failed`, appartenance tenant. 422 si la
   * variable est TOUJOURS manquante (on ne renvoie pas le même échec). Admin-only, tenant du JWT.
   */
  app.post('/campaigns/:campaignId/recipients/:recipientId/retry', guard, async (req, reply) => {
    if (forbidNonAdmin(req, reply)) return;
    const authTenant = req.auth?.tenantId ?? '';
    const { campaignId, recipientId } = req.params as { campaignId: string; recipientId: string };
    const r = await deps.resetRecipientForRetry(authTenant, campaignId, recipientId);
    if (r.result === 'not_found') return reply.code(404).send({ error: 'destinataire inconnu' });
    if (r.result === 'not_retryable') return reply.code(409).send({ error: 'destinataire non renvoyable (pas un échec de variable de template)' });
    if (r.result === 'missing_var') return reply.code(422).send({ error: 'variable de template toujours manquante', missing: r.missing });
    if (r.result === 'conflict') return reply.code(409).send({ error: 'destinataire déjà repris' });
    // queued : enfile un run (le destinataire redevenu pending est renvoyé par runCampaign avec les valeurs corrigées).
    const sizing = await deps.getRunSizing(campaignId);
    const expireInSeconds = sizing
      ? campaignJobExpireSeconds(sizing.pendingCount, resolveRatePerMinute(sizing.ratePerMinute, deps.defaultRatePerMinute ?? 0))
      : undefined;
    // Même groupe que partout ailleurs : un renvoi de destinataire ne doit pas échapper au plafond par espace.
    await deps.queue.enqueue('campaign-run', { campaignId }, { ...(expireInSeconds ? { expireInSeconds } : {}), groupId: authTenant });
    return reply.code(202).send({ enqueued: true, recipientId });
  });

  /**
   * SUSPEND une campagne en cours d'envoi. C'est le bouton d'arrêt d'urgence d'un mauvais ciblage : jusqu'ici
   * une campagne lancée partait jusqu'à son dernier destinataire, quoi qu'il arrive.
   *
   * Ce qui est déjà parti reste parti (rien ne rappelle un message WhatsApp livré). Le run en vol sort à sa
   * prochaine relecture de statut, quelques secondes plus tard, et les destinataires non traités restent
   * `pending` : « Reprendre » repart exactement là.
   *
   * 404 « inconnue » et 409 « n'envoie pas » sont DISTINCTS : contrôler l'appartenance d'abord est la seule
   * façon honnête de séparer « pas à toi » de « pas dans le bon état », comme pour l'archivage plus bas.
   */
  app.post('/tenants/:tenantId/campaigns/:campaignId/pause', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { campaignId } = req.params as { campaignId: string };
    if (!deps.pauseCampaign) return reply.code(404).send({ error: 'campagne non suspendable' });
    if (!(await deps.campaignBelongsTo(campaignId, tenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }
    const ok = await deps.pauseCampaign(campaignId, tenant);
    // 409 et pas 5xx : c'est un message destiné à l'opérateur, et Cloudflare remplace le corps de toute réponse
    // 5xx par sa propre page d'erreur (il ne verrait alors qu'un mur, jamais la raison).
    if (!ok) return reply.code(409).send({ error: "campagne non suspendable (elle n'est pas en cours d'envoi)" });
    return reply.code(200).send({ paused: true, campaignId });
  });

  // Annule une campagne programmée : elle repasse en brouillon (le job différé n'a jamais été enfilé, rien à tuer).
  app.post('/campaigns/:campaignId/cancel-schedule', guard, async (req, reply) => {
    if (forbidNonAdmin(req, reply)) return;
    const { campaignId } = req.params as { campaignId: string };
    const authTenant = req.auth?.tenantId ?? '';
    const ok = await deps.cancelSchedule(campaignId, authTenant);
    if (!ok) return reply.code(404).send({ error: 'campagne non programmée' });
    return reply.code(200).send({ cancelled: true, campaignId });
  });

  /**
   * ARRÊT d'une campagne au fil de l'eau. C'est son seul point final : elle n'en a aucun par elle-même, elle
   * prendrait les arrivants indéfiniment. Elle passe en `completed`, donc plus rien ne l'alimente (le feed ne
   * nourrit que les campagnes `running`), et son historique d'envoi reste intact.
   *
   * 404 sur une campagne ordinaire ou déjà arrêtée : le bouton ne s'affiche que là où il agit, et un appel
   * direct ne doit pas répondre « arrêté » sur une campagne qui ne l'était pas.
   */
  app.post('/tenants/:tenantId/campaigns/:campaignId/stop', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { campaignId } = req.params as { campaignId: string };
    if (!deps.stopWebhookCampaign) return reply.code(404).send({ error: 'campagne non arrêtable' });
    const ok = await deps.stopWebhookCampaign(campaignId, tenant);
    if (!ok) return reply.code(404).send({ error: 'campagne non arrêtable' });
    return reply.code(200).send({ stopped: true, campaignId });
  });

  // Archivage : masque la campagne de la liste sans rien effacer. Les trois routes ci-dessous contrôlent
  // l'appartenance AVANT d'agir, ce qui est la seule façon de distinguer honnêtement « pas à toi » (404) de
  // « pas dans le bon état » (200 idempotent pour l'archive, 409 pour la suppression).
  app.post('/tenants/:tenantId/campaigns/:campaignId/archive', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { campaignId } = req.params as { campaignId: string };
    if (!(await deps.campaignBelongsTo(campaignId, tenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }
    // Archiver une campagne déjà archivée n'est pas une erreur : l'état visé est atteint, on répond 200 sans
    // réécrire l'horodatage (la garde `archived_at is null` du store s'en charge).
    await deps.archiveCampaign(campaignId, tenant);
    return reply.code(200).send({ archived: true, campaignId });
  });

  app.post('/tenants/:tenantId/campaigns/:campaignId/unarchive', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { campaignId } = req.params as { campaignId: string };
    if (!(await deps.campaignBelongsTo(campaignId, tenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }
    await deps.unarchiveCampaign(campaignId, tenant);
    return reply.code(200).send({ archived: false, campaignId });
  });

  // Suppression DÉFINITIVE, réservée aux campagnes qui n'ont jamais rien envoyé. Une campagne partie porte
  // l'historique qui alimente les analytics : elle s'archive, elle ne s'efface pas. 409 (et non 404) quand la
  // garde refuse, pour que l'interface puisse proposer l'archivage à la place.
  app.delete('/tenants/:tenantId/campaigns/:campaignId', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { campaignId } = req.params as { campaignId: string };
    if (!(await deps.campaignBelongsTo(campaignId, tenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }
    const deleted = await deps.deleteDraftCampaign(campaignId, tenant);
    if (!deleted) {
      return reply.code(409).send({ error: 'campagne déjà lancée : elle ne peut être qu\'archivée' });
    }
    return reply.code(200).send({ deleted: true, campaignId });
  });
}
