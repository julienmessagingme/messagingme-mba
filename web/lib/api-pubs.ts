'use client';

import { request } from './http';

/**
 * Publicités Click-to-WhatsApp : la CONNEXION d'un espace à son compte publicitaire Meta (lot 2).
 *
 * ⚠️ Module importé EN DIRECT (`@/lib/api-pubs`), jamais ajouté au barrel `lib/api.ts` : même famille que
 * `api-chaine`, `api-mba` et `api-agent`, les surfaces qui ont leur propre vocabulaire.
 *
 * 🔴 LES CHEMINS SONT ÉCRITS UNE SEULE FOIS, dérivés de `base()`. Un écran qui tapait `/connexion` quand le
 * serveur montait `/connection` n'a été démenti ni par le compilateur ni par un test, seulement par un 404
 * découvert à l'écran (leçon de Channels Me).
 */

const base = (tenantId: string): string => `/tenants/${tenantId}/pubs/connexion`;

/** L'état de la liaison entre la Page et le compte WhatsApp. `null` = aucun choix fait pour l'instant. */
export type LiaisonPage = 'oui' | 'non' | 'inconnu';

export interface ConnexionPubVue {
  comptePubId: string | null;
  /** Nom vu chez Meta au moment du choix (migration 0169). Peut manquer : on retombe sur l'identifiant. */
  compteNom: string | null;
  pageId: string | null;
  pageNom: string | null;
  devise: string | null;
  fuseau: string | null;
  pageLiee: LiaisonPage | null;
  connectePar: string | null;
  connecteLe: string;
  /** Meta a refusé ce jeton : la ligne RESTE, pour que l'écran dise « reconnectez-vous » et pas « jamais connecté ». */
  jetonRejeteLe: string | null;
}

/**
 * Ce qui empêche, ou non, de diffuser. Lu EN DIRECT chez Meta à chaque ouverture de l'écran.
 *
 * 🔴 `null` côté `EtatPubs.compte` n'est PAS « tout va bien » : c'est « nous n'avons pas pu demander ».
 */
export interface EtatComptePub {
  statut: number | null;
  raisonDesactivation: number | null;
  moyenPaiement: boolean;
}

export interface EtatPubs {
  /** `META_ADS_CONFIG_ID` est renseignée côté serveur. Faux = fonctionnalité éteinte sur cette instance. */
  configure: boolean;
  configId: string;
  appId: string;
  graphVersion: string;
  connexion: ConnexionPubVue | null;
  /**
   * 🔴 OPTIONNEL, ET CE N'EST PAS DE LA PRUDENCE : L'API DÉPLOYÉE PEUT NE PAS ENCORE LE PORTER.
   * Vercel publie cette console à chaque `git push`, l'API attend son `up -d --build` : entre les deux,
   * la réponse n'a pas cette clé. Le déclarer non optionnel ferait mentir le type pendant cette fenêtre,
   * et un lecteur qui écrirait `=== null` tomberait sur `undefined`. En le déclarant ainsi, c'est le
   * COMPILATEUR qui force chaque lecteur à traiter l'absence, au lieu de compter sur qui s'en souvient.
   */
  compte?: EtatComptePub | null;
}

/**
 * Ce que la connexion accorde, lu par le serveur à `GET /me/adaccounts` et `GET /me/accounts`.
 *
 * ⚠️ LES NOMS VIENNENT DE META, et c'est ce qui rend le choix possible : un admin reconnaît « GMC »,
 * pas `2084133708982860`. Ils peuvent manquer, d'où le `null` et le repli sur l'identifiant.
 */
export interface ComptePubAccorde {
  id: string;
  nom: string | null;
  devise: string | null;
  fuseau: string | null;
  /** `account_status` de Meta : 1 = actif. Tout le reste empêche de diffuser. */
  statut: number | null;
}

export interface PageAccordee {
  id: string;
  nom: string | null;
}

export interface ActifsAccordes {
  comptesPub: ComptePubAccorde[];
  pages: PageAccordee[];
}

export function getEtatPubs(tenantId: string): Promise<EtatPubs> {
  return request<EtatPubs>(base(tenantId));
}

