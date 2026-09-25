import type { ConditionGroup } from '../workflow/conditions';

/**
 * Décide si un ÉVÉNEMENT déclenche une automation. Module PUR (aucune IO, aucun import qui tire pg) ->
 * testable en unitaire sans base, comme `workflow/conditions.ts` et `workflow/engine.ts`.
 *
 * Ce module ne fait QUE la mise en correspondance déclencheur <-> événement, plus le garde-fou anti-rebond.
 * L'évaluation du `conditionGroup` (état du contact) et le démarrage du scénario restent au runner, qui a l'IO.
 */

/**
 * Types de déclencheur livrés. Volontairement fermé : une valeur inconnue en base ne déclenche jamais rien.
 *
 * `tag_added` (E.2) est émis via la file `automation-event` : un tag peut être posé depuis l'API (autre
 * process que le worker), qui ne sait pas démarrer un scénario elle-même. ⚠️ Seuls les chemins UNITAIRES
 * émettent (bloc Action d'un scénario, édition d'une fiche) : un import CSV ou une action en masse
 * n'émettent PAS, sinon poser un tag sur 5 000 contacts enverrait 5 000 messages facturés d'un coup. Pour
 * toucher une liste, l'outil est la campagne.
 *
 * `conversation_analyzed` (E.2) vient du point de sortie de l'analyse (`OnConversationAnalyzed`). Il est donc
 * DIFFÉRÉ par construction : l'analyse tourne quand la conversation est inactive, pas à chaud sur un message.
 */
/**
 * `hubspot_deal_stage` : un deal du CRM vient d'atteindre une ÉTAPE précise. Réglé par IDENTIFIANT
 * d'étape, jamais par libellé : un client qui renomme son étape dans HubSpot casserait sinon son
 * automation sans que rien ne le dise. Le libellé n'est stocké que pour l'affichage.
 */
/**
 * `webhook` : un outil tiers a posté sur l'URL d'un webhook entrant (menu Tools). Réglé par IDENTIFIANT de
 * webhook. Ces automations sont POSSÉDÉES par leur webhook : créées et supprimées depuis l'écran
 * Tools > Webhooks, et l'écran Automation ne les liste pas (voir migration 0074).
 */
/**
 * `avant_date` : un dela, avant la date stockee dans un champ du contact. Le seul declencheur qui ne repond
 * pas a un evenement mais a l'ECOULEMENT DU TEMPS : c'est un balayage qui le leve (`automation/date-sweep`),
 * et c'est lui qui a deja tranche l'echeance. Voir `automation/avant-date.ts`.
 */
/**
 * `risque_eleve` (lot 7 de l'API publique) : un contact vient de PASSER en risque de désengagement élevé. Émis
 * par le balayage de nuit (`src/engagement/balayage.ts`), seulement sur un passage, au plus 200 par nuit et par
 * espace : c'est le seul chemin de MASSE qui émet, par exception décidée (voir le balayage). Aucune config :
 * « risque élevé » ne se règle pas, il se constate.
 */
export const AUTOMATION_TRIGGER_KINDS = ['keyword', 'new_contact', 'tag_added', 'conversation_analyzed', 'hubspot_deal_stage', 'webhook', 'avant_date', 'ctwa_ad', 'risque_eleve'] as const;
export type AutomationTriggerKind = (typeof AUTOMATION_TRIGGER_KINDS)[number];
export function isAutomationTriggerKind(v: unknown): v is AutomationTriggerKind {
  return typeof v === 'string' && (AUTOMATION_TRIGGER_KINDS as readonly string[]).includes(v);
}

/** Comment un mot-clé est comparé au message reçu. `equals` sert aussi aux jetons opaques (lien de test wa.me). */
export type KeywordMode = 'contains' | 'equals';

/**
 * Le propriétaire d'une automation née d'un lien de chaîne WhatsApp (colonne `automations.possede_par`,
 * migration 0114).
 *
 * ⚠️ LA MÊME CHAÎNE VIT AUSSI EN DUR DANS LES REQUÊTES SQL de `src/channels-me/link-store.pg.ts`, où elle
 * est une GARDE MIROIR (ce store ne peut toucher QUE ses propres automations). Un littéral SQL ne se
 * paramètre pas sans transformer une constante en interpolation de chaîne dans une requête, ce qui a la
 * forme exacte d'une injection à la relecture. Les deux sont donc tenues alignées par un test qui lit la
 * source (`tests/automation-chaine-reprend-la-main.test.ts`), pas par le compilateur.
 */
