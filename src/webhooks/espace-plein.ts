import { estDemandeArret } from '../crm/consentement';
import { journaliser } from '../lib/journal';
import { asArray, asRecord } from './json';
import { extractInbound, type InboundContactUpsert, type InboundMessage, type InboundOptOut } from './inbound';
import { rattacherLesEntrants, type EntrantRattache, type EspaceDuNumero } from './rattachement';

/**
 * 🔴 LA PORTE D'UNE FREE PLEINE (décision de Julien du 2026-10-25, plan `docs/superpowers/plans/2026-10-25-free-100-contacts.md`).
 * Une Free ne gère jamais plus de contacts différents que sa limite, quelle que soit leur origine
 * (`contactsToutesOrigines`, `src/offres/offres.ts`). Quand ses fiches actives la remplissent, le message d'un inconnu
 * (aucune fiche active ne porte son `wa_id`) n'entre pas : ni fiche, ni conversation, ni message, ni journal brut, ni avance
 * de scénario, ni agent IA, ni automation. Il est retiré AVANT, comme l'entrant d'un numéro délié (`./numeros-delies.ts`),
 * et journalisé sans le numéro de qui écrit. Les administrateurs sont prévenus, au plus une fois par jour et par espace
 * (`espace_plein_entrant`, `creerAlerteEspacePlein`).
 *
 * 🔴 SAUF SON STOP : un inconnu qui écrit STOP à une Free pleine naît en STOP (les deux écritures de `processInbound`), même
 * au-delà de la limite, et rien d'autre (ni conversation, ni message). Sinon, importé plus tard (consentant par principe),
 * il recevrait des messages après avoir dit STOP. Une fiche en STOP ne reçoit rien, et elle ne libère aucune place. Un
 * STOP qui ne s'écrit pas n'est pas écarté : le chemin commun le refait, et garde son message. Un STOP seul ne prévient
 * pas les administrateurs : l'alerte parle d'un client qui n'est pas entré.
 *
 * Le Pro et l'Entreprise ne sont jamais refusés (`PgContactStore.inconnusRefuses` ne lit même rien pour eux). Ne lève
 * jamais : une lecture en échec laisse tout entrer, puisqu'une limite commerciale ne coupe jamais la réception. Deux
 * portes l'appellent : la réception de Meta et de 360dialog (`handleWebhookJob`, sur la même file) et la filière
 * application (`traiterEntrantApplication`).
 */

/**
 * Ce que la porte lit, et qui elle prévient. Requise partout où l'on enregistre des entrants (`WebhookJobDeps`,
 * `DepsEntrantApplication`) : optionnelle, un câblage qui l'oublierait laisserait la Free sans plafond, sans que rien ne
 * le montre. Les tests qui n'en parlent pas le disent avec `aucunEspacePlein` (`tests/webhook-fixtures.ts`).
 */
export interface EspacesPleins {
  /**
   * Parmi ces `wa_id` qui écrivent à l'espace, ceux qui n'y entrent pas, et la limite qui les refuse
   * (`PgContactStore.inconnusRefuses`) ; `null` quand aucun ne l'est (hors Free, sans limite, sous la limite, tous connus).
   */
  refuses(tenantId: string, waIds: readonly string[]): Promise<{ waIds: ReadonlySet<string>; limite: number } | null>;
  /** Prévient les administrateurs, au plus une fois par jour et par espace (`creerAlerteEspacePlein`). */
  prevenir(tenantId: string, limite: number): Promise<void>;
}

/** Les deux écritures du STOP de `processInbound` : la fiche, puis son refus. Les mêmes dépendances que lui. */
export interface EcrituresDuStop {
  upsertContact?: InboundContactUpsert;
  optOut: InboundOptOut;
}

/**
 * Les messages que la porte écarte, parmi ces entrants déjà rattachés à leur espace : leurs identifiants. Une lecture par
 * espace pour le lot ; le STOP d'un inconnu écarté est retenu au passage ; chaque écart est journalisé, et l'espace prévenu
 * une fois. Un entrant sans espace (numéro inconnu) n'est pas lu : chaque étape garde sa réponse à ce cas.
 */
