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

export interface EtatPubs {
  /** `META_ADS_CONFIG_ID` est renseignée côté serveur. Faux = fonctionnalité éteinte sur cette instance. */
  configure: boolean;
  configId: string;
  appId: string;
  graphVersion: string;
  connexion: ConnexionPubVue | null;
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
 * Déconnecte. `revoqueChezMeta` à false = notre accès VIT ENCORE chez Meta et nous n'en avons plus la
 * trace : l'écran doit alors dire au client de retirer les PERMISSIONS PUBLICITAIRES de notre
 * application, et surtout pas l'application elle-même, qui porte aussi son numéro WhatsApp.
 *
 * ⚠️ À `true`, le retrait a réussi pour les trois permissions publicitaires, et TROIS AUTRES restent en
 * place, délibérément (elles sont partagées avec WhatsApp). L'écran le dit aussi : un succès muet
 * laisserait croire que tout est fermé.
 */
export function deconnecterPubs(tenantId: string): Promise<{ ok: true; revoqueChezMeta: boolean }> {
  return request<{ ok: true; revoqueChezMeta: boolean }>(base(tenantId), { method: 'DELETE' });
}
