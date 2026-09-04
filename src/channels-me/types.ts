import { z } from 'zod';

/**
 * Les types de l'integration Channels Me, et les schemas Zod qui valident CE QUI VIENT DE CHEZ EUX.
 *
 * Ce que ces schemas protegent, et qui ne se voit pas a la lecture :
 *  1. Une reponse 200 dont le corps n'a pas la forme attendue n'est PAS un succes. Sans validation, un
 *     identifiant absent partirait tel quel dans `channelsme_posts.cm_message_id` : la seule trace qui
 *     relie un post publie (qui circule pour toujours) au lien qui l'a produit serait vide, sans recours.
 *  2. Les objets de ce fichier RETIRENT les cles inconnues au lieu de les refuser. Un champ ajoute chez eux
 *     ne doit pas casser la console, mais il ne doit pas non plus traverser jusqu'a nos ecrans.
 *  3. `Connexion` porte les deux secrets, `ConnexionPublique` ne les porte pas. Les deux existent pour que
 *     le compilateur refuse de servir le premier a un navigateur.
 */

/**
 * Les quatre identifiants d'une connexion Channels Me.
 *
 * En memoire uniquement, jamais serialise vers le client : c'est ce que le store rend par `getSecrets()`,
 * et c'est ce que `ChannelsMeClient` consomme.
 */
export interface Connexion {
  orgId: string;
  channelId: string;
  apiKey: string;
  secret: string;
}

/**
 * La projection servie par l'API. Les deux secrets n'y sont que des booleens : un secret ne redescend
 * jamais en clair vers le front, l'ecran affiche « une cle est enregistree », pas la cle.
 */
export interface ConnexionPublique {
  orgId: string;
  channelId: string;
  hasApiKey: boolean;
  hasSecret: boolean;
  verifiedAt: string | null;
}

/**
 * Un identifiant rendu par Channels Me. Leur API est en Rails : selon la ressource, un identifiant sort en
 * chaine ou en entier. On accepte les deux et on range TOUJOURS une chaine, pour que le reste du code
 * (colonne `cm_message_id text`, comparaisons, construction d'URL) n'ait qu'une seule forme a connaitre.
 */
const identifiant = z.union([z.string(), z.number()]).transform((v) => String(v));

/**
 * L'organisation, lue par `GET /organisations/{org}`.
 *
 * Aucun champ n'est obligatoire : aucun n'a ete mesure comme tel, et l'ecran d'etat de la connexion doit
 * s'afficher meme si le fournisseur en omet un. Un champ present mais du mauvais type reste refuse.
 */
export const organisationSchema = z.object({
  id: identifiant.optional(),
  name: z.string().optional(),
});
export type Organisation = z.infer<typeof organisationSchema>;

/**
 * Une chaine WhatsApp, lue par `GET /organisations/{org}/message_channels`.
 *
 * `messages_count` est le seul compteur MESURE (85 publications sur la chaine de demo, et la liste des
 * messages en rend bien 85). Les champs de quota mensuel ne sont pas encore mesures : les declarer au
 * hasard les rendrait toujours `undefined`, en silence, ce qui est pire que de ne pas les avoir.
 */
export const messageChannelSchema = z.object({
  id: identifiant.optional(),
  name: z.string().optional(),
  messages_count: z.number().int().nonnegative().optional(),
});
export type MessageChannel = z.infer<typeof messageChannelSchema>;

/**
 * Une publication.
 *
 * 🔴 `id` est le SEUL champ obligatoire, et il l'est vraiment : c'est lui qu'on ecrit dans
 * `channelsme_posts.cm_message_id`. Une reponse 200 sans identifiant est un ECHEC, pas un succes au champ
 * vide. Le statut reste optionnel et tolerant : il se LIT EN DIRECT a chaque affichage, on ne le miroite
 * pas, donc une forme inattendue doit degrader l'affichage, pas casser la lecture de la liste.
 */
export const messageSchema = z.object({
  id: identifiant,
  kind: z.string().optional(),
  text: z.string().nullable().optional(),
  media_url: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  is_draft: z.boolean().optional(),
});
export type Message = z.infer<typeof messageSchema>;
