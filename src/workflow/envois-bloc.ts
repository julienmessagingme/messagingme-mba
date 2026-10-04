import type { WorkflowExecutorDeps } from './executor';
import { problemeLienBouton } from './engine';
import { buildWorkflowTemplateComponents } from './template-send';
import type { MetaClient } from '../meta/client';
import { carouselSendBlocker, headerMediaSendBlocker } from '../meta/template-components';
import type { OutboundCarouselCard } from '../meta/template-components';
import type { PgTrackedLinkStore } from '../links/tracked-links.pg';
import { fabriquerJeton } from '../links/jeton-contact';
import type { PgTemplateHintStore } from '../crm/template-hints.pg';
import type { PgContactStore } from '../crm/contact-store.pg';
import { renderText } from '../crm/render';
import { logTemplateSent, type OutboundLogger } from '../inbox/outbound-log';
// La même décision que sur le chemin des campagnes : un template tracé exige ses composants de bouton, quel
// que soit le chemin d'envoi. On importe la règle plutôt que d'en écrire une seconde.
import { suffixesPourDestinataire } from '../campaign/engine';
import { messageDe } from '../lib/erreur';

/**
 * Les quatre envois WhatsApp d'un bloc de scénario : modèle (`sendTemplate`), message rapide
 * (`sendQuickMessage`), question (`sendQuestion`) et formulaire (`sendFlow`). Ce sont les dépendances que
 * `WorkflowExecutor.apply` appelle, après sa garde d'opt-out, pour faire partir un message.
 *
 * Construit une fois par processus par le câblage (`src/workflow/wiring.ts`), qui lui passe ce qu'il partage
 * avec d'autres chemins : le client Meta de l'espace (la réponse d'un agent IA l'emprunte aussi) et la lecture
 * des templates en cache (les campagnes et l'API publique la lisent aussi). Exécuté contre un faux client Meta
 * par `tests/workflow-envois-bloc.test.ts`.
 *
 * Chaque envoi ne rend rien en DRY_RUN, une chaîne portant la raison quand rien n'est parti (`SendRefusal`), et
 * l'identifiant du message sinon. Le journal dans le fil est best-effort : il ne fait jamais échouer un envoi
 * que Meta a accepté.
 */
export type EnvoisDeBloc = Pick<WorkflowExecutorDeps, 'sendTemplate' | 'sendQuickMessage' | 'sendQuestion' | 'sendFlow'>;

/**
 * Ce que la lecture d'un template chez Meta rend (`templateVarInfo`, mise en cache dans le câblage et partagée
 * avec les campagnes et l'API publique).
 */
export type TplInfo = {
  count: number;
  /**
   * Statut Meta et langue du template trouvé. L'API publique refuse un template non approuvé, et la langue
   * dit si la lecture est retombée sur le nom seul (`verdictModele`). Seule l'API publique les lit.
   */
  statut: string;
  langue: string;
  carousel?: { cards: OutboundCarouselCard[] };
  headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  headerMediaUrl?: string;
  /**
   * La catégorie Meta, en minuscules (Meta rend 'MARKETING'/'UTILITY', la base stocke en minuscules : on
   * aligne ici plutôt que dans chaque lecteur). Sans elle, un template envoyé par un scénario n'aurait pas de
   * coût calculable. `tplClient.list` la demande déjà dans ses `fields`.
   */
  category?: string;
  /**
   * Pourquoi aucun envoi de ce template ne peut partir (`raisonNonEnvoyable`), `null` s'il le peut. Seule
   * l'API publique le lit (`verdictModele`) : le worker juge ses propres visuels à l'envoi.
   */
  nonEnvoyable: string | null;
};

/** Les méthodes du client Meta que ces envois appellent, et elles seules. */
export type ClientDesEnvois = Pick<MetaClient, 'sendTemplate' | 'sendCtaUrl' | 'sendInteractive' | 'sendImage' | 'sendText' | 'sendList' | 'sendFlowMessage'>;

