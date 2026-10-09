/**
 * La règle structurelle des champs du contact dans l'adresse d'un bouton « Lien » (`https://site.fr/commande/{cle}`),
 * PARTAGÉE par le serveur (`src/links/champs-url.ts`, qui remplit les champs au clic) et la console
 * (`web/lib/champs-url.ts`, qui prévient à la saisie) : une seule règle, aucune copie à tenir alignée.
 *
 * 🔴 UN CHAMP NE SE TROUVE QU'APRÈS L'HÔTE (chemin, requête, fragment). Une valeur de fiche peut être écrite par le
 * contact lui-même (formulaire, réponse) : un champ dans le schéma, l'utilisateur, l'hôte ou le port ferait de notre
 * domaine un redirecteur ouvert. La règle se lit sur le TEXTE, jamais sur `new URL`, qui accepte `{` et `}` dans un
 * nom d'hôte (`https://{x}.fr` s'y analyse en hôte `{x}.fr`). Fonctions pures, sans IO.
 */

/** Les champs de base qu'une adresse peut porter, en plus des champs déclarés de l'espace. */
export const CLES_DE_BASE_URL: readonly string[] = ['prenom', 'nom', 'telephone'];

/** Un champ : une clé entre accolades SIMPLES. Les doubles (`{{1}}`) sont la variable de Meta, autre chose. */
export const MOTIF_CHAMP = /\{([^{}]*)\}/g;
/** La forme d'une clé de champ (celles de `slugify`, en plus large : l'appartenance aux champs connus tranche). */
const CLE_CHAMP = /^[A-Za-z0-9_]{1,64}$/;
/** La variable de bouton de Meta, seule forme d'accolades doubles admise (une adresse dynamique, jamais tracée). */
const VARIABLE_META = /\{\{\s*\d+\s*\}\}/g;

export type RaisonChampsUrl =
  /** Un champ mêlé à une variable de Meta `{{1}}`. */
  | 'variable_meta'
  /** Une accolade sans sa paire. */
  | 'accolade'
  /** `{}` */
  | 'champ_vide'
  /** Une clé qui n'a pas la forme d'une clé de champ. */
  | 'cle_mal_formee'
  /** Un champ dans le schéma, l'utilisateur, l'hôte ou le port, ou une adresse qui ne commence pas par `http(s)://`. */
  | 'avant_le_chemin';

export type AnalyseChampsUrl =
  | { ok: true; cles: string[] }
  | { ok: false; raison: RaisonChampsUrl; jeton?: string };

/**
 * Les champs d'une adresse, ou la raison structurelle de la refuser. `cles` vide = adresse sans champ (le cas de
 * toutes les adresses d'avant ce lot). Ne dit rien de l'existence des clés : c'est `refusChampsUrl` qui la juge.
 */
export function analyserChampsUrl(brut: string): AnalyseChampsUrl {
  const url = brut.trim();
  if (!/[{}]/.test(url)) return { ok: true, cles: [] };

  // Une adresse dynamique de Meta (`{{1}}`) garde son comportement d'avant : non tracée, soumise telle quelle.
  // Y mêler un champ n'a pas de sens (Meta la recevrait en clair) : refusé.
  if (url.includes('{{')) {
    return /[{}]/.test(url.replace(VARIABLE_META, '')) ? { ok: false, raison: 'variable_meta' } : { ok: true, cles: [] };
  }

  const cles: string[] = [];
  for (const m of url.matchAll(MOTIF_CHAMP)) {
    const cle = m[1]!;
    if (cle === '') return { ok: false, raison: 'champ_vide', jeton: m[0] };
    if (!CLE_CHAMP.test(cle)) return { ok: false, raison: 'cle_mal_formee', jeton: m[0] };
    if (!cles.includes(cle)) cles.push(cle);
  }
  if (/[{}]/.test(url.replace(MOTIF_CHAMP, ''))) return { ok: false, raison: 'accolade' };

  // L'autorité (utilisateur, hôte, port) s'arrête au premier `/`, `?` ou `#` qui suit `://`. Un antislash n'y met PAS
  // fin ici, alors que le navigateur le lit comme un `/` : on refuse donc plus large que nécessaire, jamais moins.
  const schema = /^https?:\/\//i.exec(url);
  if (!schema) return { ok: false, raison: 'avant_le_chemin' };
  const reste = url.slice(schema[0].length);
  const fin = reste.search(/[/?#]/);
  const autorite = fin === -1 ? reste : reste.slice(0, fin);
  if (/[{}]/.test(autorite)) return { ok: false, raison: 'avant_le_chemin' };

  return { ok: true, cles };
}
