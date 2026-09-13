import type { Pool } from 'pg';
import type { LangueConsole } from './traduire';

/**
 * OU SE RANGE UNE TRADUCTION, et comment on apprend la langue d'un contact (migration 0137).
 *
 * 🔴 LA JOINTURE SUR `conversations` N'EST PAS DECORATIVE, c'est LE controle d'isolation.
 * `conversation_messages` ne porte pas de `tenant_id` : sans passer par sa conversation, un
 * identifiant de message devine permettrait d'ecrire dans le fil d'un AUTRE client. La RLS est
 * contournee (pooler superuser), donc ce filtre est le seul controle, comme partout ailleurs dans ce
 * depot. Meme forme que `lireMessagePourTranscription` (src/inbox/store.pg.ts).
 *
 * ⚠️ Module a part plutot qu'une methode de plus sur `PgInboxStore` : celui-ci passe les deux mille
 * lignes, et ces deux ecritures n'ont aucun etat en commun avec lui.
 */
export class PgTraductionStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Range les traductions d'un lot, EN UNE SEULE requete.
   *
   * ⚠️ UNE REQUETE PAR MESSAGE SERAIT QUARANTE ALLERS-RETOURS sur le chemin d'ouverture d'un fil,
   * c'est-a-dire sur un ecran que l'operateur attend. `unnest` de trois tableaux paralleles fait le
   * meme travail en un aller, et le pilote `pg` sait envoyer un tableau sans le concatener a la main.
   *
   * ⚠️ `conversation_id` s'ajoute au `where` QUAND L'APPELANT EN A UN : la traduction d'un fil est
   * calculee a l'ouverture d'UNE conversation, l'ecrire ailleurs voudrait dire qu'on s'est trompe de
   * fil. Ce n'est pas une faille (le filtre d'espace la porte entierement), c'est une garde contre
   * une erreur de cablage qui ne se verrait jamais autrement. La transcription d'un vocal, elle,
   * n'a qu'un identifiant de message et passe `null` : meme forme que `lireMessagePourTranscription`.
   */
  async ranger(
    tenantId: string,
    /**
     * ⚠️ `null` = « n'importe quelle conversation DE CET ESPACE », pour l'appelant qui n'a qu'un
     * identifiant de message (la transcription d'un vocal). L'isolation ne bouge pas d'un iota :
     * c'est la jointure sur `conversations` et `c.tenant_id` qui la porte, et elle reste.
     */
    conversationId: string | null,
    traductions: Array<{ messageId: string; texte: string; langue: LangueConsole }>,
  ): Promise<void> {
    if (traductions.length === 0) return;
    await this.pool.query(
      `update conversation_messages m
          set traduction = v.texte, traduction_langue = v.langue
         from unnest($3::uuid[], $4::text[], $5::text[]) as v(id, texte, langue),
              conversations c
        where m.id = v.id
          and c.id = m.conversation_id
          and c.tenant_id = $1
          and ($2::uuid is null or m.conversation_id = $2::uuid)`,
      [
        tenantId,
        conversationId,
        traductions.map((t) => t.messageId),
        traductions.map((t) => t.texte),
        traductions.map((t) => t.langue),
      ],
    );
  }

  /**
   * Apprend la langue du contact d'une conversation.
   *
   * ⚠️ LA DATE EST TOUJOURS REECRITE, y compris quand la langue ne change pas : meme forme que
   * `creerNoteurJoignabilite` (0133). Une mesure fraiche qui garderait une vieille date ferait
   * paraitre perime un constat qu'on vient de refaire.
   *
   * ⚠️ Une conversation sans contact rattache (`contact_id` null) n'ecrit rien, et c'est silencieux
   * par construction : il n'y a pas de fiche ou ranger la langue, ce n'est pas un echec.
   */
  async apprendreLangueContact(tenantId: string, conversationId: string, langue: string): Promise<void> {
    await this.pool.query(
      `update contacts ct
          set langue_detectee = $3, langue_detectee_le = now()
         from conversations c
        where c.id = $2 and c.tenant_id = $1
          and ct.id = c.contact_id and ct.tenant_id = $1`,
      [tenantId, conversationId, langue],
    );
  }
}
