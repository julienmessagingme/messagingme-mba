'use client';

import { request } from './http';

/**
 * Chaîne WhatsApp (Channels Me) : publier un post à toute une audience, dont le bouton « Discuter » démarre
 * un scénario de la console.
 *
 * ⚠️ Module importé EN DIRECT (`@/lib/api-chaine`), jamais ajouté au barrel `lib/api.ts`. Deux familles
 * cohabitent dans ce dépôt et ce n'est pas un accident : `lib/api/*` est l'éclatement de l'historique
 * `api.ts`, que 67 fichiers importent, et `lib/api-*.ts` (`api-mba`, `api-agent`, `api-agent-tools`) porte
 * les surfaces qui ont leur propre vocabulaire et leur propre cycle de vie. Channels Me est du second cas.
 *
 * 🔴 LES CHEMINS SONT ÉCRITS UNE SEULE FOIS, dérivés de `base()`. Au lot précédent, un écran tapait
 * `/connexion` quand le serveur montait `/connection` : rien ne le signalait, ni le compilateur (un chemin
 * est une chaîne), ni un test de composant, seulement un 404 découvert à l'écran.
 *
 * 🔴 AUCUNE FONCTION D'ICI NE RATTRAPE UNE ERREUR. `request` lève une `ApiError` sur tout ce qui n'est pas
 * 2xx, et l'écran l'affiche. C'est important pour `testerConnexionChaine` en particulier : le serveur
 * répond 422 quand les identifiants sont refusés, donc l'échec arrive par une exception, jamais par un
 * `{ ok: false }` qu'on pourrait tester.
 */

const base = (tenantId: string): string => `/tenants/${tenantId}/channels-me`;

// --- Les formes rendues par le serveur ------------------------------------------------------------

/**
 * La connexion telle que l'API la sert. Les deux secrets n'y sont que des booléens : une clé ne redescend
 * jamais en clair vers le navigateur, l'écran affiche « une clé est enregistrée », pas la clé.
 */
export interface ConnexionPubliqueChaine {
  orgId: string;
  channelId: string;
  hasApiKey: boolean;
  hasSecret: boolean;
  verifiedAt: string | null;
}

/**
 * L organisation, et son quota mensuel de publications.
 *
 * ⚠️ Le quota vit ICI, pas sur la chaine : on l avait cherche sur `message_channels`, pas trouve, et conclu
 * qu il n existait pas. Mesure le 2026-09-07 (5 sur 10000). Les deux champs restent facultatifs.
 */
export interface OrganisationChaine {
  id?: string;
  name?: string;
  monthly_messages_count?: number;
  allowed_message_quota?: number;
}

/**
 * Une chaîne WhatsApp chez le fournisseur.
 *
 * `messages_count` est le total des publications de CETTE chaîne. Le quota mensuel, lui, est porté par
 * l'organisation (`OrganisationChaine`), pas ici. Les noms gardent la casse du fournisseur, comme les
 * schémas Zod du serveur.
 */
export interface ChaineDistante {
  id?: string;
  name?: string;
  messages_count?: number;
}

/**
 * Une publication chez le fournisseur, LUE EN DIRECT à chaque affichage. Rien n'en est miroité chez nous,
 * donc il n'y a rien à resynchroniser, et une forme inattendue doit dégrader l'affichage, pas le casser.
 */
export interface MessageChaine {
  id: string;
  kind?: string;
  text?: string | null;
  media_url?: string | null;
  status?: string | null;
  published_at?: string | null;
  is_draft?: boolean;
}

/**
 * Le tiers est-il joignable ? Trois valeurs, et pas une de plus.
 *
 * `injoignable` n'est PAS `non_configuree` : une connexion enregistrée reste visible quand le fournisseur
 * est muet, sinon l'écran laisserait croire qu'il n'y a rien de provisionné et le client ressaisirait des
 * identifiants qui sont bons.
 */
export type EtatDistant = 'non_configuree' | 'injoignable' | 'ok';

export interface ReponseConnexionChaine {
  connection: ConnexionPubliqueChaine | null;
  organisation: OrganisationChaine | null;
  channels: ChaineDistante[];
  distant: EtatDistant;
}

