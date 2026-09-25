'use client';

/**
 * Le compte : profil, statut WhatsApp, import HubSpot, exploitation /ops, support, admin.
 *
 * Sorti de `lib/api.ts` le 2026-09-01 (lot 5 du programme II), qui pesait 1 874 lignes. Le socle HTTP
 * (`./http`) etait deja extrait : ce decoupage-ci ne separe que des surfaces d'appel, sans etat partage.
 * `lib/api.ts` reste le point d'entree et reexporte tout, donc AUCUN des 67 importeurs ne change.
 */

import { request, ApiError, BASE } from '../http';
import type { LoginResult } from './auth';
import type { ImportReport } from './contacts';
// La grille de prix : le TYPE vit avec les autres types de stats, les deux appels d'exploitation ici.
import type { DailyPoint, GrillePrix } from './stats';

// --- Accueil : profil courant + statut compte WhatsApp ---

export interface MeResponse {
  email: string;
  name: string | null;
  role: string;
}
export function getMe(tenantId: string): Promise<MeResponse> {
  return request<MeResponse>(`/tenants/${tenantId}/me`);
}

export type AccountDot = 'green' | 'amber' | 'red' | 'grey';
export interface AccountStatusResponse {
  hasNumber: boolean;
  /** Id Meta du numéro principal (requis pour le PATCH du toggle HubSpot). */
  phoneNumberId: string | null;
  number: string | null;
  tier: string | null;
  quality: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  numberStatus: string | null;
  nameStatus: string | null;
  codeVerificationStatus: string | null;
  throughputLevel: string | null;
  verifiedName: string | null;
  wabaHealthStatus: string | null;
  accountReviewStatus: string | null;
  businessVerificationStatus: string | null;
  /** Onboarding API MM Lite (marketing_messages_lite_api_status). null = non communiqué par Meta. */
  marketingMessagesLiteApiStatus: string | null;
  /** Business propriétaire du WABA (owner_business_info.name). null = inconnu. */
  ownerBusinessName: string | null;
  /**
   * Photo de profil WhatsApp du numero (la pastille du Business Manager). `null` = aucune photo posee, ou
   * lecture impossible. Optionnel a la lecture : une API plus ancienne que ce champ ne l'envoie pas.
   *
   * ⚠️ L'URL est SIGNEE et EXPIRE : elle vient du serveur a chaque affichage, elle ne se met pas en cache
   * cote navigateur au-dela de la page.
   */
  photoProfilUrl?: string | null;
  hubspotConnected: boolean;
  /** Instant de pause de la synchro (F3-a). null = jamais activé OU actif ; non-null + hubspotConnected=false = en pause. */
  hubspotPausedAt: string | null;
  /** Portail HubSpot lié au tenant (mmhs.tenant_portals). connected=false -> proposer « Connecter HubSpot ».
   *  listsScopeGranted -> le portail a accordé crm.lists.read (import de listes sans re-consentement). */
  hubspotPortal: { connected: boolean; hubId?: string; hubDomain?: string | null; listsScopeGranted?: boolean };
  /**
   * Instant où le numéro a été DÉLIÉ de l'espace (migration 0180, ISO). `null` = relié. OPTIONNEL à la lecture :
   * une API plus ancienne ne l'envoie pas, et l'absence veut dire « relié », ce qu'il était forcément.
   */
  delieLe?: string | null;
  status: { dot: AccountDot; label: string; reason: string };
}
export function getAccountStatus(tenantId: string): Promise<AccountStatusResponse> {
  return request<AccountStatusResponse>(`/tenants/${tenantId}/account-status`);
}
/** Active/coupe/pause la synchro HubSpot d'un numéro (toggle admin). `catchupTriggered` = true si on vient de
 *  reprendre après une pause (le rattrapage des analyses accumulées est en cours côté worker). */
export function setHubspotConnected(tenantId: string, phoneNumberId: string, connected: boolean): Promise<{ phoneNumberId: string; hubspotConnected: boolean; catchupTriggered: boolean }> {
  return request(`/tenants/${tenantId}/phone-numbers/${encodeURIComponent(phoneNumberId)}/hubspot`, {
    method: 'PATCH',
    body: JSON.stringify({ connected }),
  });
}
/** Déconnexion COMPLÈTE (candidat 2) : délie le portail HubSpot du tenant (le connecteur révoque le token si dernier
 *  tenant) et coupe la synchro de TOUS les numéros du tenant. `disconnected:false` = déjà délié (succès idempotent). */
