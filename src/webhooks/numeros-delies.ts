import { asArray, asRecord } from './json';
import { numeroBusinessDuChange, valeurEffective } from './change';
import { journaliser } from '../lib/journal';

/**
 * L'écart des entrants d'un numéro délié. Délier ne touche à rien chez Meta, qui continue d'envoyer ce que ses
 * clients écrivent ; le geste promet pourtant que rien n'est enregistré. Ce module retire du payload, avant toute
 * étape du traitement, ce qui concerne un numéro délié, et le journalise.
 * Sauf les accusés de livraison : ce sont les nouvelles de nos propres envois d'avant le geste, et les jeter
 * fausserait les statistiques d'une campagne mise en pause.
 * Coût borné : une lecture par clé primaire, en une requête, seulement si le payload porte autre chose que des
 * accusés (zéro pour la file `webhook-status`, où il n'est pas câblé). Best-effort : une lecture en échec ne fait
 * pas échouer le job (un rejeu retarderait ou doublerait l'entrant d'un autre numéro) ; le payload passe tel
 * quel. L'écart se fait change par change.
 */

/** Parmi ces numéros, ceux qui sont déliés (`PgNumeroDelieStore.numerosDelies`). */
export type NumerosDelies = (ids: readonly string[]) => Promise<ReadonlySet<string>>;

/** Ce qu'un change porte d'autre que des accusés : messages, échos de l'agent de Meta, bascule de contrôle. */
function elementsHorsAccuses(field: unknown, value: Record<string, unknown>): number {
  return asArray(value['messages']).length
    + asArray(value['message_echoes']).length
    + (field === 'messaging_handovers' ? 1 : 0);
}

/**
 * Les numéros à interroger : ceux dont un change porte autre chose que des accusés. Un payload d'accusés purs
 * rend une liste vide, donc aucune lecture.
 */
export function numerosAInterroger(payload: unknown): string[] {
  const ids = new Set<string>();
  for (const entryRaw of asArray(asRecord(payload)['entry'])) {
    for (const changeRaw of asArray(asRecord(entryRaw)['changes'])) {
      const change = asRecord(changeRaw);
      // `valeurEffective` : un standby imbrique tout sous `value.standby` (voir `./change.ts`).
      const value = valeurEffective(change['value']);
      if (elementsHorsAccuses(change['field'], value) === 0) continue;
      const id = numeroBusinessDuChange(value);
      if (id !== undefined) ids.add(id);
    }
  }
  return [...ids];
}

export interface Ecart {
  phoneNumberId: string;
  /** Messages, échos et bascules retirés. Jamais leur contenu : un corps de message est une donnée personnelle. */
  elements: number;
}

/**
 * Le payload sans ce qui concerne un numéro délié, accusés exceptés. Fonction pure : le payload reçu n'est pas
 * modifié, et il est rendu tel quel quand rien n'est à retirer. Un change sans numéro business lisible est
 * gardé (événements de compte) : on ne retire que ce qu'on sait attribuer.
 */
export function ecarterLesNumerosDelies(payload: unknown, delies: ReadonlySet<string>): { payload: unknown; ecartes: Ecart[] } {
  if (delies.size === 0) return { payload, ecartes: [] };
  const ecartes: Ecart[] = [];
  const racine = asRecord(payload);
  const entry = asArray(racine['entry']).map((entryRaw) => {
    const e = asRecord(entryRaw);
    const changes = asArray(e['changes']).flatMap((changeRaw) => {
      const change = asRecord(changeRaw);
      const value = valeurEffective(change['value']);
      const id = numeroBusinessDuChange(value);
      const elements = elementsHorsAccuses(change['field'], value);
      if (id === undefined || !delies.has(id) || elements === 0) return [changeRaw];
      ecartes.push({ phoneNumberId: id, elements });
      const statuses = asArray(value['statuses']);
      if (statuses.length === 0) return [];
      // Les accusés restent, remontés au premier niveau : la forme que lit `processStatuses` (par `valeurEffective`).
      return [{ ...change, value: { messaging_product: value['messaging_product'], metadata: value['metadata'], statuses } }];
    });
    return { ...e, changes };
  });
  return ecartes.length === 0 ? { payload, ecartes } : { payload: { ...racine, entry }, ecartes };
}

/**
 * L'étape du job webhook : lit les numéros déliés du payload, retire ce qui les concerne, journalise. Ne lève
 * jamais : une lecture en échec rend le payload tel quel.
 */
export async function ecarterLesEntrantsDelies(payload: unknown, numerosDelies: NumerosDelies): Promise<unknown> {
  const ids = numerosAInterroger(payload);
  if (ids.length === 0) return payload;
  let delies: ReadonlySet<string>;
  try {
    delies = await numerosDelies(ids);
  } catch (err) {
    journaliser('warn', 'numeros_delies_illisibles', { phoneNumberIds: ids, err });
    return payload;
  }
  const { payload: filtre, ecartes } = ecarterLesNumerosDelies(payload, delies);
  for (const e of ecartes) journaliser('info', 'entrant_ecarte_numero_delie', { phoneNumberId: e.phoneNumberId, elements: e.elements });
  return filtre;
}
