import type { ControlOwner } from '../inbox/store.pg';
import { asArray, asRecord } from './json';
import { valeurEffective } from './change';

/**
 * Changements de contrôle du fil annoncés par Meta (`messaging_handovers`), et messages que l'agent de
 * Meta a envoyés en notre nom (`standby`).
 *
 * 🔴 LA FORME N'EST PLUS DEVINÉE, ELLE EST MESURÉE (2026-09-10), et les deux suppositions étaient fausses.
 * Ce fichier a dit « LA FORME DU PAYLOAD EST DEVINÉE » pendant des semaines, et il avait raison de le dire ;
 * ce qu'il ne disait pas, c'est que du code écrit sur une supposition ne se signale pas quand la supposition
 * tombe. Quand l'agent de Meta a pris les fils, ce module a tourné sans rien enregistrer et sans rien
 * journaliser d'anormal. Les deux écarts, relevés sur des payloads réels sortis de la file :
 *
 *  1. **tout est imbriqué sous `value.standby`** (`contacts`, `messages`, `statuses`, `message_echoes`),
 *     `metadata` restant au premier niveau. D'où `valeurEffective` (`./change.ts`), commun aux sept lecteurs ;
 *  2. **un écho porte son contenu sous `message`** : `{id, timestamp, message: {to, text: {body}, ...}}`.
 *     Lire `echo.text.body` rendait `undefined`, donc rien n'était jamais enregistré.
 *
 * Les quatre formes observées, sur 58 payloads : `messages -> [contacts, messages, metadata]` (41),
 * `standby -> [contacts, statuses]` (11), `standby -> [contacts, messages]` (3),
 * `standby -> [message_echoes]` (3).
 *
 * ⚠️ CE QUI RESTE VRAI DU PRÉ-CÂBLAGE : tout est traité en champ optionnel, rien ne plante sur une forme
 * inattendue, et ce qui n'est pas reconnu est JOURNALISÉ intégralement au lieu d'être avalé. C'est cette
 * trace qui a permis de trouver les écarts ci-dessus. En revanche, une trace ne suffit pas : personne ne la
 * lit tant que rien ne va mal, et c'est pourquoi le contrat est désormais tenu par des TESTS sur les
 * payloads réels (`tests/webhooks-change.test.ts`, `tests/handover-reel.test.ts`).
 *
 * 🔴 ET `messaging_handovers` A ENFIN ÉTÉ VU, LE 2026-09-10 AU SOIR. Il n'était jamais arrivé (zéro sur 58
 * payloads) pour une raison qu'on ignorait : **il ne se déclenche que si `handoff` est configuré chez Meta**,
 * et ce bloc valait `null` sur notre numéro. La forme réelle a invalidé les DEUX suppositions de ce module :
 *
 *  1. ni `take_thread_control` ni `pass_thread_control` n'existent. Le payload dit
 *     `{type: 'control_passed', control_passed: {previous_owner_app_role: 'meta_business_agent',
 *     metadata: 'customer_request'}}`. Le repli « le texte contient business_agent, donc c'est le MBA qui
 *     détient » lisait donc le nom du détenteur PRÉCÉDENT et concluait l'INVERSE de la vérité ;
 *  2. `recipient` est un OBJET décrivant le numéro business, pas le client. Le client est dans
 *     `sender.phone_number`.
 *
 * ⚠️ Un seul SENS a été observé : l'agent de Meta qui nous rend la main sur demande du client. Nos propres
 * `release` ne produisent AUCUN événement de ce type (vérifié : deux `release` déclenchés, zéro événement).
 * On ne reconnaît donc que ce sens-là, et tout le reste reste journalisé sans être interprété.
 */

export interface HandoverDeps {
  /** Tenant propriétaire du numéro business. null si inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /** Pose le détenteur du fil (sans condition : Meta fait autorité sur qui détient quoi). */
  setControlOwner(tenantId: string, waId: string, owner: ControlOwner): Promise<boolean>;
  /**
   * L'agent de Meta vient de passer la main à l'ÉQUIPE (`PgInboxStore.marquerEscalade`, migration 0164) : le fil
   * devient le nôtre ET la conversation entre dans « À traiter » tout de suite. Requise : sans elle, la
   * passation ne posait que le détenteur, et la conversation n'apparaissait qu'au message suivant du client.
   */
  marquerEscalade(tenantId: string, waId: string): Promise<void>;
  /** Journalise dans le fil un message envoyé par l'agent de Meta, pour que l'opérateur le voie. */
  recordAgentMessage?(tenantId: string, waId: string, body: string, messageId: string | null): Promise<void>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Trace structurée : c'est elle qu'on lira pendant le premier test MBA. */
function trace(msg: string, extra: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ lvl: 'info', msg, ...extra }));
}

