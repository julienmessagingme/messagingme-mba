import { isSendableButtonUrl } from '../../web/lib/partage/button-url';
import { analyserChampsUrl, CLES_DE_BASE_URL, MOTIF_CHAMP } from '../../web/lib/partage/champs-url';

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
 * Fonctions pures. La règle structurelle (`analyserChampsUrl`) vit dans `web/lib/partage/champs-url.ts`, partagée
 * avec la console.
 */

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
