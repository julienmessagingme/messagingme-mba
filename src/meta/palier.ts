/**
 * Le palier d'envoi d'un numéro Meta (`messaging_limit_tier`), lu pour avertir avant une campagne.
 *
 * On avertit, on ne refuse jamais : le palier est un relevé périodique (donc périmable), Meta compte des
 * conversations uniques et non nos destinataires, et les autres envois consomment le même budget. Le nombre
 * affiché est un ordre de grandeur pour un humain, jamais une règle de gestion.
 */

/**
 * Plafond de conversations par 24 h d'un palier, ou `undefined` si on ne sait pas conclure (absent, illimité,
 * forme inconnue). Lu par motif (`TIER_<n>`, `K` ou `M` facultatif) plutôt que par table figée : un palier
 * ajouté par Meta est compris sans redéploiement, et une valeur incomprise n'affiche rien plutôt qu'un chiffre inventé.
 */
export function plafondDuPalier(tier: string | null | undefined): number | undefined {
  if (typeof tier !== 'string') return undefined;
  const m = /^TIER_(\d+)(K|M)?$/i.exec(tier.trim());
  if (!m) return undefined; // TIER_UNLIMITED compris : pas de plafond à annoncer
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const facteur = m[2]?.toUpperCase() === 'M' ? 1_000_000 : m[2]?.toUpperCase() === 'K' ? 1_000 : 1;
  return n * facteur;
}

/** L'avertissement à afficher à un opérateur avant de lancer, ou `undefined` s'il n'y a rien à dire. */
export function avertissementPalier(tier: string | null | undefined, destinataires: number): string | undefined {
  const plafond = plafondDuPalier(tier);
  if (plafond === undefined || destinataires <= plafond) return undefined;
  // La reprise d'une campagne `paused` n'est pas automatique (il faut un POST `/run`) : le texte doit le dire,
  // sinon l'opérateur attend une reprise qui ne vient jamais.
  return `Ce numéro est au palier ${plafond.toLocaleString('fr-FR')} conversations par 24 h, et cette campagne vise `
    + `${destinataires.toLocaleString('fr-FR')} destinataires. Elle partira en plusieurs jours : au plafond, Meta `
    + `refuse les envois suivants et la campagne se met en pause d'elle-même, sans perdre personne. `
    + `Vous devrez la relancer vous-même le lendemain : la reprise n'est pas automatique. `
    + `Ordre de grandeur seulement : le palier est relevé périodiquement, Meta compte des `
    + `conversations et non des destinataires, et vos autres envois consomment le même budget.`;
}
