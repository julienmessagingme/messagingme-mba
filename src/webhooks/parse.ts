import { createHash } from 'node:crypto';
import { asArray, asRecord, texteNonVide } from './json';
import { numeroBusinessDuChange, valeurEffective } from './change';

export type WebhookSource =
  | 'messages'
  | 'statuses'
  | 'messaging_handovers'
  | 'standby'
  // Le statut d'un modèle tranché par Meta (lot 13, domaine 3, livraison C) : au niveau du COMPTE, sans numéro.
  | 'template_status';

export interface WebhookEvent {
  source: WebhookSource;
  /** Clé d'idempotence : un même événement redélivré produit la même clé. */
  dedupKey: string;
  /** L'objet événement brut (message, statut, echo, handover). */
  data: unknown;
  /**
   * Numéro Meta destinataire de l'événement (`value.metadata.phone_number_id`, ou `value.recipient.phone_number_id`
   * pour une bascule de contrôle), celui de SON `change` quand un payload en nomme plusieurs. Le seul
   * rattachement à un espace d'un payload Meta. Stocké avec l'événement, sans quoi une ligne de `webhook_events`
   * ne serait attribuable à personne, donc jamais effaçable sur demande.
   */
  phoneNumberId?: string;
}

/** Sérialisation canonique (clés triées) -> hash insensible à l'ordre des clés. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}

function hash(source: WebhookSource, data: unknown): string {
  const h = createHash('sha256').update(stableStringify(data)).digest('hex').slice(0, 32);
  return `${source}:${h}`;
}

/**
 * Ce payload ne contient-il que des accusés de livraison (`statuses`) ? Sert à le router vers la file des
 * accusés plutôt que celle des entrants, pour qu'une rafale de campagne ne passe pas devant la réponse d'un
 * client. Test strict : au moins un `statuses`, et rien d'autre. Un payload mixte part sur la file des entrants,
 * qui traite aussi les accusés : on ne perd rien, on renonce seulement à l'optimisation.
 */
export function nAQueDesAccuses(payload: unknown): boolean {
  const root = asRecord(payload);
  const entries = asArray(root['entry']);
  if (entries.length === 0) return false;
  let accuses = 0;
  for (const entryRaw of entries) {
    for (const changeRaw of asArray(asRecord(entryRaw)['changes'])) {
      const change = asRecord(changeRaw);
      // `valeurEffective`, jamais `asRecord` directement : voir `./change.ts`.
      const value = valeurEffective(change['value']);
      // Tout ce qui n'est pas un accusé disqualifie le payload : messages, échos, et le champ de handover, dont la
      // valeur ne porte aucune des clés ci-dessous.
      if (asArray(value['messages']).length > 0) return false;
      if (asArray(value['message_echoes']).length > 0) return false;
      if (change['field'] === 'messaging_handovers') return false;
      // Le statut d'un modèle (lot 13, domaine 3, C) : la file des accusés n'a pas son étape, il se perdrait.
      if (change['field'] === 'message_template_status_update') return false;
      accuses += asArray(value['statuses']).length;
    }
  }
  return accuses > 0;
}

/**
 * La clé de groupe d'un payload : `<phone_number_id>:<wa_id>`, ou `undefined` s'il n'en a pas exactement une.
 * La file des entrants est concurrente : pg-boss ne garde qu'un job en vol par groupe, ce qui préserve l'ordre
 * des messages d'un même contact (le verrou d'avance protège l'état du run, pas l'ordre des effets). Un numéro
 * appartient à un seul espace, donc la clé cloisonne les espaces sans lecture en base. `undefined` (plusieurs
 * contacts, `wa_id` absent, bascule de contrôle) = pas de groupe : dans le doute, on renonce à l'optimisation.
 */
export function cleDeContact(payload: unknown): string | undefined {
  const cles = new Set<string>();
  let inattribuable = false;

  for (const entryRaw of asArray(asRecord(payload)['entry'])) {
    for (const changeRaw of asArray(asRecord(entryRaw)['changes'])) {
      const change = asRecord(changeRaw);
      // `valeurEffective`, jamais `asRecord` directement : voir `./change.ts`.
      const value = valeurEffective(change['value']);
      const pnId = texteNonVide(asRecord(value['metadata'])['phone_number_id']);
      if (pnId === undefined) { inattribuable = true; continue; }
      // La forme des bascules de contrôle n'est pas documentée : on ne devine pas de qui elles parlent.
      if (change['field'] === 'messaging_handovers') { inattribuable = true; continue; }

      const secours = texteNonVide(asRecord(asArray(value['contacts'])[0])['wa_id']);
      const ajouter = (waId: string | undefined): void => {
        if (waId === undefined) inattribuable = true;
        else cles.add(`${pnId}:${waId}`);
      };
      // Même règle d'identité que `extractInbound` : `from`, sinon le `wa_id` du bloc `contacts`.
      for (const m of asArray(value['messages'])) ajouter(texteNonVide(asRecord(m)['from']) ?? secours);
      for (const s of asArray(value['statuses'])) ajouter(texteNonVide(asRecord(s)['recipient_id']) ?? secours);
      // Écho d'un message sortant : le contact est le destinataire.
      for (const e of asArray(value['message_echoes'])) ajouter(texteNonVide(asRecord(e)['to']) ?? secours);
    }
  }

  return inattribuable || cles.size !== 1 ? undefined : [...cles][0];
}


