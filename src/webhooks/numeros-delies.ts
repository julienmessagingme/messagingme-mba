import { asArray, asRecord } from './json';
import { valeurEffective } from './change';
import { numeroBusinessDuChange } from './handover';
import { journaliser } from '../lib/journal';

/**
 * L'ÉCART DES ENTRANTS D'UN NUMÉRO DÉLIÉ (migration 0180, bloc « Canaux et services » de l'Accueil).
 *
 * Délier un numéro ne touche à rien chez Meta : Meta continue donc de nous envoyer ce que ses clients écrivent
 * à ce numéro. Le geste promet pourtant que rien n'est enregistré. Ce module retire du payload, AVANT toute
 * étape du traitement (journal brut, Inbox, fiche, automations, avance de scénario, publicités, bascule de
 * l'agent de Meta), tout ce qui concerne un numéro délié, et il le journalise.
 *
 * 🔴 SAUF LES ACCUSÉS DE LIVRAISON. Ils ne sont pas des entrants : ce sont les nouvelles des messages que NOUS
 * avons envoyés avant le geste (livré, lu, échoué). Les jeter ferait mentir les statistiques d'une campagne
 * mise en pause au milieu, pour un geste qui promettait seulement de ne plus rien enregistrer de nouveau.
 *
 * 🔴 CE QUE ÇA COÛTE, ET C'EST BORNÉ PAR CONSTRUCTION :
 * - une lecture par clé primaire de `phone_numbers`, en UNE requête pour tous les numéros du payload (il n'y
 *   en a qu'un en pratique), et seulement si le payload porte autre chose que des accusés ;
 * - ZÉRO lecture pour un lot d'accusés purs, c'est-à-dire pour toute la file `webhook-status`, et ce module
 *   n'y est même pas câblé ;
 * - aucune écriture, aucun appel extérieur.
 *
 * 🔴 BEST-EFFORT, ET DANS LE BON SENS. Une lecture qui échoue ne fait PAS échouer le job : pg-boss le
 * rejouerait, et un entrant d'un AUTRE numéro serait retardé, voire traité deux fois par les étapes non
 * idempotentes, pour une vérification qui ne le concerne pas. On journalise et on traite le payload tel quel,
 * c'est-à-dire exactement comme avant ce lot. Et l'écart se fait CHANGE PAR CHANGE : un numéro délié ne retire
 * rien à un autre numéro du même payload.
 */

/** Parmi ces numéros, ceux qui sont déliés (`PgNumeroDelieStore.numerosDelies`). */
export type NumerosDelies = (ids: readonly string[]) => Promise<ReadonlySet<string>>;

/** Ce qu'un change porte d'AUTRE que des accusés : messages, échos de l'agent de Meta, bascule de contrôle. */
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
 * Le payload SANS ce qui concerne un numéro délié, accusés exceptés. Fonction PURE : le payload reçu n'est
 * jamais modifié, et il est rendu tel quel quand rien n'est à retirer.
 *
 * ⚠️ Un change sans numéro business lisible est GARDÉ : on ne retire que ce qu'on sait attribuer. Les événements
 * de compte (sans numéro) passent donc comme avant.
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
      // Les accusés RESTENT, remontés au premier niveau : c'est la forme que lit `processStatuses` (par
      // `valeurEffective`, qui laisse passer un `value` sans `standby`).
      return [{ ...change, value: { messaging_product: value['messaging_product'], metadata: value['metadata'], statuses } }];
    });
    return { ...e, changes };
  });
  return ecartes.length === 0 ? { payload, ecartes } : { payload: { ...racine, entry }, ecartes };
}

/**
 * L'étape du job webhook : lit les numéros déliés du payload, retire ce qui les concerne, journalise.
 * NE LÈVE JAMAIS (voir l'en-tête : une lecture en échec rend le payload tel quel).
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
