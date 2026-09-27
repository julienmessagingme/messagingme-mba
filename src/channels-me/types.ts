import { z } from 'zod';

/**
 * Les types de l'intégration Channels Me, et les schémas Zod qui valident ce qui vient de chez eux :
 *  1. une réponse 200 dont le corps n'a pas la forme attendue n'est pas un succès : un identifiant absent
 *     finirait vide dans `channelsme_posts.cm_message_id`, seule trace qui relie un post publié à son lien ;
 *  2. les objets retirent les clés inconnues : un champ ajouté chez eux ne casse pas la console et ne
 *     traverse pas jusqu'à nos écrans ;
 *  3. 🔴 `Connexion` porte les deux secrets, `ConnexionPublique` non : le compilateur refuse de servir le
 *     premier à un navigateur.
 */

/**
 * Les quatre identifiants d'une connexion Channels Me, en mémoire uniquement (`getSecrets()`, consommé par
 * `ChannelsMeClient`), jamais sérialisés vers le client.
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
 * Un identifiant rendu par Channels Me : chaîne ou entier selon la ressource (API Rails). On range toujours
 * une chaîne, pour que le reste du code n'ait qu'une forme à connaître.
 */
const identifiant = z.union([z.string(), z.number()]).transform((v) => String(v));

/**
 * L'organisation, lue par `GET /organisations/{org}`. Aucun champ obligatoire : l'écran d'état doit
 * s'afficher même si le fournisseur en omet un. Un champ présent mais du mauvais type reste refusé.
 */
export const organisationSchema = z.object({
  id: identifiant.optional(),
  name: z.string().optional(),
  /**
   * Le quota mensuel, mesuré sur l'organisation réelle : il vit sur l'organisation, pas sur la chaîne.
   * Optionnel, comme le reste : un champ retiré par le fournisseur ne doit pas casser l'écran d'état.
   */
  monthly_messages_count: z.number().int().nonnegative().optional(),
  allowed_message_quota: z.number().int().nonnegative().optional(),
});
export type Organisation = z.infer<typeof organisationSchema>;

/**
 * Une chaîne WhatsApp, lue par `GET /organisations/{org}/message_channels`. `messages_count` est le seul
 * compteur mesuré : un champ déclaré au hasard serait toujours `undefined`, en silence.
 */
export const messageChannelSchema = z.object({
  id: identifiant.optional(),
  name: z.string().optional(),
  messages_count: z.number().int().nonnegative().optional(),
});
export type MessageChannel = z.infer<typeof messageChannelSchema>;

/**
 * Une publication. `id` est le seul champ obligatoire : c'est lui qu'on écrit dans
 * `channelsme_posts.cm_message_id`, et une réponse 200 sans identifiant est un échec. Le statut reste
 * tolérant : lu en direct à chaque affichage, une forme inattendue doit dégrader l'affichage, pas casser la
 * liste.
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