/**
 * À qui Meta dit-il que le fil appartient désormais ?
 *
 * 🔴 CETTE FONCTION DEVINAIT, ET ELLE DEVINAIT À L'ENVERS. Elle cherchait `take_thread_control` /
 * `pass_thread_control`, absents du vrai payload, puis retombait sur « le texte contient `business_agent`,
 * donc l'agent de Meta détient ». Or ce mot n'apparaît que dans `previous_owner_app_role` : il nomme le
 * détenteur PRÉCÉDENT. Sur la seule bascule que Meta envoie réellement, elle concluait donc exactement
 * l'inverse de la vérité.
 *
 * Elle ne reconnaît plus que ce qui a été MESURÉ, et rend `null` sur tout le reste, ce qui déclenche la
 * journalisation du payload complet plutôt qu'une supposition.
 */
export function ownerFromHandover(value: Record<string, unknown>): ControlOwner | null {
  // Forme RÉELLE (mesurée) : `{type: 'control_passed', control_passed: {previous_owner_app_role, metadata}}`.
  // Le nom du champ dit qui détenait AVANT, jamais qui détient maintenant : le nouveau détenteur, c'est
  // celui qui REÇOIT le webhook, donc nous.
  if (str(value['type']) !== 'control_passed') return null;
  const passe = asRecord(value['control_passed']);
  const precedent = str(passe['previous_owner_app_role']);
  /**
   * On ne reconnaît QUE ce qu'on a vu : l'agent de Meta nous rend la main. Une autre app qui passerait le fil
   * à l'agent produirait le même `type` avec un rôle différent, et le nouveau détenteur ne serait alors PAS
   * nous ; rien dans le payload ne permet de trancher, donc on rend `null` et on journalise tout.
   *
   * 🔴 `app_human`, ET NON `app_workflow` (corrigé le 2026-09-15). Les deux valeurs veulent dire « nous »,
   * mais pas le même nous : `app_workflow` veut dire « un SCÉNARIO gère ce fil », et c'est la SEULE valeur
   * que le dossier « À traiter » exclut. Or ce webhook-ci arrive précisément quand l'agent de Meta vient de
   * dire au client « un membre de l'équipe va vous répondre » : écrire `app_workflow` rangeait donc la
   * conversation hors de la liste de travail à l'instant exact où quelqu'un attend une réponse humaine.
   *
   * ⚠️ Et ça n'empêche aucun scénario : `reprendreLeFilPourLApp` pose `app_workflow` SANS condition quand un
   * parcours démarre.
   */
  if (precedent === 'meta_business_agent') return 'app_human';
  return null;
}

/**
 * Le numéro BUSINESS concerné, quel que soit le champ.
 *
 * 🔴 LES DEUX FORMES NE LE RANGENT PAS AU MÊME ENDROIT, et c'est le troisième écart de ce module. Un
 * `standby` le met dans `metadata.phone_number_id` ; un `messaging_handovers` n'a **aucun** `metadata` et le
 * met dans `recipient.phone_number_id`. Le module ne lisait que le premier : sur une vraie bascule de
 * contrôle il sortait donc en `handover_sans_numero` avant même d'avoir regardé le reste, et les deux
 * correctifs ci-dessus n'auraient rien changé.
 */
export function numeroBusinessDuChange(value: Record<string, unknown>): string | undefined {
  return str(asRecord(value['metadata'])['phone_number_id'])
    ?? str(asRecord(value['recipient'])['phone_number_id']);
}

/** Le numéro du CLIENT concerné par la bascule. Mesuré : il vit dans `sender.phone_number`. */
export function waIdFromHandover(value: Record<string, unknown>): string | undefined {
  // ⚠️ `recipient` est un OBJET qui décrit le numéro BUSINESS (`phone_number_id`, `display_phone_number`),
  // pas le client. Le lire comme une chaîne rendait `undefined`, et la garde `if (waId && owner)` du bas de
  // ce fichier ne passait donc JAMAIS : le module tournait sans jamais rien écrire.
  return str(asRecord(value['sender'])['phone_number'])
    ?? str(value['to'])
    ?? str(value['wa_id']);
}

/**
 * Traite les événements `messaging_handovers` et `standby` d'un payload webhook.
 *
 * ISOLÉ par l'appelant : une erreur ici ne doit jamais faire échouer le job webhook partagé avec les
 * statuts de livraison et l'inbox.
 */
