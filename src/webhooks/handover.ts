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
 * trace qui a permis de trouver les deux écarts ci-dessus. En revanche, une trace ne suffit pas : personne
 * ne la lit tant que rien ne va mal, et c'est pourquoi le contrat est désormais tenu par des TESTS sur les
 * payloads réels (`tests/webhooks-change.test.ts`).
 */

export interface HandoverDeps {
  /** Tenant propriétaire du numéro business. null si inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /** Pose le détenteur du fil (sans condition : Meta fait autorité sur qui détient quoi). */
  setControlOwner(tenantId: string, waId: string, owner: ControlOwner): Promise<boolean>;
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
 * Le vocabulaire du protocole de handover vient de Messenger, où l'app cible est désignée par un
 * identifiant. On reconnaît donc les deux formulations plausibles sans en privilégier une : un champ qui
 * nomme explicitement l'agent, ou une paire prise/rendue. Tout le reste rend `null`, ce qui déclenche la
 * journalisation du payload complet plutôt qu'une supposition.
 */
export function ownerFromHandover(value: Record<string, unknown>): ControlOwner | null {
  const brut = JSON.stringify(value).toLowerCase();
  // La PRÉSENCE de la clé suffit : sa valeur (objet, chaîne, vide) varie selon la formulation de Meta, et
  // c'est justement ce qu'on ne veut pas présumer avant le premier payload réel.
  const prise = 'take_thread_control' in value;
  const rendue = 'pass_thread_control' in value;
  // Un contrôle PRIS par l'app (nous) : le fil revient à notre automate. Un contrôle RENDU (release) le
  // donne à l'agent de Meta, qui redevient le répondeur principal.
  if (prise && !rendue) return 'app_workflow';
  if (rendue && !prise) return 'mba';
  // Repli sur une mention explicite de l'agent, si Meta nomme le nouveau détenteur autrement.
  if (brut.includes('business_agent') || brut.includes('meta_agent')) return 'mba';
  return null;
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
      const phoneNumberId = str(asRecord(value['metadata'])['phone_number_id']);
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
        // Le destinataire concerné : Meta le nomme `recipient`, `to` ou `wa_id` selon les surfaces.
        const waId = str(value['recipient']) ?? str(value['to']) ?? str(value['wa_id']);
        const owner = ownerFromHandover(value);
        // On journalise TOUJOURS, reconnu ou non. ⚠️ Contrairement à `standby`, `messaging_handovers` n'a
        // TOUJOURS PAS été observé en production (zéro occurrence sur les 58 payloads du 2026-09-10) : sa
        // forme reste devinée, et cette trace est encore le seul moyen de la découvrir.
        trace('handover_recu', { tenantId, phoneNumberId, waId: waId ?? null, owner, value });
        if (waId && owner) await deps.setControlOwner(tenantId, waId, owner);
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
