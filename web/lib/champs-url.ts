/**
 * Les champs du contact dans l'adresse d'un bouton « Lien » : `https://site.fr/commande/{numero_commande}`. Fonctions
 * PURES, sans IO.
 *
 * Le serveur soumet à Meta notre lien tracé, et notre redirection remplit chaque `{cle}` au clic avec la fiche de
 * celui qui clique. 🔴 Un champ ne se trouve qu'APRÈS le nom du site : une valeur de fiche peut être écrite par le
 * contact lui-même, et dans l'hôte elle ferait de notre domaine un redirecteur ouvert.
 *
 * ⚠️ `analyserChampsUrl` est DUPLIQUÉE dans `src/links/champs-url.ts` : les deux builds ne partagent aucun module.
 * `tests/web-champs-url-parity.test.ts` casse dès qu'elles divergent. Les MESSAGES, eux, vivent dans le formulaire
 * (traduits) : seule la règle est partagée.
 */

/** Les champs de base qu'une adresse peut porter, en plus des champs déclarés de l'espace. */
export const CLES_DE_BASE_URL: readonly string[] = ['prenom', 'nom', 'telephone'];

const MOTIF_CHAMP = /\{([^{}]*)\}/g;
const CLE_CHAMP = /^[A-Za-z0-9_]{1,64}$/;
const VARIABLE_META = /\{\{\s*\d+\s*\}\}/g;

export type RaisonChampsUrl = 'variable_meta' | 'accolade' | 'champ_vide' | 'cle_mal_formee' | 'avant_le_chemin';

export type AnalyseChampsUrl =
  | { ok: true; cles: string[] }
  | { ok: false; raison: RaisonChampsUrl; jeton?: string };

/** Les champs d'une adresse, ou la raison structurelle de la refuser. `cles` vide = adresse sans champ. */
export function analyserChampsUrl(brut: string): AnalyseChampsUrl {
  const url = brut.trim();
  if (!/[{}]/.test(url)) return { ok: true, cles: [] };

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

  const schema = /^https?:\/\//i.exec(url);
  if (!schema) return { ok: false, raison: 'avant_le_chemin' };
  const reste = url.slice(schema[0].length);
  const fin = reste.search(/[/?#]/);
  const autorite = fin === -1 ? reste : reste.slice(0, fin);
  if (/[{}]/.test(autorite)) return { ok: false, raison: 'avant_le_chemin' };

  return { ok: true, cles };
}

/** Une valeur d'exemple plausible pour un champ, dans l'aperçu de l'adresse. */
export function exempleDeChamp(cle: string): string {
  switch (cle) {
    case 'prenom': return 'Marie';
    case 'nom': return 'Martin';
    case 'telephone': return '+33612345678';
    default: return 'A1234';
  }
}

/**
 * L'adresse telle qu'un contact la recevrait, chaque champ remplacé par une valeur d'exemple encodée comme le fera la
 * redirection. `null` si l'adresse ne porte aucun champ, ou si elle est refusée.
 */
export function exempleUrl(brut: string): string | null {
  const a = analyserChampsUrl(brut);
  if (!a.ok || a.cles.length === 0) return null;
  return brut.trim().replace(MOTIF_CHAMP, (_m, cle: string) => encodeURIComponent(exempleDeChamp(cle)));
}
