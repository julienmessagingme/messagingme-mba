/**
 * LA GARDE COMMUNE DES BANCS DE CHARGE (plan avant la bascule, lot 2a ; docs/ARCHITECTURE-CIBLE.md §7.8, point 3).
 *
 * 🔴 ELLE EST POSITIVE : un banc ne tourne que sur une base qui SE DÉCLARE jetable, par son nom d'hôte ou par son nom
 * de base (« banc » ou « jetable »), et refuse tout le reste. Les anciennes gardes refusaient « supabase » et
 * laissaient passer le reste : après la bascule, la production est une base Scaleway jointe par son adresse IP
 * privée, qu'aucun mot ne trahit, et elles ne protégeaient plus rien.
 *
 * Les bancs montent leur Postgres sous `banc14-postgres`, `banc-postgres` ou `banc30-postgres`. Chez Scaleway, la
 * base jetable se joint par une IP comme la production : le marqueur y est le NOM de la base (`banc`), que la base de
 * production ne portera jamais. Supabase reste refusé même avec une base nommée `banc` : c'est la production
 * d'avant la bascule, et la garde ne doit pas dépendre d'un nom qu'on peut y créer.
 */

/** La raison de refuser cette base pour un banc, ou null si elle se déclare jetable. */
export function refusDeBase(url: string): string | null {
  if (url.trim() === '') return 'DATABASE_URL manquant.';
  let hote: string;
  let base: string;
  try {
    const u = new URL(url);
    hote = u.hostname;
    base = decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    return 'DATABASE_URL illisible.';
  }
  if (/supabase/i.test(hote)) return `DATABASE_URL vise Supabase (${hote}), la production : refusée.`;
  if (!/banc|jetable/i.test(hote) && !/banc|jetable/i.test(base)) {
    return `DATABASE_URL ne se déclare pas jetable : ni son hôte (${hote}) ni sa base (${base || 'aucune'}) ne contient « banc » ou « jetable ».`;
  }
  return null;
}

/** Arrête le banc avant toute écriture si la base ne se déclare pas jetable. */
export function exigerBaseJetable(url: string): void {
  const refus = refusDeBase(url);
  if (refus !== null) throw new Error(`${refus} Un banc ne tourne que sur une base jetable.`);
}
