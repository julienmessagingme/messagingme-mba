import type { Pool } from 'pg';
import type { TarifMeta, TarifsMetaSink } from '../webhooks/tarif-meta';

/**
 * L'écriture des tarifs de Meta (`tarifs_meta`). L'espace se résout par le numéro destinataire de l'accusé,
 * dans la même requête : un numéro inconnu n'écrit rien. Le premier accusé qui porte un tarif gagne (Meta
 * répète le même `pricing` sur sent, delivered et read).
 *
 * Coût accepté : jusqu'à trois tentatives par message sortant sur la file sérialisée des accusés, dont deux
 * écartées par le conflit (une recherche par clé primaire). Si cette file ralentit, le levier est ici.
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