/** Ce dont les envois ont besoin, tout requis : un oubli ne compile pas. */
export interface DepsEnvoisDeBloc {
  /** DRY_RUN : aucun appel Meta. À passer explicitement : l'oublier ferait envoyer pour de vrai. */
  dryRun: boolean;
  /**
   * Le client Meta de l'espace pour un envoi WhatsApp, ou le refus (une chaîne, comme tout `SendRefusal`)
   * quand aucun numéro n'est rattaché. `dryRun` reste chez l'appelant : certains envois refusent un bloc vide
   * avant de chercher le numéro.
   */
  clientWhatsApp(tenant: string, qui: string, quoiNonEnvoye: string): Promise<ClientDesEnvois | string>;
  /** La lecture du template chez Meta (`null` = introuvable ou espace sans WABA), en cache court. */
  templateVarInfo(tenant: string, name: string, language: string): Promise<TplInfo | null>;
  /** Les visuels d'un template re-téléversés sur le numéro d'envoi (`meta/template-media.ts`). */
  prepareCarouselMedia(tenant: string, cards: OutboundCarouselCard[]): Promise<OutboundCarouselCard[]>;
  prepareHeaderMedia(tenant: string, mediaUrl: string): Promise<string | null>;
  /** Les liens tracés d'un template, et le jeton public du contact écrit dans leur suffixe. */
  trackedLinks: Pick<PgTrackedLinkStore, 'listByTemplates' | 'jetonPourE164'>;
  /** Les indications « variable {{n}} -> champ » d'un template. */
  hintStore: Pick<PgTemplateHintStore, 'get'>;
  /** La fiche du contact, pour résoudre les variables d'un template par ses indications. */
  contactStore: Pick<PgContactStore, 'getResolvableByPhone'>;
  /** Les variables `{{champ}}` d'un contact désigné par son wa_id (`contactVars`). */
  varsDuContact(tenant: string, waId: string): Promise<Record<string, string | null>>;
  /** Le fil de conversation, où chaque envoi parti est journalisé avec l'origine `scenario`. */
  inboxStore: OutboundLogger;
}