/** Échange le code rendu par la fenêtre Meta. Rend ce que le jeton accorde, pour que l'admin choisisse. */
export function echangerCodePub(tenantId: string, code: string): Promise<ActifsAccordes> {
  return request<ActifsAccordes>(`${base(tenantId)}/echange`, { method: 'POST', body: JSON.stringify({ code }) });
}

export function choisirActifsPub(tenantId: string, choix: { comptePubId: string; pageId: string }): Promise<{ connexion: ConnexionPubVue }> {
  return request<{ connexion: ConnexionPubVue }>(`${base(tenantId)}/choix`, { method: 'POST', body: JSON.stringify(choix) });
}

/**
 * Déconnecte, après avoir TENTÉ de retirer nos accès chez Meta.
 *
 * 🔴 `revoqueChezMeta` N'EST PAS AFFICHÉ, et c'est une décision de Julien (2026-09-23), pas un oubli.
 * Le jeton résiduel n'est détenu par PERSONNE : nous venons de supprimer notre seule copie, aucun tiers
 * ne l'a jamais eue. Avertir reviendrait à inquiéter un client pour un accès que nul ne peut exercer,
 * et les gestes qu'on pourrait lui prescrire cassent chacun quelque chose : retirer l'application
 * couperait son numéro WhatsApp (c'est la MÊME application), et retirer les permissions publicitaires
 * désarmerait sa connexion s'il s'est reconnecté entre-temps.
 *
 * ⚠️ CE COMMENTAIRE DISAIT L'INVERSE jusqu'au 2026-09-23 (« l'écran doit alors dire au client de retirer
 * les PERMISSIONS PUBLICITAIRES »), et une relecture s'est appuyée dessus pour faire réécrire le bandeau
 * qui venait d'être retiré. Une justification fausse est pire qu'aucune : elle est recopiée, puis elle
 * sert de preuve. Ce que le booléen sert, c'est à MESURER dans le journal si le retrait fonctionne sur
 * un jeton d'utilisateur système.
 */
export function deconnecterPubs(tenantId: string): Promise<{ ok: true; revoqueChezMeta: boolean }> {
  return request<{ ok: true; revoqueChezMeta: boolean }>(base(tenantId), { method: 'DELETE' });
}

/* ── Lot 3 : les publicités elles-mêmes ─────────────────────────────────────────────────────────── */

/** Où vont les prospects de cette publicité. Exclusif : l'un OU l'autre, jamais les deux. */
export type DestinationPub = 'scenario' | 'agent_meta';

/**
 * L'état LOCAL d'une publicité, le nôtre. Il ne se confond pas avec `statutMeta`, qui vient de Meta.
 *
 * `creation` : les appels sont en cours. `echec_creation` : une étape a échoué et la campagne n'a pas pu
 * être supprimée chez Meta, donc quelque chose y subsiste, EN PAUSE. `prete` : tout est créé, tout est en
 * pause, rien ne dépense. `publiee` : l'automation est allumée et Meta diffuse.
 */
export type EtatPublicite = 'creation' | 'echec_creation' | 'prete' | 'publiee';

export interface Publicite {
  id: string;
  campagneId: string;
  ensembleId: string | null;
  creaId: string | null;
  pubId: string | null;
  nom: string;
  etat: EtatPublicite;
  /** `effective_status` de Meta, tel quel. `null` = le suivi n'a encore rien lu, PAS « tout va bien ». */
  statutMeta: string | null;
  motifRefus: string | null;
  budgetTotal: number | null;
  debut: string | null;
  fin: string | null;
  destination: DestinationPub;
  workflowId: string | null;
  tagQualification: string | null;
  automationId: string | null;
  depense: number | null;
  clics: number | null;
  luLe: string | null;
  creeLe: string;
}

/**
 * Une étape de l'entonnoir.
 *
 * 🔴 `null` VEUT DIRE « NON DISPONIBLE », JAMAIS ZÉRO, et l'écran doit l'écrire ainsi. Zéro prospect ne
 * donne pas un coût par prospect de zéro : il n'en donne aucun. Afficher « 0 € » là où l'on ne sait pas
 * ressemble au meilleur résultat imaginable, sur l'écran qui sert à décider d'arrêter ou de remettre du
 * budget. Le calcul, lui, est fait côté serveur (`src/pubs/entonnoir.ts`), pas ici.
 */
