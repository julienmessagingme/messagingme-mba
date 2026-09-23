import type { Pool } from 'pg';
import type { PubDuLead } from './routage';

/**
 * LES PUBLICITÉS D'UN ESPACE (`publicites`) ET LA CORRESPONDANCE PUB VERS CAMPAGNE (`pubs_connues`),
 * migration 0170.
 *
 * 🔴 `tenant_id = $1` SUR CHAQUE REQUÊTE, sans exception. La connexion au pooler est un rôle superuser, donc
 * la RLS est contournée : ce filtrage EST le contrôle d'isolation, pas une ceinture en plus.
 *
 * ⚠️ CE FICHIER EST SUR LE CHEMIN CHAUD DES MESSAGES ENTRANTS, par `pubDeLaCampagne` et `campagneConnue` :
 * deux requêtes sur clé, aucune jointure, aucun appel à Meta. Tout ce qui parle à Meta vit ailleurs.
 */
export class PgPublicitesStore {
  constructor(private readonly pool: Pool) {}

  /**
   * La publicité que NOUS pilotons pour cette campagne Meta, ou `null`.
   *
   * ⚠️ AUCUN FILTRE SUR L'ÉTAT, et c'est délibéré. Cette ligne dit l'INTENTION du client (« les leads de
   * cette campagne vont à ce scénario ») ; router selon l'intention est juste quelle que soit l'étape où en
   * est la pub. Filtrer sur `etat = 'publiee'` ferait exactement le contraire de ce qu'on veut dans le seul
   * cas où l'écart existe : une pub qu'on a créée en pause et que le client a activée depuis le Gestionnaire
   * enverrait alors ses leads dans « toutes les pubs », c'est-à-dire n'importe où.
   */
  async pubDeLaCampagne(tenantId: string, campagneId: string): Promise<PubDuLead | null> {
    const { rows } = await this.pool.query<{ campagne_id: string; destination: string; automation_id: string | null }>(
      `select campagne_id, destination, automation_id
         from publicites where tenant_id = $1 and campagne_id = $2`,
      [tenantId, campagneId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    // Le CHECK de 0170 borne la colonne à deux valeurs. On le revérifie quand même ici : une valeur écrite à
    // la main en base ne doit pas devenir une destination inventée sur le chemin chaud, elle doit rendre
    // « campagne inconnue », donc le comportement d'avant ce lot.
    if (r.destination !== 'scenario' && r.destination !== 'agent_meta') return null;
    return { campagneId: r.campagne_id, destination: r.destination, automationId: r.automation_id };
  }

  /** La campagne de cette publicité, d'après ce qu'on a déjà mémorisé. `null` = jamais vue. */
  async campagneConnue(tenantId: string, adId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ campagne_id: string }>(
      'select campagne_id from pubs_connues where tenant_id = $1 and ad_id = $2',
      [tenantId, adId],
    );
    return rows[0]?.campagne_id ?? null;
  }

  /**
   * Mémorise « cette publicité appartient à cette campagne ».
   *
   * ⚠️ `do nothing` PLUTÔT QUE `do update` : chez Meta, une pub ne change jamais de campagne. Réécrire
   * laisserait croire le contraire, et ferait du dernier appel qui gagne la règle d'un fait immuable.
   */
  async memoriserPub(tenantId: string, adId: string, campagneId: string): Promise<void> {
    await this.pool.query(
      `insert into pubs_connues (tenant_id, ad_id, campagne_id) values ($1, $2, $3)
       on conflict (tenant_id, ad_id) do nothing`,
      [tenantId, adId, campagneId],
    );
  }
}
