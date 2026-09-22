import type { Pool } from 'pg';
import type { TarifMeta, TarifsMetaSink } from '../webhooks/tarif-meta';

/**
 * L'écriture des tarifs de Meta (`tarifs_meta`, migration 0163).
 *
 * L'espace se résout par le numéro DESTINATAIRE de l'accusé (`phone_numbers`), dans la même requête : un
 * numéro inconnu n'écrit rien. Le PREMIER accusé qui porte un tarif gagne : Meta répète le même `pricing` sur
 * sent, delivered et read.
 *
 * ⚠️ LE PRIX DE CETTE SIMPLICITÉ, ACCEPTÉ EN REVUE DU LOT 1 : jusqu'à trois tentatives par message sortant,
 * dont deux sans effet, sur la file des accusés, qui est sérialisée. C'est une recherche par clé primaire,
 * de l'ordre de la milliseconde. Si cette file ralentit un jour sur une grosse campagne, le levier est ici :
 * n'écrire que sur le premier statut qui porte un tarif, plutôt que de compter sur le conflit pour les écarter.
 */
export class PgTarifsMetaStore implements TarifsMetaSink {
  constructor(private readonly pool: Pool) {}

  async enregistrer(phoneNumberId: string, t: TarifMeta): Promise<void> {
    await this.pool.query(
      `insert into tarifs_meta (tenant_id, wamid, type, categorie, facturable, modele)
       select pn.tenant_id, $2, $3, $4, $5, $6 from phone_numbers pn where pn.id = $1
       on conflict (tenant_id, wamid) do nothing`,
      [phoneNumberId, t.messageId, t.type, t.categorie, t.facturable, t.modele],
    );
  }
}