/**
 * Un lien de chaîne : la PHRASE qui, envoyée par un abonné, démarre un scénario.
 *
 * ⚠️ C'était le JETON jusqu'au 2026-09-07 (le texte envoyé était `phrase (cm-xxxx)`). Le champ `token`
 * existe toujours, il reste l'identifiant unique du lien et il vit dans les posts déjà publiés, mais il ne
 * déclenche plus rien : c'est la phrase qui est le mot-clé, comparée en mode « contient ».
 *
 * 🔴 `texteRempli` et `waMeUrl` sont composés PAR LE SERVEUR, et le front ne les recompose jamais. Une
 * adresse `wa.me` part dans des messages publics irrattrapables ; deux compositions de la même adresse
 * divergeraient au premier ajustement, et la seconde partirait quand même.
 */
export interface LienChaine {
  id: string;
  tenantId: string;
  workflowId: string;
  startNodeId: string | null;
  token: string;
  phrase: string;
  automationId: string | null;
  /** Plafond horaire propre à ce lien. `null` veut dire « plafond global de l'instance », pas « zéro ». */
  maxParHeure: number | null;
  createdAt: string;
  /** La PHRASE seule : le message que l'abonné enverra en appuyant sur le bouton. */
  texteRempli: string;
  /** `null` quand aucun numéro WhatsApp n'est connecté : il n'y a alors aucun bouton possible. */
  waMeUrl: string | null;
  /**
   * Le lien déclenche-t-il ? `null` veut dire « plus d'automation compagnon », PAS « éteint » : c'est le cas
   * que `/enable` et `/disable` refusent tous les deux en 409.
   */
  enabled: boolean | null;
}

export interface PostChaine {
  id: string;
  tenantId: string;
  /** Identifiant du message CHEZ le fournisseur, pas chez nous. */
  cmMessageId: string;
  linkId: string | null;
  createdAt: string;
  /** Le statut lu en direct. `null` quand le fournisseur est muet, ou qu'il ne connaît plus ce message. */
  message: MessageChaine | null;
}

/**
 * Ce qui a raté APRÈS que le post soit parti.
 *
 * 🔴 Un post publié circule pour toujours. Ces trois cas arrivent avec un **201**, jamais avec une erreur :
 * faire croire à un échec pousserait à republier, c'est-à-dire à envoyer le même message une seconde fois à
 * toute l'audience.
 */
export type AvertissementPost = 'automation_non_allumee' | 'trace_manquante' | 'reponse_inattendue';

export interface ReponsePublication {
  post: { cmMessageId: string | null; linkId: string | null };
  avertissements?: AvertissementPost[];
}

// --- Les dix appels -------------------------------------------------------------------------------

export function getConnexionChaine(tenantId: string): Promise<ReponseConnexionChaine> {
  return request<ReponseConnexionChaine>(`${base(tenantId)}/connection`);
}

/**
 * Remplacement COMPLET, et non un patch : l'écran ne peut pas renvoyer ce qu'il n'a jamais eu (les deux
 * secrets ne redescendent jamais), donc « changer la clé » veut dire ressaisir les quatre champs.
 */
export function enregistrerConnexionChaine(
  tenantId: string,
  c: { orgId: string; channelId: string; apiKey: string; secret: string },
): Promise<{ connection: ConnexionPubliqueChaine | null }> {
  return request(`${base(tenantId)}/connection`, { method: 'PUT', body: JSON.stringify(c) });
}

/**
 * Deux lectures chez le fournisseur, jamais une écriture : ce bouton ne publie rien.
 *
 * 🔴 Ne rend JAMAIS un échec. Des identifiants refusés sortent en 422, donc en `ApiError` : l'appelant
 * doit l'attraper. Un `if (!res.ok)` ne verrait jamais rien.
 */
export function testerConnexionChaine(
  tenantId: string,
): Promise<{ ok: true; organisation: OrganisationChaine | null; channels: ChaineDistante[] }> {
  return request(`${base(tenantId)}/connection/test`, { method: 'POST' });
}

/** `phone` est le numéro WhatsApp affiché du tenant : `null` = aucun numéro, donc aucun bouton possible. */
export function listerLiensChaine(tenantId: string): Promise<{ links: LienChaine[]; phone: string | null }> {
  return request(`${base(tenantId)}/links`);
}

export function creerLienChaine(
  tenantId: string,
  input: { workflowId: string; startNodeId?: string | null; phrase: string; maxParHeure?: number | null },
): Promise<{ link: LienChaine }> {
  return request(`${base(tenantId)}/links`, { method: 'POST', body: JSON.stringify(input) });
}

