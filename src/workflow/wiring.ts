import type { Pool } from 'pg';
import { config } from '../config';
import { PgWorkflowRunStore } from './run-store.pg';
import { PgWorkflowStore } from './store.pg';
import { PgTagStore } from '../crm/tag-store.pg';
import { PgTemplateHintStore } from '../crm/template-hints.pg';
import { PgContactStore } from '../crm/contact-store.pg';
import { PgInboxStore } from '../inbox/store.pg';
import { PgTenantSettingsStore } from '../settings/store.pg';
import { PgCampaignRepo } from '../campaign/store.pg';
import { countTemplateVariables } from '../crm/template';
import { logTemplateSent } from '../inbox/outbound-log';
import { MetaMediaClient } from '../meta/media';
import { MetaClientFactory } from '../meta/factory';
import { MetaCredentialsResolver } from '../meta/credentials';
import { TemplateMediaPreparer } from '../meta/template-media';
import { carouselSendBlocker, headerMediaSendBlocker } from '../meta/template-components';
import type { OutboundCarouselCard } from '../meta/template-components';
import { buildWorkflowTemplateComponents } from './template-send';
import { WorkflowExecutor } from './executor';
import { buildRcsStack } from '../rcs/factory';
import { AUTOMATION_EVENT_QUEUE, type AutomationEventJob } from '../automation/event-job';

/**
 * Câblage de l'exécuteur de scénarios : la vingtaine de dépendances IO qu'il réclame (contacts, tags, envois
 * Meta, caches de templates, visuels de carousel, publication d'événements d'automation).
 *
 * Pourquoi ce module existe : DEUX processus doivent exécuter un scénario. Le worker (réponse d'un contact,
 * campagne, réveil d'une attente) et l'API (un opérateur lance un scénario depuis l'Inbox et doit savoir TOUT
 * DE SUITE si c'est parti, sinon pourquoi). Un second câblage recopié serait le troisième doublon de cette
 * famille : le constructeur de composants Meta puis la préparation des visuels de carousel ont chacun causé
 * un bug de production le 2026-08-15, précisément parce qu'ils existaient en deux exemplaires.
 *
 * ⚠️ Les caches restent PAR PROCESS (templates, WABA, media ids, token) : chaque appelant a les siens. C'est
 * assumé, borné par des TTL courts, et Meta reste la source de vérité. Ce module ne prétend pas les partager.
 */
export interface WorkflowRuntimeDeps {
  pool: Pool;
  /** File pg-boss : sert UNIQUEMENT à publier « tag ajouté » pour les automations. Aucun `work` ici. */
  queue: { enqueue(name: string, data: unknown): Promise<void> };
  /** DRY_RUN : aucun appel Meta. ⚠️ À passer explicitement : l'oublier ferait envoyer pour de vrai. */
  dryRun: boolean;
  repo: PgCampaignRepo;
  contactStore: PgContactStore;
  inboxStore: PgInboxStore;
  settingsStore: PgTenantSettingsStore;
  workflowStore: PgWorkflowStore;
  /** Résolveur de token PAR TENANT. On le REÇOIT (au lieu de le reconstruire) pour ne pas dupliquer son cache. */
  metaCredentials: MetaCredentialsResolver;
  metaFactory: MetaClientFactory;
  /** Provider du canal RCS (`config.RCS_PROVIDER`). Passé explicitement, comme `dryRun` : ce module ne lit pas
   *  la config, ses appelants la lui donnent. */
  rcsProvider: 'fake' | 'google';
}

