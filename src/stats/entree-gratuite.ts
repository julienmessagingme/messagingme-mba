import { TYPE_ENTREE_GRATUITE } from '../webhooks/tarif-meta';

/**
 * « Meta ne facture pas ce message » : il est parti dans les 72 h gratuites qui suivent un clic sur une pub
 * Click-to-WhatsApp. La seule source est l'accusé de Meta (`tarifs_meta`) ; un message sans ligne de tarif
 * reste compté comme payant.
 *
 * 🔴 Posé par toute lecture de coût et par aucune lecture de volume (un message gratuit reste un message
 * envoyé). Une lecture de coût ajoutée doit le poser aussi, sinon deux écrans afficheront deux coûts pour les
 * mêmes envois (`grep horsEntreeGratuite` donne la liste).
 *
 * `wamid` et `tenant` sont des expressions SQL de la requête appelante, jamais des valeurs d'un utilisateur.
 */
export function horsEntreeGratuite(wamid: string, tenant: string): string {
  return `not exists (select 1 from tarifs_meta tg where tg.tenant_id = ${tenant} and tg.wamid = ${wamid} and tg.type = '${TYPE_ENTREE_GRATUITE}')`;
}
