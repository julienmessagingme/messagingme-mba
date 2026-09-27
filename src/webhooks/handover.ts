import type { ControlOwner } from '../inbox/store.pg';
import { asArray, asRecord, texteNonVide } from './json';
import { valeurEffective } from './change';
import { journaliser } from '../lib/journal';
import type { EspaceDuNumero } from './rattachement';

/**
 * Changements de contrôle du fil annoncés par Meta (`messaging_handovers`), et messages que l'agent de Meta a
 * envoyés en notre nom (`standby`). Formes mesurées sur des payloads réels, tenues par des tests
 * (`tests/webhooks-change.test.ts`, `tests/handover-reel.test.ts`) :
 *  - tout est imbriqué sous `value.standby` (`contacts`, `messages`, `statuses`, `message_echoes`), `metadata`
 *    restant au premier niveau : d'où `valeurEffective` (`./change.ts`) ;
 *  - un écho porte son contenu sous `message` : `{id, timestamp, message: {to, text: {body}, ...}}` ;
 *  - `messaging_handovers` ne se déclenche que si `handoff` est configuré chez Meta. Il dit
 *    `{type: 'control_passed', control_passed: {previous_owner_app_role: 'meta_business_agent', metadata}}`, et
 *    `recipient` y décrit le numéro business, le client étant dans `sender.phone_number`.
 * Un seul sens est observé (l'agent de Meta nous rend la main) ; nos `release` ne produisent aucun événement.
 * Tout le reste est journalisé intégralement, jamais interprété.
 */

export interface HandoverDeps {
  /** Pose le détenteur du fil (sans condition : Meta fait autorité sur qui détient quoi). */
  setControlOwner(tenantId: string, waId: string, owner: ControlOwner): Promise<boolean>;
  /**
   * L'agent de Meta vient de passer la main à l'équipe (`PgInboxStore.marquerEscalade`) : le fil devient le nôtre
   * et la conversation entre tout de suite dans « À traiter », sans attendre le message suivant du client.
   */
  marquerEscalade(tenantId: string, waId: string): Promise<void>;
  /** Journalise dans le fil un message envoyé par l'agent de Meta, pour que l'opérateur le voie. */
  recordAgentMessage?(tenantId: string, waId: string, body: string, messageId: string | null): Promise<void>;
}



/**
 * À qui Meta dit-il que le fil appartient désormais ? Ne reconnaît que la forme mesurée, et rend `null` sur tout
 * le reste, ce qui fait journaliser le payload plutôt que de supposer. `previous_owner_app_role` nomme le
 * détenteur précédent, jamais le nouveau.
 */
export function ownerFromHandover(value: Record<string, unknown>): ControlOwner | null {
  // Forme mesurée : `{type: 'control_passed', control_passed: {previous_owner_app_role, metadata}}`. Le nouveau
  // détenteur est celui qui reçoit le webhook, donc nous.
  if (texteNonVide(value['type']) !== 'control_passed') return null;
  const passe = asRecord(value['control_passed']);
  const precedent = texteNonVide(passe['previous_owner_app_role']);
  /**
   * On ne reconnaît que l'agent de Meta qui nous rend la main : une autre app passant le fil à l'agent produirait
   * le même `type`, sans que le payload permette de trancher, d'où `null`. `app_human` et non `app_workflow` : ce
   * webhook arrive quand l'agent vient d'annoncer « un membre de l'équipe va vous répondre », et `app_workflow`
   * est la seule valeur que « À traiter » exclut. Aucun scénario n'est empêché : un parcours qui démarre pose
   * `app_workflow`.
   */
  if (precedent === 'meta_business_agent') return 'app_human';
  return null;
}

/**
 * Le numéro business concerné, quel que soit le champ : un `standby` le met dans `metadata.phone_number_id`, un
 * `messaging_handovers` (sans `metadata`) dans `recipient.phone_number_id`.
 */
export function numeroBusinessDuChange(value: Record<string, unknown>): string | undefined {
  return texteNonVide(asRecord(value['metadata'])['phone_number_id'])
    ?? texteNonVide(asRecord(value['recipient'])['phone_number_id']);
}

/** Le numéro du client concerné par la bascule, dans `sender.phone_number`. */
export function waIdFromHandover(value: Record<string, unknown>): string | undefined {
  // `recipient` est un objet qui décrit le numéro business, pas le client.
  return texteNonVide(asRecord(value['sender'])['phone_number'])
    ?? texteNonVide(value['to'])
    ?? texteNonVide(value['wa_id']);
}

/**
 * Un `messaging_handovers` ou un `standby` du payload, avec le numéro business qu'il nomme et l'espace de ce
 * numéro. Cette étape garde sa propre lecture du payload : ce qu'elle traite (passage de main, échos de l'agent de
 * Meta) n'est pas un message entrant.
 */