/** Construit l'exécuteur et ce qui l'accompagne. Une seule fois par process (les caches vivent dedans). */
export function buildWorkflowRuntime(deps: WorkflowRuntimeDeps) {
  const { pool, queue, dryRun, repo, contactStore, inboxStore, settingsStore, workflowStore, metaCredentials, metaFactory, rcsProvider } = deps;
  const runStore = new PgWorkflowRunStore(pool);
  // Pile RCS montée ICI, et une seule fois : l'exécuteur (bloc de scénario) et le worker (campagnes) doivent
  // partager le MÊME sender, donc le même cache de joignabilité et le même provider.
  const rcsStack = buildRcsStack(pool, rcsProvider, dryRun);
  const tagStore = new PgTagStore(pool);
  const hintStore = new PgTemplateHintStore(pool);

  // Cache court du corps live d'un template (nb de variables N + exemples) par WABA|nom|langue : évite un appel
  // Meta list() par destinataire d'une campagne workflow. TTL court -> tolère un template édité en cours de route.
  // Porte AUSSI les cartes du carousel : Meta exige l'image de chaque carte À CHAQUE ENVOI (elle n'est pas dans
  // le template), et les URL renvoyées portent une expiration -> TTL court, relues régulièrement, jamais figées.
  // Porte AUSSI l'en-tête média, pour la même raison que les cartes : Meta l'exige à chaque envoi et l'URL expire.
  type TplInfo = {
    count: number;
    carousel?: { cards: OutboundCarouselCard[] };
    headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
    headerMediaUrl?: string;
  };
  const tplVarCache = new Map<string, { at: number } & TplInfo>();
  const TPL_CACHE_MS = 5 * 60_000;
  // `count` = MAX des positions {{n}} (cf. countTemplateVariables) : « {{1}} ... {{3}} » attend 3 params pour Meta,
  // pas 2. null = indéterminable (WABA absent / template introuvable / réseau) -> l'appelant NE PAS envoyer.
  // WABA du tenant, mémoïsé au même TTL : `templateVarInfo` est appelé PAR DESTINATAIRE sur une campagne
  // scénario, et sans ça chaque envoi payait un SELECT avant même de regarder le cache de templates.
  const wabaCache = new Map<string, { at: number; waba: string | null }>();
  const tenantWabaId = async (tenant: string): Promise<string | null> => {
    const hit = wabaCache.get(tenant);
    if (hit && Date.now() - hit.at < TPL_CACHE_MS) return hit.waba;
    const waba = await repo.getTenantWabaId(tenant);
    wabaCache.set(tenant, { at: Date.now(), waba });
    return waba;
  };
  /**
   * Préparation des visuels d'un template (re-téléversement -> `media id`), pour les cartes d'un carousel comme
   * pour l'en-tête média. UNE seule implémentation dans le projet (`meta/template-media.ts`), partagée avec
   * l'API qui en a besoin pour l'envoi depuis l'inbox. L'instance porte son cache : créée UNE fois, et un même
   * visuel servant aux deux usages ne se téléverse qu'une fois.
   */
  const templateMedia = new TemplateMediaPreparer({
    getPhoneNumberId: (tenant) => repo.getTenantPhoneNumberId(tenant),
    mediaClientFor: async (tenant) => {
      const { token } = await metaCredentials.resolveForTenant(tenant);
      return new MetaMediaClient(token, config.META_APP_ID, config.META_GRAPH_VERSION);
    },
  });
  const prepareCarouselMedia = (tenant: string, cards: OutboundCarouselCard[]): Promise<OutboundCarouselCard[]> =>
    templateMedia.prepare(tenant, cards);
  const prepareHeaderMedia = (tenant: string, mediaUrl: string): Promise<string | null> =>
    templateMedia.prepareOne(tenant, mediaUrl);

  /**
   * Visuels d'un template PRÊTS pour l'envoi (cartes de carousel ET en-tête média), ou la RAISON du refus.
   *
   * Factorisé, et ça n'est pas cosmétique : les deux branches de `sendTemplate` (variables déjà résolues d'une
   * campagne, ou résolution par hints après une réponse) doivent se comporter à l'identique. C'est leur
   * divergence qui a laissé le carousel non branché côté campagne (2026-08-15), puis l'en-tête média non
   * branché côté campagne scénario (relevé en revue le 2026-08-17). Une seule source, plus d'écart possible.
   *
   * `info` null (lecture du template en échec) -> aucun visuel et aucun refus : on part comme avant, un
   * template sans visuel n'est jamais bloqué par une panne de lecture.
   */
  type VisuelsEnvoi = { carousel?: { cards: OutboundCarouselCard[] }; headerMediaId?: string; headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT' };
  const visuelsPourEnvoi = async (tenant: string, info: TplInfo | null): Promise<{ refus: string } | VisuelsEnvoi> => {
    const carousel = info?.carousel ? { cards: await prepareCarouselMedia(tenant, info.carousel.cards) } : undefined;
    const refusCarousel = carousel ? carouselSendBlocker(carousel.cards) : null;
    if (refusCarousel !== null) return { refus: refusCarousel };
    // Un carousel porte ses visuels PAR CARTE : pas d'en-tête top-level à préparer ni à exiger.
    if (carousel) return { carousel };
    const headerMediaId = info?.headerMediaUrl ? await prepareHeaderMedia(tenant, info.headerMediaUrl) : null;
    const refusHeader = headerMediaSendBlocker(info?.headerFormat, headerMediaId ?? undefined);
    if (refusHeader !== null) return { refus: refusHeader };
    return headerMediaId ? { headerMediaId, ...(info?.headerFormat ? { headerFormat: info.headerFormat } : {}) } : {};
  };

  const templateVarInfo = async (tenant: string, name: string, language: string): Promise<TplInfo | null> => {
    const waba = await tenantWabaId(tenant);
    if (!waba) return null;
    const key = `${waba}|${name}|${language}`;
    const cached = tplVarCache.get(key);
    if (cached && Date.now() - cached.at < TPL_CACHE_MS) {
      const { at: _at, ...info } = cached;
      return info;
    }
    const tplClient = await metaFactory.templateClientForTenant(tenant); // token PAR TENANT (B1), repli global en sommeil
    const list = await tplClient.list(waba);
    // Exact (nom + langue), sinon repli sur le nom seul (langue par défaut d'un template mono-langue).
    const tpl = list.find((t) => t.name === name && t.language === language) ?? list.find((t) => t.name === name);
    if (!tpl) return null;
    const media = tpl.headerFormat === 'IMAGE' || tpl.headerFormat === 'VIDEO' || tpl.headerFormat === 'DOCUMENT'
      ? tpl.headerFormat
      : undefined;
    const info: TplInfo = {
      count: countTemplateVariables(tpl.body),
      ...(tpl.carousel ? { carousel: tpl.carousel } : {}),
      ...(media ? { headerFormat: media } : {}),
      ...(tpl.headerMediaUrl ? { headerMediaUrl: tpl.headerMediaUrl } : {}),
    };
    tplVarCache.set(key, { at: Date.now(), ...info });
    return info;
  };

  // Contexte d'évaluation du contact (état CRM + fuseau/horaires du tenant). Partagé par les blocs `condition`
  // d'un scénario ET par le filtre `conditionGroup` d'une automation : une seule définition, même sémantique.
  const buildEvalContext = async (tenant: string, waId: string) => {
    const state = await contactStore.getContactStateByWaId(tenant, waId);
    if (!state) return null;
    const settings = await settingsStore.get(tenant);
    return { ...state, now: new Date(), timeZone: settings.timezone, businessHours: settings.businessHours };
  };

  /**
   * L'APPEL META, sans la bascule locale.
   *
   * ⚠️ Les deux sont séparés délibérément : chaque appelant connaît l'état qu'il attendait avant de basculer
   * (`only: ['app_workflow']` pour le scénario, `only: ['app_human']` pour le balayage de reprise). Une fonction
   * qui ferait les deux avec un `only` figé échouerait EN SILENCE chez le second appelant, qui a déjà basculé.
   */
  const releaseThreadChezMeta = async (tenant: string, waId: string): Promise<void> => {
    const pn = await repo.getTenantPhoneNumberId(tenant);
    if (!pn) return;
    const client = await metaFactory.mbaClientForTenant(tenant);
    await client.releaseThread(pn, waId);
  };

  const workflowExecutor = new WorkflowExecutor({
    runs: runStore,
    // Canal RCS du bloc `rcs_message`. `agentIdFor` est scopé tenant : c'est lui qui empêche un scénario
    // d'envoyer sous la marque d'un autre client. Aucun agent -> le bloc part sur sa sortie « non joignable ».
    rcs: { sender: rcsStack.sender, agentIdFor: (tenant) => rcsStack.agents.agentIdForTenant(tenant) },
    // Un scénario n'écrit jamais dans un fil détenu par un opérateur ou par MBA. Vaut pour l'avance
    // (réponse du contact) comme pour le démarrage (campagne workflow, cible node).
    mayAct: async (tenant, waId) => (await inboxStore.getControlOwner(tenant, waId)) === 'app_workflow',
    // Un run qui atteint un bloc `inbox` remonte la conversation à un humain : on pose control_owner=app_human,
    // mais SEULEMENT si le fil était encore à nous (`only: ['app_workflow']`) pour ne pas écraser une prise de
    // main concurrente. Rend le badge honnête (fin du trou où le scénario semblait « répondre » sans plus avancer).
    escalateToHuman: async (tenant, waId) => { await inboxStore.setControlOwner(tenant, waId, 'app_human', { only: ['app_workflow'] }); },
    // Reprise de main par l'app au lancement d'une CAMPAGNE (sans `only` : on reprend même un fil tenu par un
    // humain ou par MBA, puisque c'est l'opérateur lui-même qui déclenche l'envoi).
    reclaimControl: async (tenant, waId) => { await inboxStore.setControlOwner(tenant, waId, 'app_workflow'); },
    // L'agent de Meta est-il allumé chez ce client ? Décide de deux choses : qu'une étape sans choix cesse de
    // bloquer le parcours, et qu'on rende le fil à Meta en fin de chaîne. Faux partout aujourd'hui, donc rien
    // ne change tant qu'aucun client n'a MBA.
    mbaActifPour: async (tenant) => (await settingsStore.get(tenant)).mbaEnabled,
    // Rend le fil à l'agent de Meta. La bascule LOCALE d'abord, et seulement si le fil était encore au
    // scénario : Meta exige de détenir le fil pour le relâcher, et cette condition le prouve.
    releaseToMba: async (tenant, waId) => {
      if (!(await inboxStore.setControlOwner(tenant, waId, 'mba', { only: ['app_workflow'] }))) return;
      await releaseThreadChezMeta(tenant, waId);
    },
    // Contexte d'évaluation des blocs `condition` (et du bloc `field` en mode NOW) : état du contact + fuseau et
    // horaires d'ouverture du tenant + `now`. Contact introuvable -> null -> le moteur prend la branche 'false'.
    evalContext: buildEvalContext,
    // Fenêtre de service 24 h, relue à la REPRISE d'un parcours endormi (bloc Attente). Elle court depuis le
    // dernier message DU CONTACT : même une attente courte peut la voir se fermer, donc on la LIT, on ne la
    // déduit pas de la durée d'attente. Même calcul que l'inbox (source unique).
    isWindowOpen: async (tenant, waId) => (await inboxStore.getWindowOpenByWaIds(tenant, [waId])).get(waId) === true,
    getGraph: async (id, tenant) => (await workflowStore.getById(id, tenant))?.graph ?? null,
    // Applique le tag au contact ET le déclare dans le référentiel (défense : un tag posé au runtime, y compris par
    // un ancien workflow non re-sauvegardé, atterrit dans Contenus > Tags). Best-effort, n'échoue jamais l'action.
    applyTag: async (tenant, waId, tag) => {
      // Même valeur normalisée (trim + slice 64) posée SUR le contact ET déclarée dans le référentiel -> pas de
      // doublon 'vip ' vs 'vip' ni tag>64 tronqué d'un côté seulement (Contenus > Tags = union des deux sources).
      const clean = tag.trim().slice(0, 64);
      if (clean === '') return false;
      const { added } = await contactStore.addTagsByPhoneReturningNew(tenant, waId, [clean]);
      try { await tagStore.create(tenant, clean); } catch { /* déclaration best-effort */ }
      // Dit à l'exécuteur si le tag était RÉELLEMENT nouveau : sinon un scénario qui repasse sur le même bloc
      // annoncerait « tag ajouté » à chaque passage, et relancerait une automation pour un non-événement.
      return added.length > 0;
    },
    // Publication « tag ajouté » pour les automations. Portée par une dep SÉPARÉE de `applyTag`, et appelée
    // par l'exécuteur uniquement sur un démarrage UNITAIRE : le même exécuteur sert les campagnes, où poser un
    // tag sur 5 000 destinataires enfilerait 5 000 événements. Passe par la file (et non un appel direct) pour
    // qu'un scénario qui pose son propre tag déclencheur ne s'enchaîne pas en récursion synchrone.
    emitTagAdded: async (tenant, waId, tag) => {
      const clean = tag.trim().slice(0, 64);
      if (clean === '') return;
      await queue.enqueue(AUTOMATION_EVENT_QUEUE, { tenantId: tenant, event: { kind: 'tag_added', waId, tag: clean } } satisfies AutomationEventJob);
    },
    setField: async (tenant, waId, key, value) => { await contactStore.mergeFieldsByPhone(tenant, waId, { [key]: value }); },
    // Retrait : même normalisation (trim + slice 64) que l'ajout, pour matcher le tag stocké. Le référentiel Tags
    // n'est PAS touché (retirer un tag d'un contact ne « dé-déclare » pas le tag du référentiel du tenant).
    removeTag: async (tenant, waId, tag) => {
      const clean = tag.trim().slice(0, 64);
      if (clean === '') return;
      await contactStore.removeTagsByPhone(tenant, waId, [clean]);
    },
    clearField: async (tenant, waId, key) => { await contactStore.clearFieldsByPhone(tenant, waId, [key]); },
    sendTemplate: async (tenant, waId, name, language, buttons, explicitParams) => {
      if (dryRun) return; // DRY_RUN : aucun appel Meta
      const pn = await repo.getTenantPhoneNumberId(tenant);
      if (!pn) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: aucun numéro pour le tenant ${tenant}, template « ${name} » non envoyé`);
        return 'aucun numéro WhatsApp rattaché à ce workspace';
      }
      const client = await metaFactory.clientForTenant(tenant, pn); // token PAR TENANT (B1), repli global en sommeil

      // Campagne workflow : les variables du 1er template sont DÉJÀ résolues par contact (paramMapping de la campagne,
      // via buildRecipients). On les utilise directement, sans relire le corps live du template ni les hints (chemin
      // identique aux campagnes template DIRECTES). `explicitParams` DÉFINI (même `[]` = template sans variable) ->
      // ce chemin ; `undefined` = envoi via `advance` (réponse webhook) -> chemin hints stockés ci-dessous.
      // Garde-fou : une valeur vide fait sauter l'envoi (jamais `text:''`).
      if (explicitParams !== undefined) {
        // Visuels (cartes de carousel ET en-tête média) : Meta les exige à CHAQUE envoi. Lecture best-effort
        // (ce chemin n'appelait pas Meta jusqu'ici) : illisible -> on part comme avant, un template SANS visuel
        // n'est pas affecté. MÊME traitement que la branche hints ci-dessous, par construction.
        let luCampagne: TplInfo | null = null;
        try {
          luCampagne = await templateVarInfo(tenant, name, language);
        } catch { /* best-effort */ }
        const visuels = await visuelsPourEnvoi(tenant, luCampagne);
        if ('refus' in visuels) {
          // eslint-disable-next-line no-console
          console.error(`workflow sendTemplate: « ${name} » non envoyé à ${waId} : ${visuels.refus}`);
          return `template « ${name} » : ${visuels.refus}`;
        }
        const { components, missing } = buildWorkflowTemplateComponents({ hints: [], varCount: explicitParams.length, contact: {}, buttons, explicitParams, flowToken: `${waId}-${Date.now()}`, ...visuels });
        if (missing.length > 0) {
          // eslint-disable-next-line no-console
          console.error(`workflow sendTemplate: « ${name} » non envoyé à ${waId} : variable(s) manquante(s) position(s) ${missing.join(',')}`);
          return `template « ${name} » : valeur manquante pour la ou les variables ${missing.map((p) => `{{${p}}}`).join(', ')}`;
        }
        const res = await client.sendTemplate(waId, { name, language, ...(components.length > 0 ? { components } : {}) });
        await logTemplateSent(inboxStore, tenant, waId, name, res.messageId);
        return;
      }

      // Variables du corps : on résout les {{n}} avec les attributs du contact (indices template_param_hints ->
      // champ, ex. {{1}}=prenom). On NE devine PAS : si les variables sont indéterminables (info null) ou si une
      // valeur manque, on NE PAS envoyer (évite 132000 « nb de variables » et 132012 « text:'' »).
      let info: TplInfo | null = null;
      try {
        info = await templateVarInfo(tenant, name, language);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: variables de « ${name} » indéterminables:`, err instanceof Error ? err.message : err);
      }
      if (info === null) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: variables de « ${name} » indéterminables (WABA/template/réseau) -> non envoyé à ${waId}`);
        return `template « ${name} » introuvable chez Meta (nom, langue, ou WhatsApp momentanément injoignable)`;
      }
      let hints: Awaited<ReturnType<typeof hintStore.get>> = [];
      let contact = null as Awaited<ReturnType<typeof contactStore.getResolvableByPhone>>;
      if (info.count > 0) {
        [hints, contact] = await Promise.all([
          hintStore.get(tenant, name, language),
          contactStore.getResolvableByPhone(tenant, waId),
        ]);
      }
      // Payload CONTRÔLÉ sur chaque bouton quick-reply -> au tap, le webhook renvoie `btn:<index>`, qui sélectionne
      // la branche (sourceHandle) de façon déterministe. Body avant boutons (ordre attendu par l'API Cloud).
      // Carousel non envoyable (carte sans image récupérable, variable de carte) : on NE devine PAS, on ne
      // laisse pas non plus partir un payload que Meta rejettera. Même doctrine que `missing`.
      const visuels = await visuelsPourEnvoi(tenant, info);
      if ('refus' in visuels) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: « ${name} » non envoyé à ${waId} : ${visuels.refus}`);
        return `template « ${name} » : ${visuels.refus}`;
      }
      const { components, missing } = buildWorkflowTemplateComponents({
        hints, varCount: info.count, contact: contact ?? {}, buttons, flowToken: `${waId}-${Date.now()}`, now: new Date(),
        ...visuels,
      });
      if (missing.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: « ${name} » non envoyé à ${waId} : variable(s) manquante(s) position(s) ${missing.join(',')}`);
        return `template « ${name} » : ce contact n'a pas de valeur pour la ou les variables ${missing.map((p) => `{{${p}}}`).join(', ')}`;
      }
      const res = await client.sendTemplate(waId, { name, language, ...(components.length > 0 ? { components } : {}) });
      // Journalise le template dans le fil de conversation (fil d'inbox complet + transcript d'analyse). Best-effort.
      await logTemplateSent(inboxStore, tenant, waId, name, res.messageId);
    },
    // Message rapide (node quick_message) : texte + 2-3 réponses rapides, hors template. Deux chemins d'accès,
    // tous deux EN fenêtre 24 h : `advance` (le contact vient de répondre) et `startFromNode` (cible node de
    // /v1/sends, qui a écarté les hors-fenêtre en amont). Texte littéral en V1 (pas de variables).
    sendQuickMessage: async (tenant, waId, body, buttons) => {
      if (dryRun) return; // DRY_RUN : aucun appel Meta
      if (body.trim() === '') return 'le bloc « message rapide » n\'a pas de texte';
      const pn = await repo.getTenantPhoneNumberId(tenant);
      if (!pn) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendQuickMessage: aucun numéro pour le tenant ${tenant}, message rapide non envoyé à ${waId}`);
        return 'aucun numéro WhatsApp rattaché à ce workspace';
      }
      const client = await metaFactory.clientForTenant(tenant, pn); // token PAR TENANT (B1), repli global en sommeil
      // Aucune réponse rapide utilisable -> message TEXTE simple. Meta refuse un interactif sans bouton, et
      // c'est ce que l'opérateur attend quand il n'a rempli que le texte.
      //
      // ⚠️ On passe `buttons` ENTIER à l'envoi, jamais la liste filtrée : c'est `sendInteractive` qui écarte
      // les titres vides EN PRÉSERVANT l'index d'origine dans `btn:<i>`. Filtrer ici renumérotait les boutons
      // restants à partir de 0, donc une réponse rapide placée après une case vide renvoyait un payload qui
      // ne correspondait à aucune branche du scénario, et le contact partait sur la sortie par défaut.
      const utilisables = buttons.some((b) => b.text.trim() !== '');
      const res = utilisables ? await client.sendInteractive(waId, body, buttons) : await client.sendText(waId, body);
      // Journalise le message rapide dans le fil de conversation (best-effort, ne casse jamais l'envoi Meta réussi).
      try { await inboxStore.recordOutboundByWaId(tenant, waId, { body, messageId: res.messageId, type: 'text' }); } catch { /* best-effort */ }
    },
    // Formulaire (node flow) : message interactif type flow, hors template. Atteint via `advance` (le save du
    // graphe + la garde de `start` refusent un flow en OUVERTURE) ou via `startFromNode` (cible node, fenêtre
    // déjà vérifiée) -> fenêtre 24 h ouverte dans les deux cas. La complétion revient en nfm_reply : mapping
    // des champs par _ref, indépendant du canal d'envoi.
    sendFlow: async (tenant, waId, flowId, body, cta) => {
      if (dryRun) return; // DRY_RUN : aucun appel Meta
      if (flowId.trim() === '') return 'le bloc « formulaire » ne désigne aucun formulaire'; // défense, actionOf filtre déjà
      const pn = await repo.getTenantPhoneNumberId(tenant);
      if (!pn) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendFlow: aucun numéro pour le tenant ${tenant}, formulaire non envoyé à ${waId}`);
        return 'aucun numéro WhatsApp rattaché à ce workspace';
      }
      const client = await metaFactory.clientForTenant(tenant, pn); // token PAR TENANT (B1), repli global en sommeil
      // flow_token jamais vide (exigence Meta #131009) mais jetable : la corrélation passe par le _ref du flow_json.
      const res = await client.sendFlowMessage(waId, { body, flowId, cta, flowToken: `${waId}-${Date.now()}` });
      // Journalise l'envoi dans le fil (best-effort). Le corps = l'accroche visible par le contact.
      try { await inboxStore.recordOutboundByWaId(tenant, waId, { body, messageId: res.messageId, type: 'text' }); } catch { /* best-effort */ }
    },
  });

  return { executor: workflowExecutor, runStore, templateVarInfo, prepareCarouselMedia, prepareHeaderMedia, buildEvalContext, rcsStack, releaseThreadChezMeta };
}
