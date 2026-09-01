/**
 * Le PALIER d'envoi d'un numéro Meta (`messaging_limit_tier`), enfin utilisé (lot 7 du programme II).
 *
 * Il était récupéré, persisté et affiché, et rien ne s'en servait : on lançait une campagne de 5 000
 * destinataires sur un numéro neuf plafonné à 1 000 conversations par 24 h sans que rien ne le dise. Le
 * moteur, lui, sait déjà s'arrêter proprement (les codes de plafond mettent la campagne en pause depuis le
 * lot 1 du programme I) : ce qui manquait, c'est de le dire AVANT.
 *
 * 🔴 ON AVERTIT, ON NE REFUSE JAMAIS, et ce n'est pas de la timidité. Trois raisons, toutes vérifiables :
 *  - le palier est un relevé PÉRIODIQUE, donc périmable : refuser sur une valeur vieille de quelques heures
 *    bloquerait un envoi parfaitement légitime ;
 *  - Meta compte des CONVERSATIONS UNIQUES par 24 h, pas nos lignes de destinataires : deux messages au même
 *    contact ne coûtent qu'une conversation, et notre nombre de destinataires n'est donc pas la bonne unité ;
 *  - l'inbox, les scénarios et les autres campagnes consomment le MÊME budget, que cette fonction ignore.
 * Le nombre affiché est un ordre de grandeur destiné à un humain, jamais une règle de gestion.
 */

/**
 * Plafond de conversations par 24 h correspondant à un palier, ou `undefined` si on ne sait pas conclure
 * (palier absent, illimité, ou forme inconnue d'une valeur que Meta ferait évoluer).
 *
 * La forme est `TIER_<n>` avec un `K` ou un `M` facultatif (`TIER_250`, `TIER_1K`, `TIER_100K`). On la lit
 * par motif plutôt que par une table figée : un palier ajouté par Meta demain sera compris sans redéploiement,
 * et une valeur qu'on ne comprend pas rend `undefined`, donc n'affiche rien, plutôt qu'un chiffre inventé.
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

/**
 * L'avertissement à afficher avant de lancer, ou `undefined` s'il n'y a rien à dire.
 *
 * Rendu en TEXTE et non en code d'erreur : c'est un message destiné à un opérateur, affiché à côté du bouton
 * de lancement, pas une condition que du code irait tester.
 */
export function avertissementPalier(tier: string | null | undefined, destinataires: number): string | undefined {
  const plafond = plafondDuPalier(tier);
  if (plafond === undefined || destinataires <= plafond) return undefined;
  // 🔴 « et VOUS DEVREZ LA REPRENDRE », pas « et reprend ensuite ». La phrase d'avant promettait une reprise
  // automatique qui n'existe pas : aucune routine ne repasse une campagne `paused` en `running`, il faut un
  // POST `/run`. Trouvé par le contre-audit du 2026-09-01. Un opérateur qui lit « reprend ensuite » attend
  // devant un écran, et la campagne ne repart jamais. Tant que la reprise est manuelle, le texte le dit.
  return `Ce numéro est au palier ${plafond.toLocaleString('fr-FR')} conversations par 24 h, et cette campagne vise `
    + `${destinataires.toLocaleString('fr-FR')} destinataires. Elle partira en plusieurs jours : au plafond, Meta `
    + `refuse les envois suivants et la campagne se met en pause d'elle-même, sans perdre personne. `
    + `Vous devrez la relancer vous-même le lendemain : la reprise n'est pas automatique. `
    + `Ordre de grandeur seulement : le palier est relevé périodiquement, Meta compte des `
    + `conversations et non des destinataires, et vos autres envois consomment le même budget.`;
}