export function disconnectHubspot(tenantId: string, phoneNumberId: string): Promise<{ phoneNumberId: string; hubspotConnected: boolean; disconnected: boolean }> {
  return request(`/tenants/${tenantId}/phone-numbers/${encodeURIComponent(phoneNumberId)}/hubspot`, {
    method: 'PATCH',
    body: JSON.stringify({ connected: false, action: 'disconnect' }),
  });
}
/**
 * Déconnexion COMPLÈTE d'un espace SANS numéro (interrupteur HubSpot, migration 0179). Même geste que
 * `disconnectHubspot`, sans le numéro que cette porte-là exige : un espace neuf peut relier un portail avant
 * d'avoir un numéro, et doit pouvoir le délier.
 */
export function deconnecterHubspotEspace(tenantId: string): Promise<{ hubspotConnected: boolean; disconnected: boolean }> {
  return request(`/tenants/${tenantId}/hubspot/deconnexion`, { method: 'POST', body: JSON.stringify({}) });
}

// --- Import de listes HubSpot (3e source de campagne) ---

export interface HubspotList { listId: string; name: string; size: number | null; processingType: string }
/**
 * Réponse du GET /hubspot/lists : `available:false` si le toggle est OFF (sans reason) OU si la synchro est en pause
 * (`reason:'paused'`, F3-b) ; sinon lists (ou re-consentement requis).
 */
export interface HubspotListsResult {
  available: boolean;
  reason?: 'reconsent_required' | 'paused';
  reconsentUrl?: string;
  lists?: HubspotList[];
}
export function listHubspotLists(tenantId: string, query?: string): Promise<HubspotListsResult> {
  const qs = query ? `?query=${encodeURIComponent(query)}` : '';
  return request<HubspotListsResult>(`/tenants/${tenantId}/hubspot/lists${qs}`);
}
/** Une étape de deal du portail. `closed` = étape de fin (gagné/perdu), signalée à l'écran. */
export interface HubspotDealStage { id: string; label: string; closed: boolean }
export interface HubspotDealPipeline { id: string; label: string; stages: HubspotDealStage[] }
/**
 * Pipelines du portail avec les libellés de leurs étapes, pour régler une automation « étape de deal » sans
 * aller recopier un identifiant opaque dans HubSpot. `connected:false` = aucun portail lié (pas une erreur).
 */
export function listHubspotDealStages(tenantId: string): Promise<{ connected: boolean; pipelines: HubspotDealPipeline[] }> {
  return request(`/tenants/${tenantId}/hubspot/deal-stages`);
}

/**
 * Crée UN contact à la main (le mini-CRM ne savait le faire que par import CSV). `status` dit si le contact a
 * été créé ou si un contact portant ce numéro EXISTAIT déjà et a été mis à jour : l'écran ne doit pas annoncer
 * une création dans le second cas.
 */
export function createContact(
  tenantId: string,
  input: { phone: string; name?: string; fields?: Record<string, string>; tags?: string[]; optIn?: boolean; bsuid?: string },
): Promise<{ status: 'created' | 'updated'; contactId?: string }> {
  return request(`/tenants/${tenantId}/contacts`, { method: 'POST', body: JSON.stringify(input) });
}

/** Importe une liste HubSpot comme contacts (opt-in jamais activé, tag « HubSpot: <nom> »). `tags` = tag(s)
 *  réellement posé(s) par le serveur (source de vérité pour filtrer les contacts importés). */
export function importHubspotList(tenantId: string, listId: string, listName: string): Promise<ImportReport & { truncated: boolean; skippedNoPhone: number; tags: string[] }> {
  return request(`/tenants/${tenantId}/hubspot/import`, { method: 'POST', body: JSON.stringify({ listId, listName }) });
}

// --- Surface d'exploitation cross-tenant (/ops) : token SÉPARÉ (x-ops-token), PAS la session JWT ---

