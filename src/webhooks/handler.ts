import { parseWebhook } from './parse';
import { processStatuses } from './delivery';
import type { EchecsLibresSink, NodeStatusSink, RemiseMbaSurAccuse } from './delivery';
import { processInbound } from './inbound';
import { processFlowCompletions } from './flow-mapping';
import { processWorkflowAdvance } from './workflow-advance';
import { processRemiseMbaEntrant, type RemiseMbaEntrantDeps } from './remise-mba-entrant';
import { processHandovers } from './handover';
import { processTriggers } from './triggers';
import { processTestTokens } from './test-token';
import { processArriveesPub, type ArriveesPubDeps } from './arrivees-pub';
import { processRoutagePub, rendreLesFilsSansReponse, type RoutagePubDeps } from './routage-pub';
import type { RoutageDuMessage } from '../pubs/routage';
import { ecarterLesEntrantsDelies, type NumerosDelies } from './numeros-delies';
import type { TarifsMetaSink } from './tarif-meta';
import type { DeliveryStore } from './delivery';
import type { InboxStore, InboundAssignation, InboundContactUpsert, InboundOptOut } from './inbound';
import type { FlowMappingLookup, ContactFieldWriter } from './flow-mapping';
import type { WorkflowAdvanceDeps } from './workflow-advance';
import type { HandoverDeps } from './handover';
import type { TriggerDeps } from './triggers';
import type { TestTokenDeps } from './test-token';
import type { EventStore } from './store';
import type { AuditSink } from '../audit/journal';
import type { SignalAccuse } from './delivery';
import type { SignalReponse } from './inbound';
import { tenter } from '../lib/tenter';
import { messageDe } from '../lib/erreur';

/** Report des valeurs d'un WhatsApp Flow rempli vers les user fields du contact (optionnel). */
export interface FlowMappingDeps {
  lookup: FlowMappingLookup;
  writer: ContactFieldWriter;
  /** Journal d'audit du consentement capté par le Flow. Optionnel -> aucune trace (câblages de test). */
  audit?: AuditSink;
}

/**
 * Traitement d'un job webhook (côté worker) : parse le payload brut, insère chaque
 * événement de façon idempotente, puis (si fournis) applique les statuts de livraison aux
 * destinataires (`delivery`) et enregistre les messages entrants en conversations (`inbox`).
 * Toute erreur des étapes cœur est propagée pour laisser pg-boss faire son retry -> DLQ.
 */
/**
 * Les dépendances du traitement d'un webhook, NOMMÉES.
 *
 * 🔴 Pourquoi un objet, et pas les douze paramètres positionnels d'avant (lot 3 du programme II). L'appel de
 * la file des accusés s'écrivait `handleWebhookJob(data, eventStore, recipientStore, undefined, undefined,
 * undefined, undefined, undefined, undefined, undefined, nodeEventStore)` : SEPT `undefined` d'affilée, dont
 * aucun lecteur ne peut dire ce qu'ils désignent. Insérer un paramètre au mauvais rang y changeait le câblage
 * en silence, sans que le compilateur bronche, puisque tout est optionnel et de types voisins. C'est la même
 * leçon que `enqueueCampaignRun` au lot 5 : passé un certain nombre, on finit par en inverser deux.
 *
 * Tout est optionnel sauf `store` : une dépendance absente désactive son étape, ce qui est exactement ce dont
 * la file des accusés se sert pour n'exécuter que la livraison.
 */