export const POSSESSEUR_LIEN_CHAINE = 'channelsme_link';

/**
 * Le propriétaire d'une automation née d'une PUBLICITÉ Click-to-WhatsApp (lot 3, migration 0170).
 *
 * ⚠️ ELLE EST ÉCRITE PAR LA CRÉATION D'UNE PUBLICITÉ (`PgPublicitesStore.creerAutomation`) et LUE par le
 * routage, qui sait qu'une automation de publicité reprend la main (`reprendLaMain`). Les deux moitiés
 * sont tenues alignées par un test de source, comme pour les liens de chaîne
 * (`tests/automation-chaine-reprend-la-main.test.ts`).
 *
 * ⚠️ CE TEXTE A DÉCRIT UN ÉTAT INTERMÉDIAIRE PENDANT TROIS COMMITS (« lue et par personne écrite », « le
 * test viendra »), alors que le commit suivant du même lot l'avait démenti. Un commentaire qui décrit une
 * ÉTAPE se périme au commit d'après, et il se lit comme un constat : celui-ci faisait conclure que rien
 * ne crée d'automation de publicité.
 *
 * 🔴 CE QUE CET ALIGNEMENT PROTÉGERA. Si la constante et le littéral SQL divergeaient, l'automation
 * deviendrait intouchable par son propriétaire ET invisible de l'écran Automations (`HORS_WEBHOOK` exclut
 * tout `possede_par` non nul) : elle continuerait de déclencher sans que personne puisse l'éteindre.
 */
export const POSSESSEUR_PUBLICITE = 'publicite';

/**
 * Cette automation vient-elle d'un BOUTON DE CHAÎNE ?
 *
 * 🔴 CE QUE CETTE QUESTION DÉCIDE, et pourquoi elle a un nom. Julien, le 2026-09-08 : « quand ça vient d'une
 * chaîne et que ça pointe vers un scénario, ça reprend la main ». Un abonné qui clique le bouton d'une
 * publication a fait un geste EXPLICITE vers ce scénario : c'est la même logique qu'une campagne, qui reprend
 * la main parce que c'est un opérateur qui la déclenche. Ici c'est le contact lui-même.
 *
 * Sans ça, le clic ne lançait RIEN dès que le fil était tenu, et il l'est presque toujours au second clic :
 * l'espace ayant l'agent de Meta allumé, chaque scénario lui rend le fil en arrivant au bout, pour 24 heures.
 * Vécu le 2026-09-08, et parfaitement muet côté abonné comme côté console.
 *
 * ⚠️ CE N'EST VRAI QUE DE LA CHAÎNE, et c'est ce qui rend la règle tenable : une automation ORDINAIRE par
 * mot-clé ne reprend toujours pas la main, sinon n'importe quel message d'un contact écraserait l'opérateur
 * qui est en train de lui répondre.
 */
export function vientDuneChaine(a: AutomationRow): boolean {
  return a.possedePar === POSSESSEUR_LIEN_CHAINE;
}

/**
 * CE DÉMARRAGE REPREND-IL LA CONDUITE DU FIL, même tenue par un opérateur ou par l'agent de Meta ?
 *
 * 🔴 DEUX PROPRIÉTAIRES, NOMMÉS, ET PAS « POSSÈDE UN PROPRIÉTAIRE QUELCONQUE ». Le bouton de chaîne (2026-09-08)
 * et la publicité Click-to-WhatsApp (lot 3) ont la même justification : le contact a fait un geste EXPLICITE
 * vers CE scénario, en cliquant un bouton ou une publicité. Un futur propriétaire (un autre canal, un
 * connecteur) hériterait sinon d'un pouvoir que personne ne lui a accordé, et sans qu'aucun type ne bouge.
 *
 * 🔴 ET LA PUBLICITÉ EN A ENCORE PLUS BESOIN QUE LA CHAÎNE. Le lead d'une pub arrive très souvent sur un fil
 * que l'agent de Meta tient déjà (c'est le cas du numéro du pilote, où il répond à tout le monde) : sans la
 * reprise, le scénario ne démarrerait jamais, en silence des deux côtés, sur un clic PAYÉ.
 *
 * ⚠️ UNE AUTOMATION ORDINAIRE VAUT TOUJOURS `false`, et ce sens-là compte autant que l'autre : un mot-clé qui
 * reprendrait la main ferait écrire un scénario par-dessus l'opérateur en train de répondre au client.
 */