export interface TenantOverviewRow {
  id: string;
  name: string;
  createdAt: string;
  mbaEnabled: boolean;
  users: number;
  contacts: number;
  messages: number;
  templatesUsed: number;
  lastSendAt: string | null;
  phone: string | null;
  phoneStatus: string | null;
  quality: string | null;
}
/**
 * Le plus vieux job en attente d'UN GROUPE de file.
 *
 * ⚠️ Ce que `groupe` designe DEPEND de la file : l'ESPACE client pour `campaign-run` (c'est la que se lit
 * l'equite entre clients), le CONTACT pour `webhook` (« quel contact attend le plus »). Les autres files
 * n'ont pas de groupe et n'apparaissent pas.
 */
export interface QueueGroupLoadRow {
  queue: string;
  groupe: string;
  backlog: number;
  ageMaxSecondes: number;
}

export interface QueueLoadRow {
  queue: string;
  backlog: number;
  /**
   * Age, en secondes, du plus vieux job PRET a partir et pas encore pris. `0` = aucun en attente.
   *
   * 🔴 C'est la mesure qui dit si on tient la cadence : la profondeur, seule, ne le dit pas. Mille jobs
   * avales en trois secondes vont bien, dix jobs qui attendent depuis un quart d'heure vont mal.
   * Optionnel a la lecture : une API plus ancienne ne l'envoie pas, et l'ecran doit alors se taire plutot
   * que d'afficher un zero qui passerait pour « tout va bien ».
   */
  ageMaxSecondes?: number;
  active: number;
  failed: number;
}
/** Signal de vie du worker (item 4.9). null = aucun battement (worker jamais démarré, ou table absente avant
 *  migration 0044). `ageSeconds` élevé = worker probablement mort (crash-loop invisible côté mba-api). */
export interface WorkerHeartbeat {
  beatAt: string;
  bootedAt: string | null;
  instance: string | null;
  ageSeconds: number;
}
export interface OpsOverview {
  tenants: TenantOverviewRow[];
  daily: DailyPoint[];
  queues: QueueLoadRow[];
  /**
   * Les GROUPES qui attendent le plus (equite). Vide quand rien n'attend, ce qui est l'etat normal : cette
   * liste n'existe que pour rendre visible ce qu'une moyenne cache, un espace affame derriere un espace
   * bavard. Optionnelle a la lecture : une API d'avant ne l'envoie pas.
   */
  queuesParGroupe?: QueueGroupLoadRow[];
  /** Peut être absent d'une réponse antérieure au 4.9 -> traité comme null côté page. */
  worker: WorkerHeartbeat | null;
  /**
   * L'état du pool de connexions DE L'API, lu en mémoire. Le worker a le SIEN, invisible d'ici : il ne se lit
   * que dans la courbe agrégée ci-dessous. Optionnel : une API d'avant le lot 7 ne l'envoie pas.
   */
  poolInstantane?: PoolInstantane | null;
  /** La courbe par minute, tous process confondus. Vide tant que la migration 0109 n'est pas passée. */
  attentesPool?: PoolAttentePoint[];
  /**
   * La latence REELLE par file sur 24 h. Optionnelle : une API d'avant ne l'envoie pas.
   *
   * 🔴 A ne pas confondre avec `ageMaxSecondes`, qui est une PHOTO de ce qui attend maintenant. Le document
   * de SLO prenait la photo pour un p95 (« plus severe : s'il tient, le p95 tient ») : c'est faux dans les
   * deux sens, elle ne voit rien d'une lenteur passee et resorbee, et elle ne voyait pas un job coince en
   * traitement. Un objectif de service se verifie sur une DUREE.
   */
  latences?: QueueLatenceRow[];
}

/**
 * La latence d'une file sur une fenetre, calculee sur les jobs terminés.
 *
 * `echantillons` se lit EN PREMIER : un p95 sur trois jobs ne veut rien dire, et la retention de pg-boss
 * decide de ce qui reste lisible. Un p95 sans son effectif est un chiffre qui trompe.
 */
