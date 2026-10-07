/**
 * Le lien d'un objet dans le tableau de bord de Stripe, là où Julien le regarde et le résilie à la main : la clé
 * restreinte ne le peut pas pour lui (RC8). Le mode de test vit sous `test/` ; un objet live ouvert sous `test/` (ou
 * l'inverse) rend une page vide chez Stripe, d'où le `livemode` lu en base avec l'objet, jamais deviné.
 */
export type ObjetStripe = 'customers' | 'subscriptions' | 'invoices';

export function lienTableauStripe(objet: ObjetStripe, id: string, livemode: boolean): string {
  return `https://dashboard.stripe.com/${livemode ? '' : 'test/'}${objet}/${encodeURIComponent(id)}`;
}