export interface EtapeEntonnoir {
  nombre: number | null;
  cout: number | null;
  /** Part de l'étape précédente qui arrive ici, entre 0 et 1. */
  passage: number | null;
}

export interface Entonnoir {
  depense: number | null;
  clics: EtapeEntonnoir;
  leads: EtapeEntonnoir;
  qualifies: EtapeEntonnoir;
  /** Prospects reçus mais non pris en charge : reprise refusée, désabonnés, bloqués. Des clics payés. */
  nonPrisEnCharge: number;
}

/** Ce que le formulaire envoie. Les bornes sont vérifiées côté serveur, qui reste la seule autorité. */
export interface FormulaireCreationPub {
  nom: string;
  texte: string;
  titre: string;
  messagePreRempli: string;
  accueil: string;
  budgetTotal: number;
  debut: string;
  fin: string;
  pays: string[];
  villes: Array<{ cle: string; rayon: number; unite: 'kilometer' | 'mile' }>;
  ageMin: number;
  ageMax: number;
  destination: DestinationPub;
  workflowId: string | null;
  tagQualification: string | null;
  /** Doit valoir `true` : le serveur refuse tout le reste. Une catégorie spéciale passe par le Gestionnaire. */
  horsCategorieSpeciale: true;
  image: { type: 'image/jpeg' | 'image/png'; base64: string };
}

/**
 * LES BORNES DU VISUEL, ANNONCÉES PAR L'ÉCRAN.
 *
 * 🔴 ELLES DOIVENT ÉGALER CELLES DU SERVEUR (`TAILLE_VISUEL_PUB_MAX`, `TYPES_VISUEL_PUB`), et c'est un test
 * de parité qui le tient (`tests/web-pubs-parity.test.ts`). Deux chiffres qui divergent donnent le pire des
 * deux : un écran qui promet ce que le serveur refuse, avec un 413 ou un 400 que personne ne relie à la
 * promesse. L'écran refuse AVANT de téléverser, le serveur refuse en dernier ressort, et lui seul protège.
 */
export const TAILLE_VISUEL_MAX = 5 * 1024 * 1024;
export const TYPES_VISUEL = ['image/jpeg', 'image/png'] as const;

const basePubs = (tenantId: string): string => `/tenants/${tenantId}/pubs`;

export function listerPubs(tenantId: string): Promise<{ publicites: Publicite[] }> {
  return request<{ publicites: Publicite[] }>(basePubs(tenantId));
}

export function lirePub(tenantId: string, id: string): Promise<{ publicite: Publicite; entonnoir: Entonnoir }> {
  return request<{ publicite: Publicite; entonnoir: Entonnoir }>(`${basePubs(tenantId)}/${id}`);
}

/**
 * Crée la publicité chez Meta, TOUT EN PAUSE. Cet appel ne fait dépenser personne.
 *
 * ⚠️ Un refus de Meta remonte en `ApiError` avec SON message : on le montre tel quel, c'est le compte du
 * client et lui seul peut agir dessus. Pas de reformulation, pas de repli silencieux.
 */
export function creerPub(tenantId: string, f: FormulaireCreationPub): Promise<{ publiciteId: string; campagneId: string }> {
  return request<{ publiciteId: string; campagneId: string }>(basePubs(tenantId), { method: 'POST', body: JSON.stringify(f) });
}

/** PUBLIER : le seul geste qui engage le budget. Le serveur allume l'automation AVANT Meta. */
export function publierPub(tenantId: string, id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`${basePubs(tenantId)}/${id}/publier`, { method: 'POST' });
}

export function basculerPub(tenantId: string, id: string, actif: boolean): Promise<{ ok: true }> {
  return request<{ ok: true }>(`${basePubs(tenantId)}/${id}/${actif ? 'reprendre' : 'pause'}`, { method: 'POST' });
}