export function reprendLaMain(a: AutomationRow): boolean {
  return vientDuneChaine(a) || a.possedePar === POSSESSEUR_PUBLICITE;
}

export interface AutomationRow {
  id: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  triggerKind: AutomationTriggerKind;
  /** Config brute, dépend du type de déclencheur (opaque : toujours coercée, jamais castée). */
  triggerConfig: Record<string, unknown>;
  conditionGroup: ConditionGroup | null;
  workflowId: string;
  startNodeId: string | null;
  /**
   * Proprietaire de cette automation, quand elle en a un. `null` = automation ordinaire, creee et pilotee
   * depuis l'ecran Automation.
   *
   * Requis et non optionnel a dessein, comme `maxFiresPerHour` juste en dessous : c'est le compilateur qui
   * doit enumerer tous les endroits qui fabriquent une ligne d'automation. Un cablage muet retomberait sur
   * `undefined`, et un lien de chaine cesserait de reprendre la main sans que rien ne le dise.
   */
  possedePar: string | null;
  /** null = défaut serveur. 0 = aucun anti-rebond. */
  cooldownSeconds: number | null;
  /**
   * Plafond horaire de declenchements PROPRE a cette automation. null = plafond global de l'instance
   * (`AUTOMATION_MAX_FIRES_PER_HOUR`), qui reste la regle pour toutes les automations ordinaires.
   * 0 = aucun plafond, meme convention que le reglage global.
   *
   * Requis et non optionnel a dessein : c'est le compilateur qui doit enumerer tous les endroits qui
   * fabriquent une ligne d'automation, sinon un cablage muet retomberait sur `undefined` sans que rien ne
   * le dise, et le plafond global s'appliquerait la ou on croyait l'avoir desserre.
   */
  maxFiresPerHour: number | null;
}

/** L'événement observé, forme normalisée par l'appelant (webhook, file d'événements, hook d'analyse). */
export type AutomationEvent =
  /** `channel` = le tuyau du message reçu. Il décide notamment si la fenêtre de service WhatsApp est
   *  prouvée ouverte : un message RCS ne prouve RIEN côté Meta (cf. `runAutomations`). */
  /** `adId` = la publicité Click-to-WhatsApp d'où vient ce message, quand il y en a une. Meta ne le
   *  transmet que sur le PREMIER message après le clic. */
  /** `campagneId` = la CAMPAGNE de cette publicité, résolue par le routage (lot 3) avant d'arriver ici. Meta
   *  ne la transmet PAS dans le webhook : elle vient de `pubs_connues`, ou d'un appel fait une seule fois
   *  pour une pub jamais vue. Absente = campagne inconnue, ce qui est le cas de tout le trafic d'avant ce
   *  lot et de toute pub qu'on ne pilote pas. */
  | { kind: 'message'; waId: string; body: string | null; isNewContact: boolean; channel: 'whatsapp' | 'rcs'; adId?: string; campagneId?: string }
  | { kind: 'tag_added'; waId: string; tag: string }
  /** Une conversation vient d'être analysée : `sentiment` catégoriel (pas de score numérique) + `resolved`. */
  | { kind: 'analysis'; waId: string; sentiment: string; resolved: boolean }
  /**
   * Un deal HubSpot a changé d'étape. `stageId` et `pipelineId` sont les identifiants INTERNES de HubSpot,
   * stables au renommage. Le contact est déjà résolu en `waId` par le connecteur : sans numéro exploitable,
   * l'événement n'atteint jamais mba (rien à joindre).
   */
  | { kind: 'hubspot_deal_stage'; waId: string; pipelineId: string; stageId: string }
  /**
   * Un webhook entrant a reçu un appel exploitable. Le contact est déjà résolu en `waId` par la route : sans
   * téléphone exploitable, l'événement n'est jamais publié (il n'y aurait personne à joindre).
   */
  | { kind: 'webhook'; waId: string; webhookId: string }
  /**
   * L'echeance d'une date de champ est arrivee. `valeur` est la date TELLE QU'ELLE EST STOCKEE : elle sert
   * de marqueur d'occurrence, pour qu'un rendez-vous reporte redonne un rappel.
   */
  | { kind: 'avant_date'; waId: string; automationId: string; valeur: string }
  /** Le contact vient de PASSER en risque de désengagement élevé (balayage de nuit). */
  | { kind: 'risque_eleve'; waId: string };

