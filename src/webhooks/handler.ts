import { parseWebhook } from './parse';
import { processStatuses } from './delivery';
import type { EchecsLibresSink, NodeStatusSink, RemiseMbaSurAccuse } from './delivery';
import { extractInbound, processInbound } from './inbound';
import { processFlowCompletions } from './flow-mapping';
import { processWorkflowAdvance } from './workflow-advance';
import { processRemiseMbaEntrant, type RemiseMbaEntrantDeps } from './remise-mba-entrant';
import { lireLesBascules, processHandovers } from './handover';
import { processTriggers } from './triggers';
import { processTestTokens } from './test-token';
import { processArriveesPub, type ArriveesPubDeps } from './arrivees-pub';
import { processRoutagePub, rendreLesFilsSansReponse, type RoutagePubDeps } from './routage-pub';
import type { RoutageDuMessage } from '../pubs/routage';
import { ecarterLesEntrantsDelies, type NumerosDelies } from './numeros-delies';
import type { TarifsMetaSink } from './tarif-meta';
import type { DeliveryStore } from './delivery';
import type { DetenteurDuFil, InboxStore, InboundAssignation, InboundContactUpsert, InboundOptOut } from './inbound';
import type { ArriveeParWidget } from '../widgets/arrivee';
import type { FlowMappingLookup, ContactFieldWriter } from './flow-mapping';
import type { WorkflowAdvanceDeps } from './workflow-advance';
import type { HandoverDeps } from './handover';
import type { TriggerDeps } from './triggers';
import type { TestTokenDeps } from './test-token';
import type { EventStore } from './store';
import type { AuditSink } from '../audit/journal';
import type { SignalAccuse } from './delivery';
import type { SignalReponse } from './inbound';
import { rattacherLesEntrants, uneLectureParNumero, type EntrantRattache, type NumeroVersEspace } from './rattachement';
import { requalifierLesStandby, type ListeALArrivee } from './standby-hors-liste';
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
 * Les dépendances du traitement d'un webhook, nommées plutôt que positionnelles : une file de paramètres
 * optionnels de types voisins se câble de travers sans que le compilateur le voie. Tout est optionnel sauf
 * `store` et les couples ci-dessous : une dépendance absente désactive son étape, ce dont la file des accusés se
 * sert pour n'exécuter que la livraison.
 */
interface WebhookJobDepsCommunes {
  /** Le seul obligatoire : l'insertion idempotente des événements bruts. */
  store: EventStore;
  flowMapping?: FlowMappingDeps;
  inboundContactUpsert?: InboundContactUpsert;
  /** Mesure par bloc (« Mes tableaux ») : rattache les accusés Meta au bloc qui a envoyé le message. */
  nodeEvents?: NodeStatusSink;
  /**
   * Répartition d'une réponse de campagne dans l'Inbox (`campaigns.assignation`). Absente : aucune affectation
   * automatique, la conversation tombe dans « À traiter ».
   */
  inboundAssignation?: InboundAssignation;
  /**
   * L'arrivée par un widget WhatsApp (`src/widgets/arrivee.ts`), en dernière étape de `processInbound`. Absente :
   * aucun widget n'est reconnu, le comportement d'avant le lot 3 du widget.
   */
  inboundWidget?: ArriveeParWidget;
  /**
   * Remise du fil à l'agent de Meta à l'arrivée de l'accusé de notre dernier envoi. Absente : les fils sont
   * rendus par le balayage de contrôle, plus tard.
   */
  remiseMba?: RemiseMbaSurAccuse;
}

/**
 * Les étapes qui ont besoin de l'espace d'un entrant ou d'une bascule. Elles le reçoivent déjà rattaché, lu une
 * fois par numéro par `handleWebhookJob` dans `inbox` : elles n'existent donc qu'avec l'Inbox, et le type le dit.
 */
interface EtapesRattachees {
  workflowAdvance?: WorkflowAdvanceDeps;
  /**
   * Confie la conversation à l'agent de Meta quand un client écrit et que personne ne suit. Câblé sur la file
   * `webhook` seulement : `webhook-status` ne porte que des accusés.
   */
  remiseMbaEntrant?: RemiseMbaEntrantDeps;
  handover?: HandoverDeps;
  /** Automations. `isNewContact` est fourni ici : il vient de l'upsert d'inbound, pas d'une requête. */
  triggers?: Omit<TriggerDeps, 'isNewContact'>;
  /** Jetons de test d'un scénario, prioritaires sur l'avance et sur les automations. */
  testTokens?: TestTokenDeps;
}

