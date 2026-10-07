import { isSendableButtonUrl } from '../meta/button-url';

/**
 * Les champs du contact dans l'adresse d'un bouton « Lien » : `https://site.fr/commande/{numero_commande}`.
 *
 * Meta ne reçoit jamais cette adresse : il reçoit notre lien tracé à jeton (`lienTraceAvecJeton`), et c'est notre
 * redirection (`src/http/links.ts`) qui, au clic, lit la fiche du contact par son jeton et remplace chaque `{cle}`
 * par sa valeur. La destination est stockée telle quelle dans `tracked_links.destination`.
 *
 * 🔴 UN CHAMP NE SE TROUVE QU'APRÈS L'HÔTE (chemin, requête, fragment). Une valeur de fiche peut être écrite par le
 * contact lui-même (formulaire, réponse) : un champ dans le schéma, l'utilisateur, l'hôte ou le port ferait de notre
 * domaine un redirecteur ouvert. La règle se lit sur le TEXTE, jamais sur `new URL`, qui accepte `{` et `}` dans un
 * nom d'hôte (`https://{x}.fr` s'y analyse en hôte `{x}.fr`).
 *
 * Fonctions pures. La règle structurelle (`analyserChampsUrl`) est DUPLIQUÉE dans `web/lib/champs-url.ts` : les deux
 * builds ne partagent aucun module, `tests/web-champs-url-parity.test.ts` tient la parité.
 */

/** Les champs de base qu'une adresse peut porter, en plus des champs déclarés de l'espace. */
export const CLES_DE_BASE_URL: readonly string[] = ['prenom', 'nom', 'telephone'];

/** Un champ : une clé entre accolades SIMPLES. Les doubles (`{{1}}`) sont la variable de Meta, autre chose. */
const MOTIF_CHAMP = /\{([^{}]*)\}/g;
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

/**
 * Cette destination porte-t-elle des champs que la redirection doit remplir ? `false` pour une adresse sans champ, et
 * pour une adresse qui ne se laisse pas analyser (écrite avant ce lot, ou hors de la console) : celles-là suivent
 * le chemin d'avant, sans lecture de fiche.
 */
export function porteDesChamps(destination: string): boolean {
  const a = analyserChampsUrl(destination);
  return a.ok && a.cles.length > 0;
}

/**
 * Pourquoi refuser l'adresse de ce bouton à la création, en français lisible, ou `null`. `clesConnues` = les champs
 * déclarés de l'espace ; `CLES_DE_BASE_URL` s'y ajoute. `quoi` désigne le bouton (« bouton 2 »).
 */
export function refusChampsUrl(url: string, clesConnues: readonly string[], quoi: string): string | null {
  const a = analyserChampsUrl(url);
  if (!a.ok) {
    switch (a.raison) {
      case 'variable_meta':
        return `${quoi} : un champ du contact ne peut pas accompagner une variable {{1}} dans la même adresse`;
      case 'accolade':
        return `${quoi} : accolade sans sa paire dans « ${url.trim()} » (un champ du contact s'écrit {cle})`;
      case 'champ_vide':
        return `${quoi} : champ vide {} dans « ${url.trim()} »`;
      case 'cle_mal_formee':
        return `${quoi} : ${a.jeton ?? 'ce champ'} n'est pas un champ du contact`;
      case 'avant_le_chemin':
        return `${quoi} : un champ du contact ne peut se trouver qu'après le nom du site (dans le chemin, après « / »)`;
    }
  }
  const connues = new Set([...CLES_DE_BASE_URL, ...clesConnues]);
  const inconnue = a.cles.find((c) => !connues.has(c));
  return inconnue === undefined ? null : `${quoi} : le champ {${inconnue}} n'existe pas dans vos champs de contact`;
}

/** Ce que la fiche d'un contact offre à une adresse : ses champs, plus les trois champs de base. */
export function valeursDeLaFiche(c: {
  profile_name: string | null;
  phone_e164: string | null;
  fields: Record<string, unknown> | null;
}): Record<string, string | null> {
  // Sans prototype : `constructor` a la forme d'une clé de champ.
  const out: Record<string, string | null> = Object.create(null);
  for (const [k, v] of Object.entries(c.fields ?? {})) {
    out[k] = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
  }
  // Après les champs libres : `nom` et `telephone` sont des slugs réservés (`isReservedFieldLabel`), aucun champ
  // déclaré ne les porte. `prenom` est un champ socle, il vient de `fields`.
  out.nom = c.profile_name;
  out.telephone = c.phone_e164;
  return out;
}

/** La valeur à écrire dans l'adresse : encodée, ou vide. `.` et `..` seuls seraient lus comme un chemin relatif. */
function encoder(v: string | null | undefined): string {
  const s = (v ?? '').trim();
  if (s === '' || s === '.' || s === '..') return '';
  return encodeURIComponent(s);
}

/** Même protocole, même hôte (port compris), même utilisateur. */
function memeOrigine(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === y.protocol && x.host === y.host && x.username === y.username && x.password === y.password;
  } catch {
    return false;
  }
}

/**
 * L'adresse où rediriger, champs remplis par les valeurs de la fiche (`null` = aucune fiche lue : jeton `anon`,
 * inconnu, absent, ou lecture en échec). Un champ sans valeur est RETIRÉ. Une destination qui ne se laisse pas
 * analyser, ou sans champ, est rendue telle quelle : c'est le chemin de toutes les adresses déjà envoyées.
 *
 * 🔴 L'adresse remplie est REVALIDÉE (même origine que la destination sans ses champs, et envoyable) avant d'être
 * rendue ; sinon, la destination sans ses champs. `encodeURIComponent` ne laisse passer ni `/`, ni `?`, ni `#`, ni
 * `@`, ni `:` : une valeur ne sort pas de sa place, et l'hôte ne change jamais.
 */
export function remplirChampsUrl(destination: string, valeurs: Readonly<Record<string, string | null>> | null): string {
  if (!porteDesChamps(destination)) return destination;
  const url = destination.trim();
  const sansChamps = url.replace(MOTIF_CHAMP, '');
  if (!isSendableButtonUrl(sansChamps)) return destination;
  const rempli = url.replace(MOTIF_CHAMP, (_m, cle: string) =>
    encoder(valeurs && Object.hasOwn(valeurs, cle) ? valeurs[cle] : null));
  return memeOrigine(rempli, sansChamps) && isSendableButtonUrl(rempli) ? rempli : sansChamps;
}