/** Minuscules, sans accents, espaces resserrés : même esprit que la recherche de blocs (web/lib/node-search). */
export function normalizeText(v: string): string {
  return v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Mots-clés déclarés dans la config, nettoyés (vides retirés). Jamais de throw sur une config malformée. */
export function keywordsOf(config: Record<string, unknown>): string[] {
  const raw = Array.isArray(config.keywords) ? config.keywords : [];
  return raw.map((k) => normalizeText(String(k ?? ''))).filter((k) => k !== '');
}

/** Mode de comparaison déclaré ; toute valeur inattendue retombe sur `contains` (le plus permissif, attendu par défaut). */
export function keywordModeOf(config: Record<string, unknown>): KeywordMode {
  return config.mode === 'equals' ? 'equals' : 'contains';
}

/**
 * L'événement correspond-il au DÉCLENCHEUR de cette automation ? Ne regarde ni `enabled`, ni le cooldown, ni
 * le `conditionGroup` : le runner compose ces trois filtres, ce qui les garde testables séparément.
 *
 * Une automation mal configurée (mot-clé vide, tag vide) ne déclenche JAMAIS : mieux vaut une automation inerte
 * qu'une automation qui part sur tous les messages.
 */
export function matchesTrigger(a: AutomationRow, ev: AutomationEvent): boolean {
  if (a.triggerKind === 'keyword') {
    if (ev.kind !== 'message') return false;
    const words = keywordsOf(a.triggerConfig);
    if (words.length === 0) return false;
    const body = normalizeText(ev.body ?? '');
    if (body === '') return false;
    return keywordModeOf(a.triggerConfig) === 'equals'
      ? words.includes(body)
      : words.some((w) => body.includes(w));
  }
  if (a.triggerKind === 'new_contact') {
    return ev.kind === 'message' && ev.isNewContact;
  }
  if (a.triggerKind === 'ctwa_ad') {
    // Le message doit VENIR d'une pub : un message ordinaire ne déclenche rien, même si l'automation n'a
    // pas de pub précise en tête.
    if (ev.kind !== 'message') return false;
    const venuDeLaPub = (ev.adId ?? '').trim();
    if (venuDeLaPub === '') return false;
    /**
     * 🔴 LA CAMPAGNE PASSE AVANT LA PUB, et c'est le niveau du lien depuis le lot 3 (décision de Julien du
     * 2026-09-22). Une automation possédée par une publicité porte `campaignId` : elle vaut alors pour la
     * campagne ENTIÈRE, donc pour les copies faites dans le Gestionnaire, qui portent chacune un identifiant
     * de pub neuf. Router sur l'identifiant de pub ferait perdre le scénario au premier duplicata.
     *
     * ⚠️ Une campagne demandée mais INCONNUE de ce message ne correspond pas : c'est une égalité, pas un
     * repli sur la pub. Retomber sur `adId` ferait déclencher une automation de campagne sur un lead dont on
     * n'a justement pas su dire la campagne.
     */
    const campagneVoulue = String(a.triggerConfig.campaignId ?? '').trim();
    if (campagneVoulue !== '') return campagneVoulue === (ev.campagneId ?? '').trim();
    // ⚠️ Doctrine DIFFÉRENTE de « tag ajouté » et « étape de deal », où une config vide n'attrape RIEN.
    // Ici, vide veut dire « n'importe quelle pub », et c'est légitime : « tout lead qui arrive par une pub
    // part dans le scénario d'accueil » est le montage le plus courant. La portée reste bornée aux messages
    // issus d'une pub, elle ne peut pas déborder sur le trafic ordinaire.
    //
    // 🔴 ET ELLE NE PART PLUS POUR UNE CAMPAGNE RELIÉE, depuis le lot 3. Ce n'est PAS écrit ici, et ça ne
    // peut pas l'être : « n'importe quelle pub » reste vrai du point de vue de la correspondance. C'est la
    // RESTRICTION posée en amont par le routage (`src/pubs/routage.ts`) qui écarte cette automation quand la
    // pub confie ses leads à un scénario précis. Changement de comportement pour les automations DÉJÀ
    // créées, assumé et tenu par un test.
    const voulue = String(a.triggerConfig.adId ?? '').trim();
    return voulue === '' || voulue === venuDeLaPub;
  }
  if (a.triggerKind === 'tag_added') {
    if (ev.kind !== 'tag_added') return false;
    const wanted = normalizeText(String(a.triggerConfig.tag ?? ''));
    return wanted !== '' && normalizeText(ev.tag) === wanted;
  }
  if (a.triggerKind === 'hubspot_deal_stage') {
    if (ev.kind !== 'hubspot_deal_stage') return false;
    // Comparaison sur les IDENTIFIANTS, bruts : ce ne sont pas des libellés saisis par un humain, donc aucune
    // normalisation à faire, et une égalité stricte est exactement ce qu'on veut. Étape non configurée ->
    // n'attrape RIEN (même doctrine que le tag vide : une automation inerte plutôt qu'une automation folle).
    const stage = String(a.triggerConfig.stageId ?? '').trim();
    if (stage === '' || stage !== ev.stageId) return false;
    // Le pipeline ne restreint QUE si les DEUX côtés le portent. Un identifiant d'étape appartient déjà à un
    // seul pipeline chez HubSpot : une étape qui correspond implique donc le bon pipeline, et ce test n'est
    // qu'une ceinture de sécurité.
    //
    // ⚠️ Il comparait sans traiter le cas de l'événement SANS pipeline. Or le webhook HubSpot ne porte pas le
    // pipeline : une automation réglée sur un pipeline précis ne se serait donc JAMAIS déclenchée. Trouvé par
    // le test de bout en bout, après le même oubli un cran plus haut (analyseur de file).
    const pipeline = String(a.triggerConfig.pipelineId ?? '').trim();
    return pipeline === '' || ev.pipelineId === '' || pipeline === ev.pipelineId;
  }
  if (a.triggerKind === 'webhook') {
    if (ev.kind !== 'webhook') return false;
    // Égalité stricte sur l'identifiant : ce n'est pas un libellé saisi, il n'y a rien à normaliser. Webhook
    // non configuré -> n'attrape RIEN, même doctrine que le tag vide (une automation inerte plutôt qu'une
    // automation qui part sur tous les webhooks de l'espace).
    const attendu = String(a.triggerConfig.webhookId ?? '').trim();
    return attendu !== '' && attendu === ev.webhookId;
  }
  if (a.triggerKind === 'avant_date') {
    if (ev.kind !== 'avant_date') return false;
    // L'echeance a deja ete calculee par le balayage, qui connaissait le fuseau de l'espace et l'etat des
    // tirs precedents. La recalculer ici la ferait diverger : l'evenement designe donc SON automation.
    return a.id === ev.automationId;
  }
  if (a.triggerKind === 'risque_eleve') {
    // Aucune config : c'est le balayage qui a constaté le passage, et il ne l'émet qu'une fois par passage.
    return ev.kind === 'risque_eleve';
  }
  if (a.triggerKind === 'conversation_analyzed') {
    if (ev.kind !== 'analysis') return false;
    // Deux filtres CUMULATIFS et tous deux facultatifs : `sentiment` (catégoriel, pas de score) et
    // `unresolvedOnly` (la demande n'a pas été réglée). Aucun des deux -> déclenche à CHAQUE analyse, ce qui
    // est un choix explicite de l'utilisateur, pas un défaut de configuration.
    const wantSentiment = String(a.triggerConfig.sentiment ?? '').trim();
    if (wantSentiment !== '' && ev.sentiment !== wantSentiment) return false;
    if (a.triggerConfig.unresolvedOnly === true && ev.resolved) return false;
    return true;
  }
  return false;
}

/**
 * Anti-rebond : ce contact a-t-il déjà déclenché CETTE automation trop récemment ?
 *
 * Sans ce garde-fou, un scénario qui pose lui-même le tag déclencheur (ou un client qui répète le mot-clé)
 * relance le scénario en boucle. `cooldownSeconds` à 0 désactive explicitement le garde-fou (choix assumé) ;
 * `null` retombe sur le défaut du serveur, comme le délai de reprise du contrôle.
 */
export function isInCooldown(
  lastFiredAt: Date | null,
  cooldownSeconds: number | null,
  defaultCooldownSeconds: number,
  now: number,
): boolean {
  if (lastFiredAt === null) return false;
  const seconds = cooldownSeconds ?? defaultCooldownSeconds;
  if (seconds <= 0) return false;
  return now - lastFiredAt.getTime() < seconds * 1000;
}