export async function processHandovers(payload: unknown, deps: HandoverDeps): Promise<void> {
  for (const entryRaw of asArray(asRecord(payload)['entry'])) {
    for (const changeRaw of asArray(asRecord(entryRaw)['changes'])) {
      const change = asRecord(changeRaw);
      const field = str(change['field']);
      if (field !== 'messaging_handovers' && field !== 'standby') continue;

      // 🔴 `valeurEffective`, JAMAIS `asRecord` directement : voir `./change.ts`. Ce module lisait
      // `value.message_echoes` sur une forme DEVINÉE ; la vraie imbrique tout sous `value.standby`.
      const value = valeurEffective(change['value']);
      const phoneNumberId = numeroBusinessDuChange(value);
      if (!phoneNumberId) {
        trace('handover_sans_numero', { field, value });
        continue;
      }
      const tenantId = await deps.phoneNumberTenant(phoneNumberId);
      if (!tenantId) {
        trace('handover_numero_inconnu', { field, phoneNumberId });
        continue;
      }

      if (field === 'messaging_handovers') {
        const waId = waIdFromHandover(value);
        const owner = ownerFromHandover(value);
        // On journalise TOUJOURS, reconnu ou non : c'est cette trace qui a livré la vraie forme le
        // 2026-09-10 au soir, et c'est elle qui livrera le SENS INVERSE (une app qui rend le fil à l'agent),
        // que Meta n'a encore jamais envoyé et qu'on refuse donc d'interpréter.
        trace('handover_recu', { tenantId, phoneNumberId, waId: waId ?? null, owner, value });
        // `app_human` = l'agent de Meta nous passe la main (seul sens reconnu) : c'est une ESCALADE vers l'équipe.
        if (waId && owner === 'app_human') await deps.marquerEscalade(tenantId, waId);
        // ⚠️ L'AUTRE SENS N'EXISTE PAS ENCORE : `ownerFromHandover` ne rend que `app_human` ou `null`, donc cette
        // branche est inatteignable tant que Meta n'enverra pas une passation VERS l'agent. Ce qui lève une
        // escalade, aujourd'hui, est un `standby` postérieur (`messageEnvoyeLe`, `accorderLeDetenteur`).
        else if (waId && owner) await deps.setControlOwner(tenantId, waId, owner);
        continue;
      }

      // Les `message_echoes` : les messages que l'agent de Meta a envoyés en notre nom. Les afficher dans
      // l'inbox est ce qui permet à un opérateur de voir la conversation ENTIÈRE, et pas seulement sa
      // moitié. Sans ça, il reprendrait la main sans savoir ce que l'agent vient de dire.
      //
      // 🔴 `standby` NE VEUT PAS DIRE « écho », et c'est la confusion qui a coûté deux jours. Sur les 58
      // payloads du 2026-09-10, `field: 'standby'` portait TROIS contenus distincts : des `message_echoes`
      // (3), mais aussi de vrais messages ENTRANTS (3) et des `statuses` (11). Les deux derniers ne se
      // traitent pas ici : ils passent par `extractInbound` et `parseWebhook`, qui voient enfin le standby
      // grâce à `valeurEffective`. Ce module ne prend que les échos, et il ne doit pas devenir la seule
      // porte du standby.
      for (const echoRaw of asArray(value['message_echoes'])) {
        const echo = asRecord(echoRaw);
        /**
         * 🔴 LE CORPS EST SOUS `message`, ET L'ÉCHO NE PORTE À PLAT QUE `id` ET `timestamp`. Mesuré le
         * 2026-09-10 sur un écho réel :
         * `{id, timestamp, message: {to, type, text: {body}, recipient, biz_opaque_callback_data}}`.
         * Le code lisait `echo.text.body` et `echo.to` : les deux rendaient `undefined`, donc la garde
         * `if (waId && body)` ne passait jamais et l'agent de Meta restait invisible dans l'Inbox.
         *
         * ⚠️ `message.recipient` est le BSUID (`FR.9418...`), PAS le numéro : c'est `message.to` qui porte
         * le `wa_id`. Les intervertir rattacherait le message à un contact qui n'existe pas.
         *
         * Les formes à plat restent lues en second : elles ne coûtent rien et couvrent une variante de Meta.
         */
        const contenu = asRecord(echo['message']);
        const waId = str(contenu['to']) ?? str(echo['to']) ?? str(echo['recipient']) ?? str(value['recipient']);
        const body = str(asRecord(contenu['text'])['body']) ?? str(asRecord(echo['text'])['body']) ?? str(echo['body']);
        const messageId = str(echo['id']) ?? str(contenu['id']) ?? null;
        trace('standby_echo', { tenantId, waId: waId ?? null, messageId, aUnCorps: body !== undefined });
        if (waId && body && deps.recordAgentMessage) {
          await deps.recordAgentMessage(tenantId, waId, body, messageId);
        }
      }
    }
  }
}