export function creerEnvoisDeBloc(deps: DepsEnvoisDeBloc): EnvoisDeBloc {
  const { dryRun, clientWhatsApp, templateVarInfo, prepareCarouselMedia, prepareHeaderMedia, trackedLinks, hintStore, contactStore, varsDuContact, inboxStore } = deps;

  /**
   * Visuels d'un template prêts pour l'envoi (cartes de carousel et en-tête média), ou la raison du refus.
   * Les deux branches de `sendTemplate` (variables déjà résolues, ou résolution par hints) passent par ici
   * pour se comporter à l'identique. `info` null (lecture en échec) -> ni visuel ni refus : un template sans
   * visuel n'est jamais bloqué par une panne de lecture.
   */
  type VisuelsEnvoi = { carousel?: { cards: OutboundCarouselCard[] }; headerMediaId?: string; headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT' };
  const visuelsPourEnvoi = async (tenant: string, info: TplInfo | null): Promise<{ refus: string } | VisuelsEnvoi> => {
    const carousel = info?.carousel ? { cards: await prepareCarouselMedia(tenant, info.carousel.cards) } : undefined;
    const refusCarousel = carousel ? carouselSendBlocker(carousel.cards) : null;
    if (refusCarousel !== null) return { refus: refusCarousel };
    // Un carousel porte ses visuels par carte : pas d'en-tête top-level à préparer ni à exiger.
    if (carousel) return { carousel };
    const headerMediaId = info?.headerMediaUrl ? await prepareHeaderMedia(tenant, info.headerMediaUrl) : null;
    const refusHeader = headerMediaSendBlocker(info?.headerFormat, headerMediaId ?? undefined);
    if (refusHeader !== null) return { refus: refusHeader };
    return headerMediaId ? { headerMediaId, ...(info?.headerFormat ? { headerFormat: info.headerFormat } : {}) } : {};
  };

  return {
    sendTemplate: async (tenant, waId, name, language, buttons, explicitParams) => {
      if (dryRun) return; // DRY_RUN : aucun appel Meta
      const client = await clientWhatsApp(tenant, 'workflow sendTemplate', `template « ${name} » non envoyé`);
      if (typeof client === 'string') return client;

      /**
       * Attribution des clics. Un scénario envoie les mêmes templates qu'une campagne directe : un bouton soumis
       * à Meta sous la forme `/r/<code>/{{1}}` exige ce `{{1}}` à chaque envoi, sinon Meta refuse tout le
       * message en 131008.
       */
      const suffixes = await (async (): Promise<{ suffixesBoutons?: Record<number, string> }> => {
        try {
          const liens = await trackedLinks.listByTemplates(tenant, [name]);
          const boutons = liens.filter((l) => l.avecJeton && l.cardIndex === null).map((l) => l.buttonIndex);
          if (boutons.length === 0) return {};
          const jeton = await trackedLinks.jetonPourE164(tenant, waId, fabriquerJeton).catch(() => null);
          return suffixesPourDestinataire(boutons, jeton ?? undefined);
        } catch (err) {
          // Illisible : on ne sait pas si ce template porte des variables de bouton. On part sans, et on le dit,
          // sinon un 131008 resterait inexpliqué.
          // eslint-disable-next-line no-console
          console.error(`workflow sendTemplate: liens tracés de « ${name} » illisibles:`, messageDe(err));
          return {};
        }
      })();

      // Campagne workflow : les variables du 1er template sont déjà résolues par contact (paramMapping, via
      // buildRecipients), utilisées sans relire le corps live ni les hints. `explicitParams` défini (même `[]`)
      // -> ce chemin ; `undefined` = envoi via `advance` -> hints stockés ci-dessous. Une valeur vide fait sauter
      // l'envoi (jamais `text:''`).
      if (explicitParams !== undefined) {
        // Visuels (cartes de carousel et en-tête média) : Meta les exige à chaque envoi. Lecture best-effort :
        // illisible -> on part sans, un template sans visuel n'est pas affecté. Même traitement que la branche hints.
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
        const { components, missing } = buildWorkflowTemplateComponents({ hints: [], varCount: explicitParams.length, contact: {}, buttons, explicitParams, flowToken: `${waId}-${Date.now()}`, ...visuels, ...suffixes });
        if (missing.length > 0) {
          // eslint-disable-next-line no-console
          console.error(`workflow sendTemplate: « ${name} » non envoyé à ${waId} : variable(s) manquante(s) position(s) ${missing.join(',')}`);
          return `template « ${name} » : valeur manquante pour la ou les variables ${missing.map((p) => `{{${p}}}`).join(', ')}`;
        }
        const res = await client.sendTemplate(waId, { name, language, ...(components.length > 0 ? { components } : {}) });
        // 🔴 La catégorie vient de `luCampagne`, la lecture de cette branche : les deux branches doivent journaliser
        // la même chose. `luCampagne` null -> pas de catégorie, jamais une catégorie inventée, qui se facturerait au
        // mauvais tarif.
        await logTemplateSent(inboxStore, tenant, waId, name, res.messageId, { templateCategory: luCampagne?.category ?? null });
        // Remonté pour la mesure par bloc : c'est cet identifiant qui permettra à un accusé de lecture de
        // retrouver le bloc qui a envoyé ce message.
        return { messageId: res.messageId };
      }

      // Variables du corps résolues avec les attributs du contact (template_param_hints -> champ, ex.
      // {{1}}=prenom). On ne devine pas : variables indéterminables ou valeur manquante -> pas d'envoi (évite
      // 132000 et 132012).
      let info: TplInfo | null = null;
      try {
        info = await templateVarInfo(tenant, name, language);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: variables de « ${name} » indéterminables:`, messageDe(err));
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
      // Payload contrôlé sur chaque bouton quick-reply (`btn:<index>`) : au tap, il sélectionne la branche.
      // Carousel non envoyable (carte sans image, variable de carte) : on ne laisse pas partir un payload que Meta
      // rejettera.
      const visuels = await visuelsPourEnvoi(tenant, info);
      if ('refus' in visuels) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: « ${name} » non envoyé à ${waId} : ${visuels.refus}`);
        return `template « ${name} » : ${visuels.refus}`;
      }
      const { components, missing } = buildWorkflowTemplateComponents({
        hints, varCount: info.count, contact: contact ?? {}, buttons, flowToken: `${waId}-${Date.now()}`, now: new Date(),
        ...visuels,
        ...suffixes,
      });
      if (missing.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: « ${name} » non envoyé à ${waId} : variable(s) manquante(s) position(s) ${missing.join(',')}`);
        return `template « ${name} » : ce contact n'a pas de valeur pour la ou les variables ${missing.map((p) => `{{${p}}}`).join(', ')}`;
      }
      const res = await client.sendTemplate(waId, { name, language, ...(components.length > 0 ? { components } : {}) });
      // Journalise le template dans le fil (best-effort), avec sa catégorie lue dans `info` : sans elle, l'envoi
      // compterait en volume mais pas dans le coût.
      await logTemplateSent(inboxStore, tenant, waId, name, res.messageId, { templateCategory: info.category ?? null });
      return { messageId: res.messageId };
    },
    // Message rapide (node quick_message), hors template, toujours en fenêtre 24 h : `advance` (le contact
    // vient de répondre) ou un démarrage dont la garde de fenêtre est levée (`fenetreLevee`, `workflow/lancements.ts`).
    sendQuickMessage: async (tenant, waId, body, buttons, mediaUrl, lien) => {
      if (dryRun) return; // DRY_RUN : aucun appel Meta
      if (body.trim() === '') return 'le bloc « message rapide » n\'a pas de texte';
      // Bouton de lien incomplet -> refus, jamais un message nu alors que le client a coché la case. La règle
      // vit dans le moteur (`problemeLienBouton`), et l'écran la répète à la saisie.
      const problemeLien = lien ? problemeLienBouton(lien) : null;
      if (problemeLien) return problemeLien;
      const client = await clientWhatsApp(tenant, 'workflow sendQuickMessage', `message rapide non envoyé à ${waId}`);
      if (typeof client === 'string') return client;
      // `buttons` part entier : `sendInteractive` écarte les titres vides en préservant l'index d'origine dans
      // `btn:<i>`. Filtrer ici renumérotait, et une réponse placée après une case vide ne correspondait plus à
      // aucune branche.
      //
      // Visuel : téléversé chez Meta et posé en en-tête, via le préparateur des visuels de template (cache par
      // numéro et URL). Préparation ratée -> refus explicite, jamais un envoi sans l'image demandée.
      let mediaId: string | undefined;
      if (mediaUrl && mediaUrl.trim() !== '') {
        const prepare = await prepareHeaderMedia(tenant, mediaUrl.trim());
        if (!prepare) return 'le visuel du bloc « message rapide » n’a pas pu être préparé pour l’envoi';
        mediaId = prepare;
      }
      const utilisables = buttons.some((b) => b.text.trim() !== '');
      // Le bouton de lien passe en premier et ne cohabite pas avec des réponses rapides (`button` et `cta_url`
      // sont deux types de messages chez Meta ; le moteur vide déjà `buttons`). Un interactif exige un bouton :
      // visuel sans bouton = image légendée ; ni visuel ni bouton = texte simple.
      const res = lien
        ? await client.sendCtaUrl(waId, body, lien, mediaId)
        : utilisables
          ? await client.sendInteractive(waId, body, buttons, mediaId)
          : mediaId
            ? await client.sendImage(waId, mediaId, body)
            : await client.sendText(waId, body);
      // Journalise le message rapide dans le fil de conversation (best-effort, ne casse jamais l'envoi Meta réussi).
      try { await inboxStore.recordOutboundByWaId(tenant, waId, { body, messageId: res.messageId, type: 'text', origine: 'scenario' }); } catch { /* best-effort */ }
      return { messageId: res.messageId };
    },
    /**
     * Bloc Question : une liste interactive dès qu'une ligne porte un libellé, un simple texte sinon (Meta
     * refuse une liste vide). Le contact répond en choisissant une ligne, ou en écrivant.
     *
     * `rows` part entier : `sendList` écarte les lignes vides après numérotation, pour que `row:<i>` reste
     * aligné sur la ligne de l'éditeur. Filtrer ici décalerait les numéros vers une mauvaise branche.
     */
    sendQuestion: async (tenant, waId, body, buttonLabel, rows) => {
      if (dryRun) return; // DRY_RUN : aucun appel Meta
      if (body.trim() === '') return 'le bloc « question » n\'a pas de texte'; // défense, actionOf filtre déjà
      const client = await clientWhatsApp(tenant, 'workflow sendQuestion', `question non envoyée à ${waId}`);
      if (typeof client === 'string') return client;
      /**
       * Variables `{{prenom}}` du contact, résolues ici : le panneau du bloc offre « + Variable », et sans cette
       * résolution le contact lirait `{{prenom}}` en toutes lettres. La fiche n'est lue que si le texte en porte.
       */
      const aVariable = /\{\{\s*[\w.-]+\s*\}\}/.test(body) || rows.some((r) => /\{\{\s*[\w.-]+\s*\}\}/.test(r.title) || /\{\{\s*[\w.-]+\s*\}\}/.test(r.description ?? ''));
      let corps = body;
      let lignes = rows;
      if (aVariable) {
        const vars = await varsDuContact(tenant, waId);
        corps = renderText(body, vars, { html: false });
        lignes = rows.map((r) => ({
          title: renderText(r.title, vars, { html: false }),
          ...(r.description ? { description: renderText(r.description, vars, { html: false }) } : {}),
        }));
      }
      const avecMenu = lignes.some((r) => r.title.trim() !== '');
      const res = avecMenu
        ? await client.sendList(waId, corps, buttonLabel, lignes)
        : await client.sendText(waId, corps);
      // Journalise la question dans le fil (best-effort), avec le corps reçu par le contact, variables résolues.
      try { await inboxStore.recordOutboundByWaId(tenant, waId, { body: corps, messageId: res.messageId, type: 'text', origine: 'scenario' }); } catch { /* best-effort */ }
      return { messageId: res.messageId };
    },
    // Formulaire (node flow), hors template, toujours en fenêtre 24 h (`advance`, ou un démarrage dont la garde de
    // fenêtre est levée). La complétion revient en nfm_reply, mappée par _ref, indépendamment du canal d'envoi.
    sendFlow: async (tenant, waId, flowId, body, cta) => {
      if (dryRun) return; // DRY_RUN : aucun appel Meta
      if (flowId.trim() === '') return 'le bloc « formulaire » ne désigne aucun formulaire'; // défense, actionOf filtre déjà
      const client = await clientWhatsApp(tenant, 'workflow sendFlow', `formulaire non envoyé à ${waId}`);
      if (typeof client === 'string') return client;
      // flow_token jamais vide (exigence Meta #131009) mais jetable : la corrélation passe par le _ref du flow_json.
      const res = await client.sendFlowMessage(waId, { body, flowId, cta, flowToken: `${waId}-${Date.now()}` });
      // Journalise l'envoi dans le fil (best-effort). Le corps = l'accroche visible par le contact.
      try { await inboxStore.recordOutboundByWaId(tenant, waId, { body, messageId: res.messageId, type: 'text', origine: 'scenario' }); } catch { /* best-effort */ }
      return { messageId: res.messageId };
    },
  };
}