/**
 * 🔴 Des dépendances obligatoires par couple, refusées par le compilateur si l'une manque, parce qu'un oubli ne
 * se verrait nulle part :
 *  - une file qui traite des accusés (`delivery`) garde leur tarif (`tarifsMeta`, seule source de « Meta ne
 *    facture pas ce message »), l'échec des messages libres et les signaux : les accusés arrivent par deux files ;
 *  - une file qui traite des entrants (`inbox`) garde les arrivées publicitaires (Meta n'envoie `ctwa_clid`
 *    qu'une fois), route les leads (`routagePub`, sans quoi un clic payé irait aux automations ordinaires), émet
 *    les signaux de réponse, écarte les entrants d'un numéro délié et enregistre le STOP (`inboundOptOut`) : une
 *    dépendance de consentement n'est jamais optionnelle, un câblage qui l'oublierait laisserait `opted_in` un
 *    contact qui a répondu STOP. Elle corrige aussi le détenteur du fil (`detenteur`) : un `standby` rend le fil à
 *    l'agent de Meta (`ControleDuFil.entrantEnStandby`, `src/inbox/fil.ts`), et un câblage qui l'oublierait
 *    laisserait notre colonne contredire Meta. Elle lit enfin la liste de l'agent de Meta (`listeALArrivee`) : un
 *    `standby` d'un contact absent de la liste est pour nous (`./standby-hors-liste.ts`), et un câblage qui
 *    l'oublierait laisserait sans réponse, en silence, toute réponse texte à un modèle. Le numéro vers l'espace se
 *    lit dans `inbox` (`NumeroVersEspace`).
 * Les tests qui n'en parlent pas passent les fixtures de `tests/webhook-fixtures.ts` (`aucunTarif`,
 * `aucuneArriveePub`, `aucunRoutagePub`, `aucunSignalAccuse`, `aucunSignalReponse`, `aucunNumeroDelie`,
 * `aucuneCorrectionDuDetenteur`, `agentEteintALArrivee`, `aucunStop`), qui disent leur hypothèse.
 */
export type WebhookJobDeps = WebhookJobDepsCommunes
  & (
    // `echecsLibres` entre dans le couple des accusés : une file qui applique des statuts note aussi l'échec d'un
    // message libre, sinon il redevient invisible selon la file.
    { delivery: DeliveryStore; tarifsMeta: TarifsMetaSink; echecsLibres: EchecsLibresSink; signauxAccuse: SignalAccuse }
    | { delivery?: undefined; tarifsMeta?: undefined; echecsLibres?: undefined; signauxAccuse?: undefined }
  )
  & (
    ({
      inbox: InboxStore & NumeroVersEspace; arriveesPub: ArriveesPubDeps; routagePub: RoutagePubDeps; signalReponse: SignalReponse;
      numerosDelies: NumerosDelies; inboundOptOut: InboundOptOut; detenteur: DetenteurDuFil; listeALArrivee: ListeALArrivee;
    } & EtapesRattachees)
    | ({
      inbox?: undefined; arriveesPub?: undefined; routagePub?: undefined; signalReponse?: undefined;
      numerosDelies?: undefined; inboundOptOut?: undefined; detenteur?: undefined; listeALArrivee?: undefined;
    } & { [K in keyof EtapesRattachees]?: undefined })
  );

/**
 * Traitement d'un job webhook (côté worker) : parse le payload brut, insère chaque événement de façon
 * idempotente, puis applique les étapes fournies. Une erreur des étapes cœur est propagée pour laisser pg-boss
 * rejouer puis mettre en DLQ ; les étapes secondaires sont isolées.
 */
