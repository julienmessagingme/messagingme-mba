import type { Issue } from '../lib/issue';

/**
 * CE QU'UN OUTIL MCP LIT DE SES ARGUMENTS, ET COMMENT IL REFUSE.
 *
 * Sorti de `src/mcp/outils.ts` quand les outils de l'agent IA ont pris leur fichier (`src/mcp/outils-agent.ts`, lot
 * 8a) : les deux catalogues s'en servent, et le catalogue de l'agent ne peut pas importer `outils.ts`, qui l'importe
 * (une boucle d'imports laisse une constante non initialisée au chargement). Aucune logique métier ici.
 */

/**
 * Refus métier d'un outil (fenêtre fermée, conversation inconnue), par opposition à une panne. MCP le veut dans le
 * résultat avec `isError: true` : le modèle lit la raison et change de stratégie au lieu de croire l'outil cassé.
 */
export class RefusOutil extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusOutil';
  }
}

/**
 * Lit une chaîne obligatoire. Les entrées viennent d'un modèle : on ne suppose rien de leur forme. Le plafond est
 * toujours écrit à l'appel, jamais par défaut : `tests/mcp-serveur.test.ts` le lit là et exige que le schéma de
 * l'outil l'annonce (`minLength: 1`, `maxLength: maxi`).
 */
export function texteObligatoire(args: Record<string, unknown>, cle: string, maxi: number): string {
  const v = args[cle];
  if (typeof v !== 'string' || v.trim() === '') throw new RefusOutil(`paramètre « ${cle} » requis (texte non vide)`);
  if (v.length > maxi) throw new RefusOutil(`paramètre « ${cle} » trop long (${maxi} caractères au plus)`);
  return v.trim();
}

/**
 * Lit un entier borné. Absent : défaut. Hors bornes : ramené dedans, jamais refusé. Le schéma de l'outil annonce
 * `minimum: mini` et `maximum: maxi` (même test que `texteObligatoire`).
 */
export function entierBorne(args: Record<string, unknown>, cle: string, defaut: number, mini: number, maxi: number): number {
  const v = args[cle];
  if (v === undefined || v === null) return defaut;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return defaut;
  return Math.min(Math.max(Math.trunc(n), mini), maxi);
}

/**
 * Un entier dans ses bornes, ou un refus qui les dit : jamais ramené en silence, contrairement à `entierBorne`. Pour une
 * valeur que Claude annoncerait (une limite d'agent), ou qui désigne ce qu'on efface (une sélection de contacts).
 */
export function limiteEntiere(v: unknown, cle: string, mini: number, maxi: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < mini || v > maxi) {
    throw new RefusOutil(`${cle} : un nombre entier entre ${mini} et ${maxi}`);
  }
  return v;
}

/** Une date ISO 8601 qui DIT son fuseau (`Z` ou `+02:00`), à la seconde ou plus fin. */
const ISO_AVEC_FUSEAU = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Lit une date facultative. 🔴 Sans fuseau, elle est REFUSÉE, jamais supposée : « lundi 10 h » lu en UTC part deux
 * heures trop tôt à Paris, et une campagne programmée ne se rattrape pas. Absente : `undefined`.
 */
export function dateAvecFuseau(args: Record<string, unknown>, cle: string): Date | undefined {
  const v = args[cle];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !ISO_AVEC_FUSEAU.test(v)) {
    throw new RefusOutil(`paramètre « ${cle} » : une date ISO 8601 avec son fuseau est attendue (ex. 2026-10-21T10:00:00+02:00)`);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new RefusOutil(`paramètre « ${cle} » : date invalide`);
  return d;
}

/**
 * Un refus d'une fonction partagée avec la console devient un refus d'OUTIL, avec sa phrase telle que l'écran la
 * montre : le modèle lit pourquoi et corrige, au lieu de croire l'outil cassé. Le statut HTTP ne sert qu'à la route.
 * 🔴 Les détails partent avec la phrase (la liste des manques d'un agent qu'on active, le code d'un refus de
 * paiement) : la route les met dans son corps à côté de `error`, et sans eux le modèle saurait qu'il est refusé sans
 * savoir quoi corriger.
 */
export function valeurOuRefus<T>(r: Issue<T>): T {
  if (!r.ok) throw new RefusOutil(r.details ? `${r.erreur}\n${JSON.stringify(r.details)}` : r.erreur);
  return r.valeur;
}