interface WebhookJobDepsCommunes {
  /** Le seul obligatoire : l'insertion idempotente des événements bruts. */
  store: EventStore;
  flowMapping?: FlowMappingDeps;
  workflowAdvance?: WorkflowAdvanceDeps;
  /**
   * Rend le fil à l'agent de Meta quand un client revient et que personne ne suit (2026-09-15).
   *
   * ABSENT -> aucune remise, donc le comportement d'avant. Câblé sur la file `webhook` UNIQUEMENT : un
   * message entrant n'arrive jamais par `webhook-status`, qui ne porte que des accusés de livraison.
   */
  remiseMbaEntrant?: RemiseMbaEntrantDeps;
  inboundContactUpsert?: InboundContactUpsert;
  handover?: HandoverDeps;
  /** Automations (Lot E). `isNewContact` est fourni ICI : il vient de l'upsert d'inbound, pas d'une requête. */
  triggers?: Omit<TriggerDeps, 'isNewContact'>;
  /** Jetons de test d'un scénario (Lot F). Prioritaires sur l'avance et sur les automations. */
  testTokens?: TestTokenDeps;
  /** Mesure par bloc (« Mes tableaux ») : rattache les accusés Meta au bloc qui a envoyé le message. */
  nodeEvents?: NodeStatusSink;
  /**
   * Opt-out par mot-clé sur un message WhatsApp entrant (STOP, désabonner...). Absent -> aucun désabonnement
   * automatique, ce qui était l'état du canal WhatsApp jusqu'au 2026-08-29 alors que le RCS, lui, l'avait.
   * Voir `processInbound` pour les deux points d'ordre qui comptent.
   */
  inboundOptOut?: InboundOptOut;
  /**
   * Répartition d'une réponse de CAMPAGNE dans l'Inbox (`campaigns.assignation`, migration 0134).
   * Absente -> aucune affectation automatique, la conversation tombe dans « À traiter » comme avant.
   */
  inboundAssignation?: InboundAssignation;
  /**
   * Remise du fil à l'agent de Meta quand l'accusé de notre dernier envoi arrive (migration 0149). Absente ->
   * les fils sont rendus par le balayage de contrôle, plus tard.
   */
  remiseMba?: RemiseMbaSurAccuse;
}

/**
 * 🔴 DEUX COUPLES DE DÉPENDANCES OBLIGATOIRES (lot 1 des publicités Click-to-WhatsApp), DONT UN TRIPLET
 * DEPUIS LE LOT 3.
 *
 * Une file qui traite des ACCUSÉS (`delivery`) doit garder leur tarif (`tarifsMeta`) : c'est la seule source de
 * « Meta ne facture pas ce message », et les accusés arrivent par DEUX files (`webhook` et `webhook-status`).
 * Une file qui traite des ENTRANTS (`inbox`) doit garder les arrivées publicitaires (`arriveesPub`) : Meta
 * n'envoie `ctwa_clid` qu'une fois. Un oubli ne se verrait nulle part, donc c'est le compilateur qui le refuse.
 * Les tests qui n'en parlent pas passent `aucunTarif`, `aucuneArriveePub` et `aucunRoutagePub`
 * (`tests/webhook-fixtures.ts`), qui DISENT leur hypothèse, comme `jamaisDesabonne`.
 *
 * 🔴 `routagePub` ENTRE DANS LE MÊME COUPLE QUE `arriveesPub`, ET C'EST LA GARDE DU LOT 3. Un câblage qui
 * enregistrerait l'arrivée sans router le lead ne produirait AUCUNE erreur : la ligne serait écrite, et
 * chaque lead d'une publicité pilotée partirait dans les automations ordinaires, y compris celles d'une pub
 * qui confie ses leads à l'agent de Meta. Un clic payé répondu par le mauvais scénario, en silence.
 *
 * 🔴 LES SIGNAUX ENTRENT DANS LES MÊMES COUPLES (lot 6 de l'API publique) : un accusé arrive par DEUX files
 * (`webhook` et `webhook-status`), et un câblage qui oublierait le puits sur l'une perdrait les accusés d'un
 * découpage de lots qui appartient à Meta, sans aucune erreur. Les tests qui n'en parlent pas passent
 * `aucunSignalAccuse` et `aucunSignalReponse` (`tests/webhook-fixtures.ts`).
 *
 * 🔴 `numerosDelies` ENTRE DANS LE COUPLE DES ENTRANTS (migration 0180) : une file qui enregistre des entrants
 * doit écarter ceux d'un numéro délié, sinon le geste « Délier » de l'Accueil promet que rien n'est enregistré
 * et ne tient pas. Les tests qui n'en parlent pas passent `aucunNumeroDelie`.
 */