export async function messagesEcartes(
  entrants: readonly EntrantRattache[],
  deps: EspacesPleins,
  stop: EcrituresDuStop,
): Promise<ReadonlySet<string>> {
  const parEspace = new Map<string, InboundMessage[]>();
  for (const { message, tenantId } of entrants) {
    if (tenantId === null) continue;
    parEspace.set(tenantId, [...(parEspace.get(tenantId) ?? []), message]);
  }
  const ecartes = new Set<string>();
  for (const [tenantId, messages] of parEspace) {
    let refus: Awaited<ReturnType<EspacesPleins['refuses']>>;
    try {
      refus = await deps.refuses(tenantId, messages.map((m) => m.waId));
    } catch (err) {
      journaliser('warn', 'espace_plein_illisible', { tenantId, err });
      continue;
    }
    if (refus === null) continue;
    // L'alerte dit qu'un nouveau client n'est pas entré : un STOP retenu n'en est pas un (sa fiche existe).
    let unClientEcarte = false;
    for (const m of messages) {
      if (!refus.waIds.has(m.waId)) continue;
      // Le mot-clé des messages texte seulement, comme `processInbound` : un bouton porte son libellé dans `body`.
      const estStop = m.type === 'text' && estDemandeArret(m.body);
      // 🔴 Un STOP qui ne s'écrit pas n'est PAS écarté (relecture du lot) : il passe par le chemin commun, qui refait sa
      // fiche et son refus et garde son message. Écarté, il serait perdu sans trace, et un import le croirait consentant.
      if (estStop && !(await retenirLeStop(tenantId, m, stop))) continue;
      ecartes.add(m.messageId);
      if (!estStop) unClientEcarte = true;
      journaliser('info', 'entrant_ecarte_espace_plein', {
        tenantId, ...(m.phoneNumberId ? { phoneNumberId: m.phoneNumberId } : {}), messageId: m.messageId, stop: estStop,
      });
    }
    if (!unClientEcarte) continue;
    try {
      await deps.prevenir(tenantId, refus.limite);
    } catch (err) {
      journaliser('error', 'espace_plein_alerte_impossible', { tenantId, err });
    }
  }
  return ecartes;
}

/**
 * La fiche de l'inconnu, puis son STOP : vrai quand le refus est écrit. Ce qui échoue est journalisé, et rend faux : la
 * porte ne lève jamais, elle laisse alors le message au chemin commun.
 */
async function retenirLeStop(tenantId: string, m: InboundMessage, stop: EcrituresDuStop): Promise<boolean> {
  try {
    if (stop.upsertContact) await stop.upsertContact(tenantId, m);
    if (await stop.optOut(tenantId, m.waId, m.messageId)) return true;
    journaliser('warn', 'stop_espace_plein_sans_fiche', { tenantId, messageId: m.messageId });
  } catch (err) {
    journaliser('error', 'stop_espace_plein_impossible', { tenantId, messageId: m.messageId, err });
  }
  return false;
}

/**
 * Le payload sans ces messages (par leur `id`), retirés là où Meta les a posés : sous `value.messages`, ou sous
 * `value.standby` quand l'agent de Meta tient le fil (`valeurEffective`, `./change.ts`). Le reste de chaque change reste
 * (accusés, échos, contacts). Fonction pure : le payload reçu n'est pas modifié, et il est rendu tel quel quand rien n'est
 * à retirer.
 */
export function sansCesMessages(payload: unknown, ids: ReadonlySet<string>): unknown {
  if (ids.size === 0) return payload;
  let retire = false;
  const racine = asRecord(payload);
  const entry = asArray(racine['entry']).map((entryRaw) => {
    const e = asRecord(entryRaw);
    const changes = asArray(e['changes']).map((changeRaw) => {
      const change = asRecord(changeRaw);
      const value = asRecord(change['value']);
      const standby = asRecord(value['standby']);
      const sousStandby = Object.hasOwn(standby, 'messages');
      const porteur = sousStandby ? standby : value;
      const avant = asArray(porteur['messages']);
      const apres = avant.filter((m) => {
        const id = asRecord(m)['id'];
        return !(typeof id === 'string' && ids.has(id));
      });
      if (apres.length === avant.length) return changeRaw;
      retire = true;
      const neuf = { ...porteur, messages: apres };
      return { ...change, value: sousStandby ? { ...value, standby: neuf } : neuf };
    });
    return { ...e, changes };
  });
  return retire ? { ...racine, entry } : payload;
}

/**
 * L'étape du job `webhook`, juste après l'écart des numéros déliés et avant le journal brut : les entrants du payload,
 * rattachés à leur espace par la lecture du job (une par numéro, partagée avec le rattachement qui suit), passent la porte,
 * et ce qu'elle écarte sort du payload. Les accusés, les échos et les bascules restent. Ne lève jamais : un espace
 * illisible laisse le payload tel quel, et c'est le rattachement qui suit qui fera rejouer le job s'il le faut.
 */
export async function ecarterLesInconnusDesEspacesPleins(
  payload: unknown,
  espaceDe: EspaceDuNumero,
  deps: EspacesPleins,
  stop: EcrituresDuStop,
): Promise<unknown> {
  const messages = extractInbound(payload);
  if (messages.length === 0) return payload;
  let entrants: EntrantRattache[];
  try {
    entrants = await rattacherLesEntrants(messages, espaceDe);
  } catch (err) {
    journaliser('warn', 'espace_plein_espace_illisible', { err });
    return payload;
  }
  return sansCesMessages(payload, await messagesEcartes(entrants, deps, stop));
}
