import { z } from 'zod';
import { CLE_VARIABLE } from '../crm/template';

/**
 * Les variables d'un destinataire de `/v1/sends` : `{ clé: texte }`, propres à ce destinataire, jamais
 * écrites sur sa fiche. Bornes : 50 variables de 1 024 caractères au plus (un corps de 50 destinataires
 * reste loin du plafond de 1 Mo du serveur).
 */
export const VALEUR_VARIABLE_MAX = 1024;
export const VARIABLES_MAX = 50;

/**
 * `__proto__` est refusé sur l'entrée brute, avant le `record` : zod 4 le retire du résultat sans rien dire,
 * donc une garde posée sur la clé ne s'exécute jamais, et l'intégrateur croirait sa variable partie.
 */
export const schemaVariables = z.unknown()
  .refine((v) => typeof v !== 'object' || v === null || !Object.hasOwn(v, '__proto__'), 'nom de variable réservé : __proto__')
  .pipe(z.record(
    z.string().regex(CLE_VARIABLE, 'nom de variable : lettres, chiffres, « _ », « . » ou « - », 64 caractères au plus'),
    z.string().max(VALEUR_VARIABLE_MAX, `valeur de variable : ${VALEUR_VARIABLE_MAX} caractères au plus`),
  ).refine((o) => Object.keys(o).length <= VARIABLES_MAX, `${VARIABLES_MAX} variables au plus par destinataire`));


export type TypeDeCible = 'template' | 'scenario' | 'node' | 'rcsMessage';

/**
 * L'index du premier destinataire qui porte `variables` alors que la cible n'en a pas l'usage, sinon
 * `null`. Un scénario ou un bloc n'a aucun endroit où les ranger : les accepter ferait croire qu'elles
 * servent. Lit les destinataires tels que reçus : ce 400 sur tout l'envoi doit tomber avant le compteur
 * d'usage et le claim d'idempotence, alors que chaque destinataire n'est validé qu'après.
 */
export function destinataireAvecVariablesInterdites(cible: TypeDeCible, destinataires: readonly unknown[]): number | null {
  if (cible === 'template' || cible === 'rcsMessage') return null;
  const i = destinataires.findIndex((d) => typeof d === 'object' && d !== null && Object.hasOwn(d, 'variables'));
  return i === -1 ? null : i;
}