/**
 * Normalise un payload de webhook Meta (entry[].changes[].value) en une liste d'événements portant chacun une clé
 * d'idempotence. Ne suppose jamais la présence de `from` ou `wa_id` (masqués pour un utilisateur à username) :
 * l'idempotence vient de l'`id` du message ou du statut, sinon d'un hash stable du contenu.
 */
export function parseWebhook(payload: unknown): WebhookEvent[] {
  const events: WebhookEvent[] = [];
  const root = asRecord(payload);

  for (const entryRaw of asArray(root['entry'])) {
    const entry = asRecord(entryRaw);
    for (const changeRaw of asArray(entry['changes'])) {
      const change = asRecord(changeRaw);
      const field = typeof change['field'] === 'string' ? (change['field'] as string) : '';
      // `valeurEffective`, jamais `asRecord` directement : voir `./change.ts`.
      const value = valeurEffective(change['value']);
      // Lu une fois par `change` : tous les événements qu'il porte visent le même numéro. `numeroBusinessDuChange`,
      // parce qu'une bascule de contrôle n'a pas de `metadata` et nomme son numéro dans `recipient`.
      const pnId = numeroBusinessDuChange(value);
      const meta = pnId !== undefined ? { phoneNumberId: pnId } : {};

      // Messages entrants.
      for (const msgRaw of asArray(value['messages'])) {
        const msg = asRecord(msgRaw);
        const id = typeof msg['id'] === 'string' ? (msg['id'] as string) : undefined;
        events.push({
          source: 'messages',
          dedupKey: id ? `msg:${id}` : hash('messages', msg),
          data: msg,
          ...meta,
        });
      }

      // Statuts de livraison (un même id reçoit sent/delivered/read -> clés distinctes).
      for (const stRaw of asArray(value['statuses'])) {
        const st = asRecord(stRaw);
        const id = typeof st['id'] === 'string' ? (st['id'] as string) : undefined;
        const status = typeof st['status'] === 'string' ? (st['status'] as string) : undefined;
        // Si id et status sont présents -> clé sémantique ; sinon hash canonique (deux statuts réellement différents
        // sans champ `status` ne se confondent pas).
        events.push({
          source: 'statuses',
          dedupKey: id && status ? `status:${id}:${status}` : hash('statuses', st),
          data: st,
          ...meta,
        });
      }

      // Standby : echoes des messages envoyés depuis l'app (coexistence / MBA a le contrôle).
      for (const echoRaw of asArray(value['message_echoes'])) {
        const echo = asRecord(echoRaw);
        const id = typeof echo['id'] === 'string' ? (echo['id'] as string) : undefined;
        events.push({
          source: 'standby',
          dedupKey: id ? `standby:${id}` : hash('standby', echo),
          data: echo,
          ...meta,
        });
      }

      // Le statut d'un modèle (lot 13, domaine 3, livraison C) : il ne nomme que le compte (`entry.id`). La clé porte le
      // modèle, le statut et l'instant de Meta : une redélivrance garde la même, un retour au même statut plus tard non.
      if (field === 'message_template_status_update') {
        const modele = value['message_template_id'];
        const statut = texteNonVide(value['event']);
        const instant = typeof entry['time'] === 'number' ? entry['time'] : undefined;
        const idModele = typeof modele === 'number' || typeof modele === 'string' ? String(modele) : undefined;
        events.push({
          source: 'template_status',
          dedupKey: idModele !== undefined && statut !== undefined && instant !== undefined
            ? `tpl:${idModele}:${statut}:${instant}`
            : hash('template_status', { ...value, compte: entry['id'] }),
          data: { ...value, waba_id: entry['id'], ...(instant !== undefined ? { le: instant } : {}) },
        });
      }

      // Changements de contrôle du fil (forme peu documentée) : clé par hash canonique du contenu, idempotente sur
      // redélivrance identique et insensible à l'ordre des clés.
      if (field === 'messaging_handovers') {
        events.push({
          source: 'messaging_handovers',
          dedupKey: hash('messaging_handovers', value),
          data: value,
          ...meta,
        });
      }
    }
  }

  return events;
}
