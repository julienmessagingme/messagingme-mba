import { z } from 'zod';
import { CLE_VARIABLE } from '../crm/template';

/**
 * LES VARIABLES D'UN DESTINATAIRE DE `/v1/sends` (spec 2026-09-24, § 3, lot 3) : `{ clé: texte }`, propres à
 * CE destinataire, jamais écrites sur sa fiche.
 *
 * Les bornes : 50 variables de 1 024 caractères au plus. Un paramètre de template WhatsApp et un texte RCS
 * tiennent dedans, et un corps de 50 destinataires reste loin du plafond de 1 Mo du serveur.
 */
export const VALEUR_VARIABLE_MAX = 1024;
export const VARIABLES_MAX = 50;

/**
 * ⚠️ `__proto__` EST REFUSÉ SUR L'ENTRÉE BRUTE, AVANT le `record`, et pas par un `refine` sur la clé : zod 4 le
 * RETIRE du résultat sans rien dire (mesuré : `{"__proto__": "x", "a": "b"}` rend `{ a: "b" }` en succès), donc
 * une garde posée sur la clé ne s'exécute jamais. Le retirer en silence ne pollue rien, mais ferait croire à
 * l'intégrateur que sa variable est partie.
 */
export const schemaVariables = z.unknown()
  .refine((v) => typeof v !== 'object' || v === null || !Object.hasOwn(v, '__proto__'), 'nom de variable réservé : __proto__')
  .pipe(z.record(
    z.string().regex(CLE_VARIABLE, 'nom de variable : lettres, chiffres, « _ », « . » ou « - », 64 caractères au plus'),
    z.string().max(VALEUR_VARIABLE_MAX, `valeur de variable : ${VALEUR_VARIABLE_MAX} caractères au plus`),
  ).refine((o) => Object.keys(o).length <= VARIABLES_MAX, `${VARIABLES_MAX} variables au plus par destinataire`));


export type TypeDeCible = 'template' | 'scenario' | 'node' | 'rcsMessage';

/**
 * L'index du premier destinataire qui porte une clé `variables` alors que la cible n'en a pas l'usage, sinon
 * `null`. 🔴 Un scénario ou un bloc n'a aujourd'hui AUCUN endroit où les ranger : les accepter en silence ferait
 * croire à l'intégrateur qu'elles servent.
 *
 * ⚠️ ELLE LIT LES DESTINATAIRES TELS QUE REÇUS (`unknown`), et c'est voulu : le refus est un 400 sur tout
 * l'envoi, qui doit tomber AVANT le compteur d'usage et le claim d'idempotence, alors que la route du lot 2 ne
 * valide chaque destinataire qu'APRÈS (un destinataire mal formé y est écarté, pas refusé). Aucun `as` :
 * `Object.hasOwn` suffit à lire une clé sur un objet quelconque.
 */
export function destinataireAvecVariablesInterdites(cible: TypeDeCible, destinataires: readonly unknown[]): number | null {
  if (cible === 'template' || cible === 'rcsMessage') return null;
  const i = destinataires.findIndex((d) => typeof d === 'object' && d !== null && Object.hasOwn(d, 'variables'));
  return i === -1 ? null : i;
}
