/**
 * LES UTM DE NOS LIENS TRACÉS (plan 2026-10-28, tâche 6a). La redirection d'un lien d'un modèle WhatsApp, pour un espace
 * qui a une boutique Shopify branchée, les ajoute à la destination ; Shopify les relit ensuite dans le parcours client
 * de la commande (`customerJourneySummary.lastVisit`), et c'est la preuve qu'une vente vient de notre message
 * (`src/shopify/preuve-utm.ts`). La campagne porte le NOM DU MODÈLE : un lien appartient au bouton d'un modèle, pas à
 * un envoi. 🔴 Jamais un nom de l'infra dans ces valeurs : le marchand les lit dans ses rapports Shopify.
 */
export const UTM_SOURCE = 'whatsapp';
export const UTM_MEDIUM = 'messagingme';

/** La destination avec nos UTM ; telle quelle si elle en porte déjà un (le marquage du marchand prime) ou si elle est illisible. */
export function avecUtm(destination: string, modele: string): string {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return destination;
  }
  if ([...url.searchParams.keys()].some((k) => k.toLowerCase().startsWith('utm_'))) return destination;
  url.searchParams.set('utm_source', UTM_SOURCE);
  url.searchParams.set('utm_medium', UTM_MEDIUM);
  url.searchParams.set('utm_campaign', modele);
  return url.toString();
}

/** Le modèle que nomment des UTM, s'ils sont les NÔTRES (source et medium) ; sinon `null`. */
export function modeleDesUtm(utm: { source?: string | null; medium?: string | null; campaign?: string | null } | null | undefined): string | null {
  if (!utm || utm.source !== UTM_SOURCE || utm.medium !== UTM_MEDIUM) return null;
  const modele = utm.campaign?.trim() ?? '';
  return modele === '' ? null : modele;
}