/**
 * Éteindre plutôt que supprimer : un post publié circule pour toujours, l'extinction est réversible, la
 * suppression laisserait un bouton mort sans trace.
 */
export function eteindreLienChaine(tenantId: string, id: string): Promise<{ ok: true }> {
  return request(`${base(tenantId)}/links/${id}/disable`, { method: 'POST' });
}

/**
 * La contrepartie, et le SEUL chemin de réparation : quand l'allumage automatique d'une publication échoue
 * (avertissement `automation_non_allumee`), le bouton du post est mort et rien d'autre ne le rallume.
 */
export function allumerLienChaine(tenantId: string, id: string): Promise<{ ok: true }> {
  return request(`${base(tenantId)}/links/${id}/enable`, { method: 'POST' });
}

export function listerPostsChaine(tenantId: string): Promise<{ posts: PostChaine[]; distant: EtatDistant }> {
  return request(`${base(tenantId)}/posts`);
}

export function publierPostChaine(
  tenantId: string,
  input: { text: string; mediaUrl?: string; linkId?: string },
): Promise<ReponsePublication> {
  return request(`${base(tenantId)}/posts`, { method: 'POST', body: JSON.stringify(input) });
}

/** Limitée à 3 par minute côté serveur (429 au-delà), et absente du câblage sur certaines instances (503). */
export function demanderActivationChaine(tenantId: string, message?: string): Promise<{ ok: true }> {
  return request(`${base(tenantId)}/activation-request`, {
    method: 'POST',
    body: JSON.stringify({ message: message ?? '' }),
  });
}

// --- Bornes recopiées du serveur ------------------------------------------------------------------

/**
 * Les bornes de saisie, recopiées A LA MAIN depuis les schémas Zod de `src/http/channels-me.ts`
 * (`web/` a son propre tsconfig et n'importe jamais `src/`). Elles sont figées par `api-chaine.test.ts`.
 *
 * ⚠️ Le plan annonçait 60 pour la phrase « la même valeur que le serveur ». C'était faux, le serveur en
 * accepte 300. Un front qui refuse à 61 ce que le serveur accepte à 300 refuse en son nom propre tout en
 * prétendant citer le serveur. Une phrase courte reste un bon conseil : il se donne par un compteur de
 * caractères, pas par un refus.
 */
export const MAX_PHRASE = 300;
export const MAX_TEXTE_POST = 4096;
export const MAX_MEDIA_URL = 2000;

/**
 * Ce qu'un BOUTON de chaîne a produit.
 *
 * 🔴 CE N'EST PAS UN NOMBRE DE CLICS, et le champ ne s'appelle pas ainsi exprès. Un appui sur un lien
 * `wa.me` ouvre WhatsApp sur le téléphone de l'abonné sans jamais traverser nos serveurs : ce geste nous
 * est invisible, et le fournisseur ne le rapporte pas. On compte le message qui arrive ENSUITE.
 *
 * 🔴 ET C'EST PAR BOUTON, PAS PAR PUBLICATION. Deux publications qui partagent un lien envoient exactement
 * le même message : rien de ce qui nous parvient ne dit laquelle a été vue.
 */
export interface ConversationsDunLien {
  linkId: string;
  // ⚠️ JUMEAU SERVEUR : `src/channels-me/conversions.ts`. Le dépôt sépare volontairement les types des deux
  // côtés (même paire que `LienRow`/`LienChaine`, `PostRow`/`PostChaine`), donc les deux se tiennent à la
  // main : un champ ajouté d'un seul côté ne se voit d'aucun compilateur.
  /** Contacts DISTINCTS ayant écrit un message contenant la phrase. Des contacts, pas des messages. */
  contacts: number;
  dernier: string | null;
}

/**
 * Les conversations démarrées par chaque bouton.
 *
 * `partiel` dit que le plafond de lecture a été atteint : les chiffres sont alors des MINIMUMS, et l'écran
 * doit le dire au lieu d'annoncer un total qu'il n'a pas.
 */
export function listerConversationsChaine(
  tenantId: string,
): Promise<{ parLien: ConversationsDunLien[]; partiel: boolean }> {
  return request<{ parLien: ConversationsDunLien[]; partiel: boolean }>(
    `/tenants/${tenantId}/channels-me/links/conversations`,
  );
}