export interface QueueLatenceRow {
  queue: string;
  echantillons: number;
  /** Temps ou PERSONNE ne s'occupait du job : cadence de sondage, ou concurrence saturee. */
  attenteP50Secondes: number;
  attenteP95Secondes: number;
  /** Attente PLUS traitement : ce que l'utilisateur ressent. */
  boutEnBoutP95Secondes: number;
  boutEnBoutMaxSecondes: number;
}

export interface PoolInstantane {
  process: string;
  total: number;
  libres: number;
  /** 🔴 Le seul chiffre qui alarme : non nul, le pool est saturé À CET INSTANT et quelqu'un attend. */
  enAttente: number;
  max: number;
  maxMsDepuisDemarrage: number;
}

/** Une minute d'attente du pool, pour UN process. `attentes` ne compte que les acquisitions faites sur un pool
 *  SATURÉ : ouvrir une connexion neuve coûte quelques millisecondes et n'a rien d'anormal. */
export interface PoolAttentePoint {
  process: string;
  minute: string;
  echantillons: number;
  attentes: number;
  /** Maximum de TOUTES les acquisitions, y compris l'ouverture normale d'une connexion neuve. N'alarme PAS. */
  maxMs: number;
  /** 🔴 Maximum des seules acquisitions faites sur un pool SATURÉ. C'est LUI le signal, et lui seul colore. */
  maxAttenteMs: number;
  moyenneMs: number;
}

/**
 * Appel dédié à /ops : n'utilise NI getSession NI clearSession (un 401 ops ne doit pas déconnecter la
 * console admin), pose seulement `x-ops-token`. Le token est saisi par l'ops et gardé en localStorage.
 */
/**
 * Ouvre une session d'OBSERVATION dans l'espace d'un client (surface d'exploitation).
 *
 * Rend un jeton de session en LECTURE SEULE, valable une heure. Il ne peut rien écrire et ne marque rien
 * comme lu : c'est le SERVEUR qui l'impose, pas l'écran.
 */
export async function observerTenant(opsToken: string, tenantId: string): Promise<{ token: string; tenantId: string; tenantName: string }> {
  // `fetch` direct et non `request` : la surface d'exploitation a sa PROPRE autorité (`x-ops-token`), et
  // `request` y attacherait le jeton de session du client. Même patron que `getOpsOverview` juste en dessous.
  const res = await fetch(`${BASE}/ops/observe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ops-token': opsToken },
    body: JSON.stringify({ tenantId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `Erreur ${res.status}`);
  }
  return res.json() as Promise<{ token: string; tenantId: string; tenantName: string }>;
}
/**
 * LA GRILLE DE PRIX, UNE POUR TOUS LES ESPACES (lot 8, migration 0168).
 *
 * ⚠️ `fetch` DIRECT ET NON `request`, comme ses voisines : la surface d'exploitation a sa PROPRE autorité
 * (`x-ops-token`), et `request` y attacherait le jeton de session du client.
 *
 * ⚠️ LES BORNES VIENNENT DU SERVEUR, l'écran ne les redéclare pas : deux jeux de bornes pour une même
 * valeur, c'est un 500 au lieu d'un message.
 */
export async function lireGrillePrixOps(opsToken: string): Promise<{ prix: GrillePrix; bornes: Record<string, { min: number; max: number }> }> {
  const res = await fetch(`${BASE}/ops/prix`, { headers: { 'x-ops-token': opsToken } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `Erreur ${res.status}`);
  }
  return res.json() as Promise<{ prix: GrillePrix; bornes: Record<string, { min: number; max: number }> }>;
}

/**
 * CHANGER LA GRILLE. `note` est OBLIGATOIRE côté serveur : le jeton d'exploitation est PARTAGÉ, donc il n'y
 * a aucune identité d'opérateur à enregistrer, et cette phrase est la seule trace de qui a changé un prix.
 */
export async function ecrireGrillePrixOps(opsToken: string, prix: GrillePrix, note: string): Promise<{ prix: GrillePrix }> {
  const res = await fetch(`${BASE}/ops/prix`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-ops-token': opsToken },
    body: JSON.stringify({ ...prix, note }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `Erreur ${res.status}`);
  }
  return res.json() as Promise<{ prix: GrillePrix }>;
}

export async function getOpsOverview(opsToken: string): Promise<OpsOverview> {
  const res = await fetch(`${BASE}/ops/overview`, { headers: { 'x-ops-token': opsToken } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `Erreur ${res.status}`);
  }
  return res.json() as Promise<OpsOverview>;
}

// --- Support (formulaire de contact -> email Resend) ---

/** Le reply-to n'est PAS envoye par le client : le serveur le resout depuis le compte authentifie. */
export function sendSupportMessage(tenantId: string, input: { subject: string; message: string }): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/tenants/${tenantId}/support`, { method: 'POST', body: JSON.stringify(input) });
}