export interface Bascule {
  field: 'messaging_handovers' | 'standby';
  /** La valeur du change, par `valeurEffective`. */
  value: Record<string, unknown>;
  /** Absent : aucun numéro lisible, rien d'attribuable. */
  phoneNumberId: string | undefined;
  /** `null` : numéro absent ou inconnu. */
  tenantId: string | null;
}

/**
 * Les bascules d'un payload, dans l'ordre, rattachées à leur espace par `espaceDe` (la lecture unique du job, qui
 * ne relit pas un numéro déjà lu pour les entrants). Une lecture en échec lève, et l'appelant isole l'étape.
 */
export async function lireLesBascules(payload: unknown, espaceDe: EspaceDuNumero): Promise<Bascule[]> {
  const bascules: Bascule[] = [];
  for (const entryRaw of asArray(asRecord(payload)['entry'])) {
    for (const changeRaw of asArray(asRecord(entryRaw)['changes'])) {
      const change = asRecord(changeRaw);
      const field = texteNonVide(change['field']);
      if (field !== 'messaging_handovers' && field !== 'standby') continue;
      // `valeurEffective`, jamais `asRecord` directement : voir `./change.ts`.
      const value = valeurEffective(change['value']);
      const phoneNumberId = numeroBusinessDuChange(value);
      bascules.push({ field, value, phoneNumberId, tenantId: phoneNumberId ? await espaceDe(phoneNumberId) : null });
    }
  }
  return bascules;
}

/**
 * Traite les bascules d'un payload, déjà rattachées (`lireLesBascules`). Isolé par l'appelant : une erreur ici ne
 * doit jamais faire échouer le job webhook partagé.
 */
export async function processHandovers(bascules: readonly Bascule[], deps: HandoverDeps): Promise<void> {
  for (const { field, value, phoneNumberId, tenantId } of bascules) {
    if (!phoneNumberId) {
      journaliser('info', 'handover_sans_numero', { field, value });
      continue;
    }
    if (!tenantId) {
      journaliser('info', 'handover_numero_inconnu', { field, phoneNumberId });
      continue;
    }

    if (field === 'messaging_handovers') {
      const waId = waIdFromHandover(value);
      const owner = ownerFromHandover(value);
      // Journalisé toujours, reconnu ou non : c'est cette trace qui livrera le sens inverse (une app qui rend le fil
      // à l'agent), que Meta n'a jamais envoyé et qu'on refuse donc d'interpréter.
      journaliser('info', 'handover_recu', { tenantId, phoneNumberId, waId: waId ?? null, owner, value });
      // `app_human` = l'agent de Meta nous passe la main (seul sens reconnu) : une escalade vers l'équipe.
      if (waId && owner === 'app_human') await deps.marquerEscalade(tenantId, waId);
      // L'autre sens n'existe pas encore (`ownerFromHandover` ne rend que `app_human` ou `null`) : branche
      // inatteignable. Une escalade se lève aujourd'hui par un `standby` postérieur (`messageEnvoyeLe`,
      // `accorderLeDetenteur`).
      else if (waId && owner) await deps.setControlOwner(tenantId, waId, owner);
      continue;
    }

    // Les `message_echoes` : les messages que l'agent de Meta a envoyés en notre nom, affichés dans l'inbox pour que
    // l'opérateur voie la conversation entière avant de reprendre la main. `standby` ne veut pas dire « écho » : il
    // porte aussi des entrants et des `statuses`, traités par `extractInbound` et `parseWebhook` via
    // `valeurEffective`. Ce module ne prend que les échos.
    for (const echoRaw of asArray(value['message_echoes'])) {
      const echo = asRecord(echoRaw);
      /**
       * Le corps est sous `message` ; l'écho ne porte à plat que `id` et `timestamp` :
       * `{id, timestamp, message: {to, type, text: {body}, recipient, biz_opaque_callback_data}}`.
       * `message.recipient` est le BSUID, pas le numéro : c'est `message.to` qui porte le `wa_id`. Les formes à plat
       * restent lues en second.
       */
      const contenu = asRecord(echo['message']);
      const waId = texteNonVide(contenu['to']) ?? texteNonVide(echo['to']) ?? texteNonVide(echo['recipient']) ?? texteNonVide(value['recipient']);
      const body = texteNonVide(asRecord(contenu['text'])['body']) ?? texteNonVide(asRecord(echo['text'])['body']) ?? texteNonVide(echo['body']);
      const messageId = texteNonVide(echo['id']) ?? texteNonVide(contenu['id']) ?? null;
      journaliser('info', 'standby_echo', { tenantId, waId: waId ?? null, messageId, aUnCorps: body !== undefined });
      if (waId && body && deps.recordAgentMessage) {
        await deps.recordAgentMessage(tenantId, waId, body, messageId);
      }
    }
  }
}
