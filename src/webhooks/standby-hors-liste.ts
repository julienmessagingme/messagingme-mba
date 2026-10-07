import type { EntrantRattache } from './rattachement';
import { journaliser } from '../lib/journal';

/**
 * Un contact absent de la liste de l'agent de Meta parle à la plateforme, même quand Meta range son message en
 * `standby`.
 *
 * Meta range en `standby` tout message d'une conversation qu'il croit tenue par son agent : après un modèle, après
 * un `release`, sans rien qui nous le dise. En mode liste (toujours posé, `src/mba/liste.ts`), l'agent ne répond
 * pourtant qu'aux contacts de sa liste (mesuré le 2026-09-29). Pour un contact absent de la liste, un `standby` ne
 * veut donc pas dire que l'agent tient le fil : personne ne répondrait, puisque tout le reste du code ignore un
 * `standby`. On le traite comme un `messages`, et tous les consommateurs suivent sans rien savoir de la liste :
 * l'avance d'un scénario (texte et boutons), les automations, la remise à l'agent quand personne ne suit, le routage
 * publicitaire, l'arrivée publicitaire, et la correction du détenteur, qui n'écrit plus `mba` pour ce message.
 *
 * Contact présent sur la liste : rien ne change, l'agent parle. Le champ reçu reste lisible (`fieldRecu`).
 *
 * 🔴 LE MODE DÉCIDE, PAS LA PRÉSENCE D'UN AGENT (RC6, `standbyPourNous`, `src/repondeur/mode.ts`). Dans les quatre
 * modes, un contact absent de la liste est pour nous : l'agent de Meta répondeur ne parle qu'à sa liste ; en veille
 * (allumé, mode agent, scénario ou équipe), il ne répond à personne qu'un bloc ne lui a pas confié ; éteint, Meta peut
 * croire encore tenir le fil d'un contact qu'il servait avant (lot 5). Sinon le message serait perdu, puisque toutes nos
 * étapes ignorent un `standby`, et l'équipe ne le verrait pas dans « À traiter ». Avant RC6, un espace sans répondeur
 * ne requalifiait rien (« une autre application tient le fil ») : ces espaces sont en mode `equipe`.
 */
export interface ListeALArrivee {
  /** Le mode de cet espace veut-il qu'un `standby` d'un contact hors liste lui revienne (`standbyPourNous`) ? */
  standbyPourNous(tenantId: string): Promise<boolean>;
  /** Les contacts de `waIds` présents sur la liste de l'agent, en une lecture (`ListeDeLAgent.presents`). */
  presents(tenantId: string, waIds: readonly string[]): Promise<Set<string>>;
}

/**
 * Rend les entrants, ceux d'un contact absent de la liste passés de `standby` à `messages`. Une lecture des réglages
 * et une lecture de la liste par espace concerné, pour tout le lot ; aucune quand le lot ne porte aucun `standby`.
 * Une lecture en échec lève : placée avant l'enregistrement, elle fait rejouer le job, comme le rattachement.
 */
export async function requalifierLesStandby(
  entrants: readonly EntrantRattache[],
  liste: ListeALArrivee,
): Promise<EntrantRattache[]> {
  const enStandby = new Map<string, Set<string>>();
  for (const { message: m, tenantId } of entrants) {
    if (!tenantId || m.field !== 'standby') continue;
    const waIds = enStandby.get(tenantId) ?? new Set<string>();
    waIds.add(m.waId);
    enStandby.set(tenantId, waIds);
  }
  if (enStandby.size === 0) return [...entrants];

  const horsListe = new Map<string, Set<string>>();
  for (const [tenantId, waIds] of enStandby) {
    if (!(await liste.standbyPourNous(tenantId))) continue;
    const presents = await liste.presents(tenantId, [...waIds]);
    horsListe.set(tenantId, new Set([...waIds].filter((w) => !presents.has(w))));
  }

  return entrants.map((e) => {
    const { message: m, tenantId } = e;
    if (!tenantId || m.field !== 'standby' || horsListe.get(tenantId)?.has(m.waId) !== true) return e;
    journaliser('info', 'standby_hors_liste', { tenantId, waId: m.waId, messageId: m.messageId });
    return { tenantId, message: { ...m, field: 'messages', fieldRecu: m.field } };
  });
}