// --- Admin (gestion des comptes) ---

export type UserRole = 'admin' | 'manager' | 'agent';
export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  /** Code public « usr_<client>_<ulid> » (schéma A). Absent tant que le backfill n'a pas tourné. */
  code?: string | null;
  /** true = compte révoqué (login bloqué). */
  disabled: boolean;
  /** true = invitation en attente (mot de passe pas encore choisi). */
  pending: boolean;
  createdAt: string;
  /** Dernière connexion réussie (ISO). null = jamais connecté depuis la mise en place du suivi (migration
   *  0037) : on affiche « jamais », on ne retombe PAS sur `createdAt` qui mentirait. */
  lastLoginAt: string | null;
}
export function listUsers(tenantId: string): Promise<{ users: AdminUser[] }> {
  return request<{ users: AdminUser[] }>(`/tenants/${tenantId}/users`);
}
/** Invite un membre (crée un compte en attente + envoie un lien pour choisir son mot de passe). */
export function inviteMember(tenantId: string, email: string, role: UserRole, name?: string): Promise<{ user: AdminUser; emailSent: boolean }> {
  // ⚠️ Le nom est posé DÈS L'INVITATION quand il est saisi : sans lui, le nouveau membre apparaît sous son
  // adresse e-mail dans toute l'Inbox jusqu'à ce que quelqu'un pense à le renommer.
  return request(`/tenants/${tenantId}/invitations`, { method: 'POST', body: JSON.stringify({ email, role, ...(name ? { name } : {}) }) });
}

/**
 * Le NOM AFFICHÉ d'un membre. Vide = on efface, et le produit retombe sur l'adresse e-mail.
 *
 * 🔴 C'EST CE QUE L'INBOX MONTRE : « suivi par… », le sélecteur d'affectation et la charge par membre font
 * tous `name ?? email`. Tant que personne ne posait ce nom, l'équipe entière s'y affichait en adresses.
 */
export function renommerMembre(tenantId: string, userId: string, name: string): Promise<{ id: string; name: string | null }> {
  return request(`/tenants/${tenantId}/users/${userId}/name`, { method: 'PATCH', body: JSON.stringify({ name }) });
}
/** Le nom de l'espace (`tenants.name`), carte « Espace » de Compte & équipe. Admin seulement. */
export function lireNomEspace(tenantId: string): Promise<{ nom: string }> {
  return request(`/tenants/${tenantId}/nom`);
}
/** Renomme l'espace. Le serveur rend le nom EFFECTIF (rogné), c'est lui que l'écran affiche. */
export function renommerEspace(tenantId: string, nom: string): Promise<{ nom: string }> {
  return request(`/tenants/${tenantId}/nom`, { method: 'PATCH', body: JSON.stringify({ nom }) });
}
/** Accepte une invitation : pose le mot de passe et connecte (renvoie une session comme le login). */
export function acceptInvitation(token: string, password: string): Promise<LoginResult> {
  return request<LoginResult>('/auth/invitations/accept', { method: 'POST', body: JSON.stringify({ token, password }) });
}
export function setUserRole(tenantId: string, userId: string, role: UserRole): Promise<{ id: string; role: UserRole }> {
  return request(`/tenants/${tenantId}/users/${userId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
}
export function setUserDisabled(tenantId: string, userId: string, disabled: boolean): Promise<{ id: string; disabled: boolean }> {
  return request(`/tenants/${tenantId}/users/${userId}/disabled`, { method: 'PATCH', body: JSON.stringify({ disabled }) });
}
export function deleteUser(tenantId: string, userId: string): Promise<{ id: string; deleted: boolean }> {
  return request(`/tenants/${tenantId}/users/${userId}`, { method: 'DELETE' });
}