export async function handleWebhookJob(recu: unknown, deps: WebhookJobDeps): Promise<void> {
  const {
    store, delivery, flowMapping, workflowAdvance, remiseMbaEntrant, inboundContactUpsert,
    handover, triggers, testTokens, nodeEvents, inboundAssignation, inboundWidget, remiseMba,
    tarifsMeta, echecsLibres, arriveesPub, routagePub, signauxAccuse, signalReponse, numerosDelies,
  } = deps;
  /**
   * 🔴 En tout premier : l'écart des entrants d'un numéro délié, avant le journal brut, l'extraction des entrants et
   * les étapes qui lisent le payload : écarter plus bas laisserait passer ce qu'une étape antérieure aurait enregistré.
   * Garde les accusés, ne lève jamais (`./numeros-delies.ts`).
   */
  const raw = numerosDelies ? await ecarterLesEntrantsDelies(recu, numerosDelies) : recu;
  const events = parseWebhook(raw);
  // `insertEvent` rend false quand l'événement était déjà enregistré : le signal d'un rejeu (redélivrance Meta,
  // job pg-boss réessayé), retenu pour les étapes non idempotentes par ailleurs, comme le démarrage d'un test (un
  // rejeu renverrait la séquence au testeur et facturerait les templates une seconde fois).
  const alreadySeen = new Set<string>();
  for (const ev of events) {
    const isNew = await store.insertEvent({ source: ev.source, dedupKey: ev.dedupKey, data: ev.data });
    if (!isNew && ev.dedupKey.startsWith('msg:')) alreadySeen.add(ev.dedupKey.slice(4));
  }
  if (delivery) await processStatuses(events, delivery, { tarifs: tarifsMeta, echecsLibres, nodeEvents, remiseMba, signaux: signauxAccuse });
  // Contacts créés par ce webhook (clé `tenant:waId`) : le signal « 1er message d'un contact inconnu » n'existe
  // qu'à l'instant de l'upsert, on le capture pour la durée de ce job. Limite assumée : il ne survit pas à un retry
  // pg-boss (la fiche existe déjà, `new_contact` ne part pas) ; le rendre infaillible coûterait une requête par
  // message entrant.
  const createdContacts = new Set<string>();
  const upsert: InboundContactUpsert | undefined = inboundContactUpsert
    ? async (tenantId, m) => {
        const r = await inboundContactUpsert(tenantId, m);
        if (r === 'created') createdContacts.add(`${tenantId}:${m.waId}`);
        return r;
      }
    : undefined;
  /**
   * Les messages qui ont démarré le scénario d'un widget, captés de la même façon, pour la durée de ce job : ils sont
   * CONSOMMÉS, comme ceux qui démarrent une automation, et forment le premier contenu de `consumed`, plus bas.
   */
  const prisParUnWidget = new Set<string>();
  const widget: ArriveeParWidget | undefined = inboundWidget
    ? async (tenantId, m) => {
        const pris = await inboundWidget(tenantId, m);
        if (pris) prisParUnWidget.add(m.messageId);
        return pris;
      }
    : undefined;
  /**
   * Les entrants, extraits une fois et rattachés à leur espace : une lecture par numéro distinct pour tout le job, et
   * aucune étape ne relit le numéro, sinon un message coûterait une lecture par étape. Une lecture en échec lève ici,
   * avant tout enregistrement, et fait rejouer le job : l'enregistrement, cœur du webhook, ne se fait pas sans
   * l'espace. Sans Inbox (la file des accusés), aucune étape n'a besoin d'un espace et rien n'est lu.
   */
  const espaceDe = deps.inbox ? uneLectureParNumero(deps.inbox) : null;
  let entrants: readonly EntrantRattache[] = [];
  // Les messages qui viennent de rouvrir leur conversation (« Traité » ou Archivé retiré), su par leur écriture même.
  let rouvertes: ReadonlySet<string> = new Set();
  if (deps.inbox && espaceDe) {
    /**
     * Juste après le rattachement, avant tout ce qui lit `field` : un `standby` d'un contact absent de la liste de
     * l'agent de Meta devient un `messages` pour toutes les étapes (`./standby-hors-liste.ts`). Une lecture de la
     * liste par espace pour le lot ; en échec, elle lève avant l'enregistrement et fait rejouer le job.
     */
    entrants = await requalifierLesStandby(await rattacherLesEntrants(extractInbound(raw), espaceDe), deps.listeALArrivee);
    rouvertes = await processInbound(entrants, deps.inbox, {
      upsertContact: upsert, optOut: deps.inboundOptOut, assignation: inboundAssignation, signalReponse, detenteur: deps.detenteur,
      widget,
    });
  }
  // L'arrivée publicitaire, après l'upsert du contact qu'elle retrouve par son wa_id. Isolée par message : elle
  // ne fait jamais échouer le job.
  if (arriveesPub) await processArriveesPub(entrants, arriveesPub);
  /**
   * Le routage d'un lead publicitaire, entre l'arrivée (dont il annote la ligne) et les déclencheurs (qu'il
   * restreint) : placé après, il regarderait partir les automations qu'il devait écarter. Il reprend le fil pour un
   * lead resté en `standby` (son contact est sur la liste de l'agent) : retrait borné (un essai et un rejeu,
   * `ControleDuFil.reprendrePourLApp`) et isolé. Une panne rend la carte vide, donc le chemin ordinaire : mieux vaut
   * un lead ramassé qu'un lead qui ne va nulle part.
   */
  let routage: ReadonlyMap<string, RoutageDuMessage> = new Map();
  if (routagePub) {
    try {
      // `alreadySeen` : ce que Meta redélivre ; le routage ne reprend pas le fil une seconde fois, ce qui arracherait
      // la conversation à l'opérateur qui l'aurait reprise.
      routage = await processRoutagePub(entrants, routagePub, alreadySeen);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleWebhookJob: routage publicitaire ignoré:', messageDe(err));
    }
  }
  // Report Flow -> user fields, isolé : un throw rejouerait tout le webhook, statuts déjà traités compris.
  if (flowMapping) {
    await tenter('handleWebhookJob: mapping flow ignoré:', () => processFlowCompletions(raw, flowMapping.lookup, flowMapping.writer, flowMapping.audit));
  }
  // Jetons de test d'un scénario, en premier : un jeton n'est ni une réponse à un parcours ni un mot-clé. Ordre :
  // jetons -> automations -> avance, chacune retirant à la suivante les messages qu'elle a consommés. Isolé.
  // `consumed` part de ce que les widgets ont pris dans `processInbound` : un message qui a démarré le scénario d'un
  // widget ne démarre pas d'automation par-dessus, et n'est la réponse d'aucun parcours (`src/widgets/arrivee.ts`).
  let consumed: ReadonlySet<string> = prisParUnWidget;
  if (testTokens) {
    try {
      const parJeton = await processTestTokens(entrants, testTokens, alreadySeen);
      if (parJeton.size > 0) consumed = new Set([...consumed, ...parJeton]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleWebhookJob: jeton de test ignoré:', messageDe(err));
    }
  }
  /**
   * Automations déclenchées par un message (mot-clé, 1er message d'un nouveau contact), avant l'avance : quand un
   * message est à la fois la réponse attendue par un parcours et le déclencheur d'un autre scénario, le
   * déclencheur gagne. Sinon l'ancien parcours enverrait son bloc suivant avant d'être fermé par le nouveau, et le
   * client recevrait deux messages. Isolé comme les autres étapes.
   */
  if (triggers) {
    try {
      const parAutomation = await processTriggers(entrants, {
        ...triggers,
        // Consommé une seule fois : si Meta regroupe deux messages d'un même nouveau contact, seul le premier est un
        // « 1er message ».
        isNewContact: async (tenantId, waId) => createdContacts.delete(`${tenantId}:${waId}`),
      }, consumed, routage);
      // Union : un message consommé par un jeton de test l'était déjà, un message qui vient de démarrer un
      // scénario le devient. L'avance ci-dessous ne verra ni l'un ni l'autre.
      if (parAutomation.size > 0) consumed = new Set([...consumed, ...parAutomation]);
      /**
       * Le fil pris pour rien se rend, et c'est ici qu'on peut le savoir : le routage prend le fil avant cette étape,
       * sans savoir si une automation parlera (anti-rebond, scénario disparu). `parAutomation` tranche. Sans ce
       * retour, personne ne répondrait avant le balayage de contrôle, fenêtre de service fermée, sur un clic payé.
       */
      if (routagePub) await rendreLesFilsSansReponse(routage, parAutomation, routagePub);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleWebhookJob: automations ignorées:', messageDe(err));
    }
  }
  // Avance des workflows sur les réponses, isolée elle aussi.
  if (workflowAdvance) {
    await tenter('handleWebhookJob: avance workflow ignorée:', async () => {
      // Un message qu'un parcours a reçu est à lui : la remise ne le rejoue pas (voir `WorkflowAdvanceDeps.advance`).
      const parParcours = await processWorkflowAdvance(entrants, workflowAdvance, consumed);
      if (parParcours.size > 0) consumed = new Set([...consumed, ...parParcours]);
    });
  }
  /**
   * Un client écrit et personne ne suit : la conversation est confiée à l'agent de Meta, qui y répond. Après
   * l'avance, et l'ordre est le correctif : l'avance peut laisser un run en attente, que la garde du câblage lit pour
   * refuser la remise ; placé avant, ce bloc donnerait à l'agent un fil qu'un scénario s'apprête à utiliser. Isolé :
   * le balayage reste le filet.
   */
  if (remiseMbaEntrant) {
    // `alreadySeen` : un message que Meta redélivre ne démarre pas une seconde fois le répondeur IA de l'espace.
    await tenter('handleWebhookJob: remise à l’agent de Meta ignorée:', () => processRemiseMbaEntrant(entrants, remiseMbaEntrant, consumed, rouvertes, alreadySeen));
  }
  /**
   * Bascules de contrôle et messages de l'agent de Meta. Isolé : ces événements sont les moins bien documentés, et
   * ne doivent pas emporter les statuts de livraison dans la DLQ. Leur rattachement aussi, qui ne relit pas un numéro
   * déjà lu pour les entrants : un numéro que seule une bascule nomme, illisible, ignore l'étape sans faire rejouer
   * le job.
   */
  if (handover && espaceDe) {
    await tenter('handleWebhookJob: handover ignoré:', async () => processHandovers(await lireLesBascules(raw, espaceDe), handover));
  }
}