export type WebhookJobDeps = WebhookJobDepsCommunes
  & (
    // `echecsLibres` entre dans le couple des accusés (lot 3 de l'API publique) : une file qui applique des
    // statuts doit aussi noter l'échec d'un message libre, sinon il redevient invisible selon la file.
    { delivery: DeliveryStore; tarifsMeta: TarifsMetaSink; echecsLibres: EchecsLibresSink; signauxAccuse: SignalAccuse }
    | { delivery?: undefined; tarifsMeta?: undefined; echecsLibres?: undefined; signauxAccuse?: undefined }
  )
  & (
    { inbox: InboxStore; arriveesPub: ArriveesPubDeps; routagePub: RoutagePubDeps; signalReponse: SignalReponse; numerosDelies: NumerosDelies }
    | { inbox?: undefined; arriveesPub?: undefined; routagePub?: undefined; signalReponse?: undefined; numerosDelies?: undefined }
  );

export async function handleWebhookJob(recu: unknown, deps: WebhookJobDeps): Promise<void> {
  const {
    store, delivery, inbox, flowMapping, workflowAdvance, remiseMbaEntrant, inboundContactUpsert,
    handover, triggers, testTokens, nodeEvents, inboundOptOut, inboundAssignation, remiseMba,
    tarifsMeta, echecsLibres, arriveesPub, routagePub, signauxAccuse, signalReponse, numerosDelies,
  } = deps;
  /**
   * 🔴 EN TOUT PREMIER : l'écart des entrants d'un numéro délié (migration 0180). Placé avant le journal brut
   * et avant chaque étape, parce que chacune relit le payload de son côté : écarter plus bas laisserait passer
   * ce qu'une étape antérieure aurait déjà enregistré. Il garde les accusés et ne lève jamais (voir
   * `./numeros-delies.ts`, qui dit aussi ce que ça coûte).
   */
  const raw = numerosDelies ? await ecarterLesEntrantsDelies(recu, numerosDelies) : recu;
  const events = parseWebhook(raw);
  // `insertEvent` renvoie false quand l'événement était DÉJÀ enregistré : c'est le signal « ce webhook est un
  // rejeu » (Meta redélivre quand l'ACK se perd, pg-boss réessaie un job interrompu). On le retient pour les
  // seules étapes NON idempotentes par ailleurs, aujourd'hui le démarrage d'un test (un rejeu renverrait la
  // séquence au testeur et facturerait les templates une seconde fois).
  const alreadySeen = new Set<string>();
  for (const ev of events) {
    const isNew = await store.insertEvent({ source: ev.source, dedupKey: ev.dedupKey, data: ev.data });
    if (!isNew && ev.dedupKey.startsWith('msg:')) alreadySeen.add(ev.dedupKey.slice(4));
  }
  if (delivery) await processStatuses(events, delivery, { tarifs: tarifsMeta, echecsLibres, nodeEvents, remiseMba, signaux: signauxAccuse });
  // Contacts CRÉÉS par ce webhook (clé `tenant:waId`). Le signal « 1er message d'un contact inconnu » n'existe
  // qu'à l'instant de l'upsert : une fois la fiche créée, plus rien ne le distingue d'un habitué. On le capture
  // donc au vol, pour la durée de CE job (aucun état global, aucune requête supplémentaire).
  //
  // ⚠️ LIMITE ASSUMÉE : ce signal ne survit pas à un RETRY pg-boss du job. Si le webhook échoue après l'upsert
  // et qu'il est rejoué, la fiche existe déjà -> l'upsert renvoie 'updated' -> un déclencheur `new_contact` ne
  // partira pas pour ce contact. Le rendre infaillible imposerait une requête de comptage sur CHAQUE message
  // entrant, prix trop élevé pour un cas qui suppose déjà un job en échec. Le cas nominal est couvert.
  const createdContacts = new Set<string>();
  const upsert: InboundContactUpsert | undefined = inboundContactUpsert
    ? async (tenantId, m) => {
        const r = await inboundContactUpsert(tenantId, m);
        if (r === 'created') createdContacts.add(`${tenantId}:${m.waId}`);
        return r;
      }
    : undefined;
  if (inbox) {
    await processInbound(raw, inbox, {
      upsertContact: upsert, optOut: inboundOptOut, assignation: inboundAssignation, signalReponse,
    });
  }
  // L'arrivée publicitaire, APRÈS l'upsert du contact qu'elle retrouve par son wa_id. Isolée par message dans
  // `processArriveesPub` : elle ne fait jamais échouer le job.
  if (arriveesPub) await processArriveesPub(raw, arriveesPub);
  /**
   * LE ROUTAGE D'UN LEAD PUBLICITAIRE (lot 3, spec § 3.3), entre l'arrivée et les déclencheurs.
   *
   * 🔴 SA PLACE EST LA MOITIÉ DE SON COMPORTEMENT, dans les deux sens. APRÈS l'arrivée, parce qu'il annote la
   * ligne que celle-ci vient d'écrire (l'issue, la campagne, l'heure de la reprise). AVANT les déclencheurs,
   * parce que c'est eux qu'il restreint : placé après, il regarderait partir les automations qu'il devait
   * écarter, et un lead de publicité recevrait la réponse d'un mot-clé.
   *
   * ⚠️ IL REPREND LE FIL CHEZ META pour un lead `standby`, donc il appelle l'extérieur. C'est un appel BORNÉ
   * (un essai plus un rejeu, plafond d'attente de deux secondes, cf. `creerPrendreLeFilAvecUnRejeu`) et il
   * est isolé comme ses voisins : un Meta muet ne doit pas DLQ un webhook qui porte aussi des accusés, une
   * inbox et des flows.
   *
   * ⚠️ UNE PANNE ICI REND LA CARTE VIDE, donc le chemin ORDINAIRE. C'est le repli le moins surprenant, et il
   * est délibéré : mieux vaut un lead ramassé par « toutes les pubs » qu'un lead qui ne va nulle part.
   */
  let routage: ReadonlyMap<string, RoutageDuMessage> = new Map();
  if (routagePub) {
    try {
      // `alreadySeen` : ce que Meta nous redélivre. Le routage s'en sert pour ne pas reprendre le fil
      // une seconde fois, ce qui arracherait une conversation à l'opérateur qui l'aurait reprise.
      routage = await processRoutagePub(raw, routagePub, alreadySeen);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleWebhookJob: routage publicitaire ignoré:', messageDe(err));
    }
  }
  // Report Flow -> user fields. ISOLÉ : ne doit JAMAIS faire échouer le job (partagé avec les statuts de
  // livraison + l'inbox). Un throw ici rejouerait/DLQ tout le webhook, donc aussi les statuts déjà traités.
  if (flowMapping) {
    await tenter('handleWebhookJob: mapping flow ignoré:', () => processFlowCompletions(raw, flowMapping.lookup, flowMapping.writer, flowMapping.audit));
  }
  // Jetons de test d'un scénario (Lot F). EN PREMIER, VOLONTAIREMENT : un jeton n'est ni une réponse à un
  // parcours en cours, ni un mot-clé ordinaire. Les messages qu'il consomme sont écartés des étapes
  // suivantes, sinon un seul message déclencherait deux choses. ISOLÉ comme les autres.
  //
  // ⚠️ Il reste avant les automations, qui sont elles-mêmes passées avant l'avance le 2026-09-07 : l'ordre
  // est désormais jetons -> automations -> avance, et chacune retire à la suivante ce qu'elle a consommé.
  let consumed: ReadonlySet<string> = new Set();
  if (testTokens) {
    try {
      consumed = await processTestTokens(raw, testTokens, alreadySeen);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleWebhookJob: jeton de test ignoré:', messageDe(err));
    }
  }
  /**
   * Automations déclenchées par un message (mot-clé, 1er message d'un nouveau contact).
   *
   * 🔴 AVANT L'AVANCE DEPUIS LE 2026-09-07, et c'est une décision de Julien : quand un message est à la fois
   * une réponse attendue par le parcours en cours et le déclencheur d'un autre scénario, « le déclencheur
   * gagne, toujours ». Cette étape était en DERNIER, au motif que le déclenchement est un effet de bord ;
   * elle ne l'est plus, parce qu'un message qui démarre un scénario n'est pas une réponse au précédent.
   *
   * Sans cette inversion, l'ancien parcours avançait et ENVOYAIT son bloc suivant, puis le nouveau scénario
   * démarrait et le tuait : le client recevait deux messages, dont un venant d'un parcours qu'on venait
   * d'abandonner. Fermer le parcours (côté exécuteur) ne suffisait pas, il fallait aussi lui retirer le
   * message, exactement comme le fait le jeton de test au-dessus.
   *
   * ISOLÉ comme les autres étapes : une automation mal configurée ne doit pas DLQ le webhook partagé.
   */
  if (triggers) {
    try {
      const parAutomation = await processTriggers(raw, {
        ...triggers,
        // CONSOMMÉ une seule fois : si Meta batche deux messages du même nouveau contact dans le même webhook,
        // seul le PREMIER est un « 1er message ». Sans le retrait, le second déclencherait aussi l'accueil.
        isNewContact: async (tenantId, waId) => createdContacts.delete(`${tenantId}:${waId}`),
      }, consumed, routage);
      // Union : un message consommé par un jeton de test l'était déjà, un message qui vient de démarrer un
      // scénario le devient. L'avance ci-dessous ne verra ni l'un ni l'autre.
      if (parAutomation.size > 0) consumed = new Set([...consumed, ...parAutomation]);
      /**
       * 🔴 LE FIL PRIS POUR RIEN SE REND, ET C'EST ICI QU'ON PEUT LE SAVOIR. Le routage prend le fil à
       * l'agent de Meta AVANT cette étape, parce qu'un scénario ne démarre pas sur un fil qu'il tient.
       * Personne ne peut donc savoir, au moment de le prendre, si quelque chose va réellement parler :
       * l'automation peut encore être retenue par son anti-rebond, ou refuser parce que son scénario a
       * disparu. C'est `parAutomation` qui tranche, et il n'existe qu'ici.
       *
       * ⚠️ Sans ce retour, le fil nous resterait et PERSONNE ne répondrait jusqu'au balayage de contrôle,
       * vingt-quatre heures plus tard, quand la fenêtre de service de Meta est déjà fermée. Sur un clic
       * PAYÉ, c'est un silence complet.
       */
      if (routagePub) await rendreLesFilsSansReponse(routage, parAutomation, routagePub);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleWebhookJob: automations ignorées:', messageDe(err));
    }
  }
  // Avance des workflows sur les réponses. ISOLÉ également (même raison : ne pas DLQ le webhook partagé).
  if (workflowAdvance) {
    await tenter('handleWebhookJob: avance workflow ignorée:', () => processWorkflowAdvance(raw, workflowAdvance, consumed));
  }
  /**
   * UN CLIENT REVIENT ET PERSONNE NE SUIT : le fil repart chez l'agent de Meta (2026-09-15).
   *
   * 🔴 APRÈS L'AVANCE, ET L'ORDRE EST LE CORRECTIF LUI-MÊME. `processWorkflowAdvance` peut faire avancer un
   * parcours, donc laisser un run EN ATTENTE de la prochaine réponse : c'est précisément ce que la garde du
   * câblage lit pour refuser la remise. Placé AVANT, ce bloc lirait l'état d'avant l'avance et donnerait à
   * l'agent de Meta un fil qu'un scénario vivant s'apprête à utiliser.
   *
   * ⚠️ ISOLÉ comme ses voisins : ce webhook porte aussi les statuts, l'inbox et les flows. Une passation
   * ratée ne doit pas les emporter, et le balayage de contrôle reste le filet.
   */
  if (remiseMbaEntrant) {
    await tenter('handleWebhookJob: remise à l’agent de Meta ignorée:', () => processRemiseMbaEntrant(raw, remiseMbaEntrant, consumed));
  }
  // Bascules de contrôle et messages de l'agent Meta (pré-câblage MBA). INERTE tant que MBA n'est activé
  // sur aucun numéro. ISOLÉ : ces événements sont les moins bien documentés de tous, donc les plus
  // susceptibles d'avoir une forme inattendue, et ils ne doivent surtout pas emporter les statuts de
  // livraison avec eux dans la DLQ.
  if (handover) {
    await tenter('handleWebhookJob: handover ignoré:', () => processHandovers(raw, handover));
  }
}
