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
