import { TYPE_ENTREE_GRATUITE } from '../webhooks/tarif-meta';

/**
 * « META NE FACTURE PAS CE MESSAGE » : il est parti dans les 72 h gratuites qui suivent un clic sur une pub
 * Click-to-WhatsApp (lot 1 des pubs, migration 0163). La seule source est l'accusé de Meta, gardé dans
 * `tarifs_meta` ; un message SANS ligne de tarif reste compté comme payant, c'est-à-dire le comportement
 * d'avant.
 *
 * 🔴 UNE SEULE ÉCRITURE, POSÉE PAR TOUTE LECTURE DE COÛT ET PAR AUCUNE LECTURE DE VOLUME. Un message gratuit ne
 * coûte rien, mais il reste un message envoyé : les courbes de `getDashboard` le comptent, délibérément. La
 * liste des lectures qui le posent se lit par `grep horsEntreeGratuite`, elle ne s'écrit pas ici : elle
 * pourrirait au premier ajout. ⚠️ Une lecture de coût ajoutée demain doit le poser aussi, sinon deux écrans
 * afficheront deux coûts pour les mêmes envois (relevé en revue du lot 1 : la fiche d'une campagne et le
 * bilan d'un contact avaient été oubliés du plan).
 *
 * `wamid` et `tenant` sont des EXPRESSIONS SQL de la requête appelante (par exemple `m.meta_message_id` et
 * `cv.tenant_id`), jamais des valeurs venues d'un utilisateur.
 */
export function horsEntreeGratuite(wamid: string, tenant: string): string {
  return `not exists (select 1 from tarifs_meta tg where tg.tenant_id = ${tenant} and tg.wamid = ${wamid} and tg.type = '${TYPE_ENTREE_GRATUITE}')`;
}
