import type { LectureModele } from '../api/modele-envoi';
import { domaineShopify, pageApps, type IssueJeton, type IssueVerification } from './connexion';
import type { AccesClients, ClientAbonne, LectureClients } from './clients';
import type { IssueAbonnement } from './abonnements';
// Le ménage des modèles remplacés : la préparation n'importe de la gestion que des TYPES, aucun cycle à l'exécution.
import { oublierPlusTard, type ProgrammerOubli } from './preparation';
import type { ImportInput } from '../crm/import';
import type { ImportReport } from '../crm/types';
import { LimiteOffreError } from '../offres/refus';
import {
  CATEGORIES_ADMISES, DELAI_PANIER_MAX, DELAI_PANIER_MIN, DONNEES_PAR_EVENEMENT, EVENEMENTS_DISPONIBLES, estDonneeShopify,
  estEvenementShopify,
  type DonneeShopify, type EvenementShopify,
} from './donnees';
import type { AttenteMessage, MessageBranche, OrigineBoutique, PgShopifyStore, VueBoutique } from './store.pg';

/**
 * LA GESTION DU CONNECTEUR SHOPIFY, porte unique des outils MCP et de la console (plan 2026-10-21, lot 1) : connecter
 * la boutique, brancher un message sur un événement, lire l'état, couper. Aucune des deux portes n'ajoute de contrôle.
 *
 * Un refus est rendu avec son statut et sa phrase, que l'outil MCP rend tel quel et que la route traduit.
 */

export interface DepsGestionShopify {
  store: Pick<PgShopifyStore, 'lire' | 'connecter' | 'couper' | 'messages' | 'brancher' | 'affirmerConsentement' | 'retirerConsentement' | 'compteurs'
    | 'reglerDelaiPanier' | 'compteursPaniers' | 'acces' | 'attentes' | 'retirerAttente'>;
  /** `verifierBoutique` lié à `fetchPublic` par le câblage. */
  verifier(domaine: string, clientId: string, secret: string): Promise<IssueVerification>;
  /** Le modèle lu chez Meta, la MÊME lecture que l'envoi public. */
  lireModele(tenantId: string, nom: string, langue: string): Promise<LectureModele>;
  /** `ENCRYPTION_KEY` sait chiffrer : sans elle, aucun secret de boutique ne peut être gardé. Sondé au câblage. */
  chiffrementPret: boolean;
  /** L'import des clients (lot 3) : `demanderJeton` et `lireClientsAbonnes` liés à `fetchPublic` par le câblage. */
  jeton(domaine: string, clientId: string, secret: string): Promise<IssueJeton>;
  lireClients(acces: AccesClients, plafond: number): Promise<LectureClients>;
  /** Les places de l'offre et les numéros déjà présents (`placesContacts`), comptés comme la limite les compte. */
  places(tenantId: string, numeros: readonly string[]): Promise<{ limite: number | null; comptees: number; presents: Set<string> }>;
  /** `importContacts` lié aux magasins de la fiche : le chemin de l'import HubSpot, aucun événement d'automation. */
  importer(input: ImportInput): Promise<ImportReport>;
  /** Le branchement par la console (conception 2026-10-22) : `abonnerWebhooks` lié à `fetchPublic` par le câblage. */
  abonner(acces: { domaine: string; jeton: string }): Promise<IssueAbonnement>;
  /** Le ménage (2026-10-23) : programmer l'oubli du modèle de l'assistant que ce branchement remplace. */
  programmerOubli: ProgrammerOubli;
}

export type Refus = { ok: false; statut: 400 | 402 | 409 | 422 | 503; message: string };
export type Issue<T> = { ok: true; valeur: T } | Refus;

const refus = (statut: Refus['statut'], message: string): Refus => ({ ok: false, statut, message });

/** Les chiffres que la carte et l'outil d'état montrent : les 30 derniers jours. */
export const JOURS_COMPTES = 30;
/** Les paniers se comptent sur leur durée de vie : la purge les efface au bout de sept jours. */
export const JOURS_PANIERS = 7;
const VARIABLES_MAX = 10;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SECRET = /^[\x21-\x7e]{1,200}$/;

export interface EtatShopify {
  boutique: VueBoutique | null;
  messages: MessageBranche[];
  compteurs: Record<string, number>;
  /** Les paniers des 7 derniers jours : relancés (par issue), fermés à temps (une commande en est née), en attente. */
  paniers: { relances: Record<string, number>; fermesATemps: number; enAttente: number };
  /** La page des apps de la boutique, d'où le marchand désinstalle l'app (aucune API ne le fait). */
  pageApps: string | null;
  /** Les messages préparés par la console dont le modèle attend l'approbation de Meta. */
  attentes: AttenteMessage[];
}

export async function etatShopify(deps: DepsGestionShopify, tenantId: string): Promise<EtatShopify> {
  const boutique = await deps.store.lire(tenantId);
  if (boutique === null) return { boutique: null, messages: [], compteurs: {}, paniers: { relances: {}, fermesATemps: 0, enAttente: 0 }, pageApps: null, attentes: [] };
  return {
    boutique,
    messages: await deps.store.messages(tenantId),
    compteurs: await deps.store.compteurs(tenantId, JOURS_COMPTES),
    // Sept jours : un panier ne vit pas plus (purge), compter au-delà ne compterait rien de plus.
    paniers: await deps.store.compteursPaniers(tenantId, JOURS_PANIERS),
    pageApps: pageApps(boutique.domaine),
    attentes: await deps.store.attentes(tenantId),
  };
}

export async function connecterShopify(
  deps: DepsGestionShopify, tenantId: string, saisie: { boutique: unknown; clientId: unknown; secret: unknown }, par: string | null,
  /**
   * 🔴 Par où (conception 2026-10-22) : `console` abonne les webhooks par l'API, `claude_code` jamais (ils sont déclarés
   * dans l'app de la CLI, les doubler ferait tout recevoir deux fois). Requis : un appelant qui l'oublierait ne compile pas.
   */
  origine: OrigineBoutique,
): Promise<Issue<VueBoutique>> {
  const domaine = domaineShopify(saisie.boutique);
  if (domaine === null) return refus(400, 'boutique : le domaine de la boutique, de la forme <nom>.myshopify.com (son nom suffit, celui de l’adresse admin.shopify.com/store/<nom>).');
  // Une clé collée depuis la page de Shopify porte souvent une espace ou un retour à la ligne : nettoyée avant tout.
  const clientId = typeof saisie.clientId === 'string' ? saisie.clientId.trim() : saisie.clientId;
  const secret = typeof saisie.secret === 'string' ? saisie.secret.trim() : saisie.secret;
  const ou = origine === 'console' ? 'la page Settings de l’app, sur le tableau de bord développeur de Shopify' : '« shopify app env show »';
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) {
    return refus(400, `client_id : l’identifiant de l’app (Client ID), tel que ${ou} le donne.`);
  }
  if (typeof secret !== 'string' || !SECRET.test(secret)) {
    return refus(400, `client_secret : le secret de l’app (Client secret), tel que ${ou} le donne.`);
  }
  if (!deps.chiffrementPret) return refus(503, 'Le chiffrement des secrets n’est pas configuré sur cette instance : impossible de brancher une boutique.');
  // 🔴 La même boutique, avec les clés de l'app de la CLI (relecture du lot 3 de la console) : elle reste `claude_code`.
  // Ses webhooks sont déclarés dans l'app, les abonner aussi par l'API ferait tout recevoir deux fois, et ses demandes
  // RGPD continuent d'arriver (une boutique `console` serait effacée à la désinstallation, sans `shop/redact`).
  const avant = origine === 'console' ? await deps.store.acces(tenantId) : null;
  const memeApp = avant !== null && avant.origine === 'claude_code' && avant.domaine === domaine && avant.clientId === clientId;
  const origineRetenue: OrigineBoutique = memeApp ? 'claude_code' : origine;
  const v = await deps.verifier(domaine, clientId, secret);
  if (!v.ok) return refus(v.code === 'passager' ? 503 : 422, v.message);
  const issue = await deps.store.connecter(tenantId, {
    domaine, clientId, secretClair: secret, nom: v.nom, pays: v.pays, devise: v.devise, par, origine: origineRetenue,
  });
  if (issue === 'boutique_ailleurs') {
    return refus(409, 'Cette boutique est déjà branchée à un autre espace Messaging Me : coupez-la d’abord dans cet espace.');
  }
  if (origineRetenue === 'console') {
    // Branchée, mais sans événements tant que l'abonnement n'a pas réussi : le refus le dit, et un nouvel essai est
    // idempotent (un sujet déjà abonné vaut « déjà »).
    const j = await deps.jeton(domaine, clientId, secret);
    if (!j.ok) return refus(j.code === 'passager' ? 503 : 422, j.message);
    const a = await deps.abonner({ domaine, jeton: j.jeton });
    if (!a.ok) return refus(503, `La boutique est branchée, mais ses événements ne sont pas encore abonnés : ${a.message} Rebranchez-la pour réessayer.`);
  }
  const vue = await deps.store.lire(tenantId);
  if (vue === null) return refus(503, 'La boutique n’a pas pu être relue après sa connexion : réessayez.');
  return { ok: true, valeur: vue };
}

export interface Branchement {
  evenement: unknown;
  modele: unknown;
  langue: unknown;
  variables: unknown;
  actif: unknown;
  /** Le marchand affirme que ses clients consentent : la fiche devient consentante partout (décision de Julien). */
  consentementAffirme: unknown;
  /** La relance de panier seulement : le délai après la dernière modification du panier, en minutes. */
  delaiMinutes?: unknown;
}

export async function brancherMessage(
  deps: DepsGestionShopify, tenantId: string, b: Branchement, par: string | null,
): Promise<Issue<MessageBranche[]>> {
  if (!estEvenementShopify(b.evenement) || !EVENEMENTS_DISPONIBLES.includes(b.evenement)) {
    return refus(400, `event : ${EVENEMENTS_DISPONIBLES.join(', ')}.`);
  }
  const evenement: EvenementShopify = b.evenement;
  if (typeof b.modele !== 'string' || b.modele.trim() === '' || b.modele.length > 512) return refus(400, 'template : le nom du modèle WhatsApp.');
  if (typeof b.langue !== 'string' || b.langue.trim() === '' || b.langue.length > 20) return refus(400, 'language : la langue du modèle (fr, en_US...).');
  const actif = b.actif === undefined ? true : b.actif;
  if (typeof actif !== 'boolean') return refus(400, 'active : vrai ou faux.');
  const brutes = b.variables === undefined ? [] : b.variables;
  if (!Array.isArray(brutes) || brutes.length > VARIABLES_MAX) return refus(400, `variables : une liste de ${VARIABLES_MAX} données au plus.`);
  const permises = DONNEES_PAR_EVENEMENT[evenement];
  const variables: DonneeShopify[] = [];
  for (const v of brutes) {
    if (!estDonneeShopify(v) || !permises.includes(v)) return refus(400, `variables : pour ${evenement}, parmi ${permises.join(', ')}.`);
    variables.push(v);
  }
  const affirme = b.consentementAffirme === true;
  if (b.consentementAffirme !== undefined && typeof b.consentementAffirme !== 'boolean') return refus(400, 'customers_consented : vrai ou faux.');
  const panier = evenement === 'checkout_abandoned';
  if (b.delaiMinutes !== undefined && (!panier || typeof b.delaiMinutes !== 'number' || !Number.isInteger(b.delaiMinutes)
    || b.delaiMinutes < DELAI_PANIER_MIN || b.delaiMinutes > DELAI_PANIER_MAX)) {
    return refus(400, `delay_minutes : pour checkout_abandoned seulement, un nombre entier de ${DELAI_PANIER_MIN} à ${DELAI_PANIER_MAX} minutes.`);
  }

  const boutique = await deps.store.lire(tenantId);
  if (boutique === null) return refus(409, 'Aucune boutique Shopify n’est branchée à cet espace : connect_shopify d’abord.');
  if (boutique.etat === 'coupee') return refus(409, 'La boutique est coupée : rebranchez-la avec connect_shopify avant d’y brancher un message.');
  // 🔴 Une relance de panier est un message marketing à des gens qui n'ont rien demandé sur WhatsApp : elle ne s'active
  // que si le marchand a affirmé le consentement de ses clients (décision de Julien), dans cet appel ou avant.
  const consentApres = affirme || (boutique.consentement !== null && b.consentementAffirme !== false);
  if (panier && actif && !consentApres) {
    return refus(409, 'La relance de panier exige que vous affirmiez le consentement de vos clients à recevoir vos messages WhatsApp (customers_consented: true).');
  }

  const modele = b.modele.trim();
  const langue = b.langue.trim();
  if (actif) {
    const m = await deps.lireModele(tenantId, modele, langue);
    if (m.statut === 'illisible') return refus(503, 'Le modèle n’a pas pu être lu chez Meta : réessayez dans un instant.');
    if (m.statut !== 'approuve') {
      return refus(422, `Le modèle « ${modele} » (${langue}) n’est pas approuvé chez Meta, ou ne peut pas partir : suivez sa validation avec get_template_status.`);
    }
    if (!CATEGORIES_ADMISES[evenement].includes(m.categorie)) {
      return refus(422, `Le modèle « ${modele} » est de catégorie ${m.categorie} : pour ${evenement}, un modèle ${CATEGORIES_ADMISES[evenement].join(' ou ')}.`);
    }
    if (m.variables !== variables.length) {
      return refus(422, `Le modèle « ${modele} » a ${m.variables} variable(s) : variables doit en nommer exactement autant, dans l’ordre.`);
    }
  }
  const actifAvant = (await deps.store.messages(tenantId)).find((m) => m.evenement === evenement) ?? null;
  await deps.store.brancher(tenantId, { evenement, modele, langue, variables, actif, par });
  // Le dernier geste gagne (conception 2026-10-22) : un message préparé par la console pour cet événement, encore en
  // validation chez Meta, ne remplacera pas celui qu'on branche ici à son approbation.
  const retiree = await deps.store.retirerAttente(tenantId, { evenement });
  if (typeof b.delaiMinutes === 'number') await deps.store.reglerDelaiPanier(tenantId, b.delaiMinutes);
  // Trois états : vrai affirme, faux RETIRE (plus aucune fiche n'est écrite consentante), absent ne change rien.
  if (affirme) await deps.store.affirmerConsentement(tenantId, par);
  else if (b.consentementAffirme === false) await deps.store.retirerConsentement(tenantId);
  await oublierPlusTard(deps, tenantId, actifAvant?.modele, modele);
  await oublierPlusTard(deps, tenantId, retiree?.modele, modele);
  return { ok: true, valeur: await deps.store.messages(tenantId) };
}

export async function couperShopify(deps: DepsGestionShopify, tenantId: string): Promise<Issue<{ dejaCoupee: boolean; pageApps: string | null }>> {
  const boutique = await deps.store.lire(tenantId);
  if (boutique === null) return refus(409, 'Aucune boutique Shopify n’est branchée à cet espace.');
  const coupee = await deps.store.couper(tenantId, 'coupée depuis Messaging Me');
  return {
    ok: true,
    valeur: { dejaCoupee: !coupee, pageApps: pageApps(boutique.domaine) },
  };
}

/** Les clients lus par appel, au plus (80 pages de Shopify) : de quoi tenir dans le délai d'un outil. */
export const CLIENTS_LUS_MAX = 20_000;
/** Les fiches qu'un import écrit, au plus, par appel : le relancer prend la suite, sans doublon. */
export const IMPORT_MAX = 5_000;
/** L'étiquette des fiches importées : le marchand les retrouve, et les cible. */
export const ETIQUETTE_SHOPIFY = 'Shopify';

export interface ApercuImport {
  /** Les clients abonnés au marketing (e-mail ou SMS) avec un téléphone valable. */
  abonnes: number;
  /** Les abonnés sans téléphone valable : jamais importés. */
  sansTelephone: number;
  dejaDansLEspace: number;
  nouveaux: number;
  /** Les places que l'offre laisse ; `null` : sans limite. */
  placesLibres: number | null;
  /** Ce qu'un import écrirait au plus : les nouveaux, dans les places libres et la borne d'un appel. */
  importables: number;
  /** `false` : la lecture s'est arrêtée au plafond, il reste des abonnés plus anciens. */
  complet: boolean;
}

interface Lecture { nouveaux: ClientAbonne[]; dejaDansLEspace: number; sansTelephone: number; libres: number | null; complet: boolean }

/**
 * Les abonnés de la boutique de l'espace, et ce que l'offre permet d'en importer. Décisions de Julien du 2026-10-22 :
 * les abonnés au marketing seulement, du plus récent au plus ancien ; une fiche déjà présente n'est ni comptée ni
 * touchée.
 */
async function lireAbonnes(deps: DepsGestionShopify, tenantId: string): Promise<Issue<Lecture>> {
  const a = await deps.store.acces(tenantId);
  if (a === null) return refus(409, 'Aucune boutique Shopify n’est branchée : branchez-la d’abord (la carte Shopify de la console, ou la skill shopify du plugin).');
  if (a.etat !== 'connectee') return refus(409, 'La boutique Shopify est coupée : rebranchez-la avant d’importer ses clients.');
  const j = await deps.jeton(a.domaine, a.clientId, a.secret);
  if (!j.ok) return refus(j.code === 'passager' ? 503 : 409, j.message);
  const lecture = await deps.lireClients({ domaine: a.domaine, jeton: j.jeton, pays: a.pays }, CLIENTS_LUS_MAX);
  if (!lecture.ok) return refus(lecture.code === 'passager' ? 503 : 409, lecture.message);
  const places = await deps.places(tenantId, lecture.abonnes.map((c) => c.telephone));
  const nouveaux = lecture.abonnes.filter((c) => !places.presents.has(c.telephone));
  return {
    ok: true,
    valeur: {
      nouveaux, dejaDansLEspace: lecture.abonnes.length - nouveaux.length, sansTelephone: lecture.sansTelephone,
      libres: places.limite === null ? null : Math.max(0, places.limite - places.comptees), complet: lecture.complet,
    },
  };
}

/** Compter avant d'importer (décision de Julien) : rien ne s'écrit ici. */
export async function apercuImportClients(deps: DepsGestionShopify, tenantId: string): Promise<Issue<ApercuImport>> {
  const l = await lireAbonnes(deps, tenantId);
  if (!l.ok) return l;
  const { nouveaux, dejaDansLEspace, sansTelephone, libres, complet } = l.valeur;
  return {
    ok: true,
    valeur: {
      abonnes: nouveaux.length + dejaDansLEspace, sansTelephone, dejaDansLEspace, nouveaux: nouveaux.length, placesLibres: libres,
      importables: Math.min(nouveaux.length, libres ?? Infinity, IMPORT_MAX), complet,
    },
  };
}

export interface BilanImport {
  importes: number;
  /** Des numéros qu'une fiche supprimée portait : l'import les rétablit, comme l'import d'un fichier. */
  retablis: number;
  /** Les nouveaux abonnés laissés dehors : au-delà du nombre choisi. */
  restent: number;
  placesLibres: number | null;
  etiquette: string;
  complet: boolean;
}

/**
 * Importe les `maximum` abonnés nouveaux les plus récents, le nombre que le marchand a choisi après l'aperçu.
 * 🔴 JAMAIS de consentement (décision de Julien : un accord e-mail ou SMS n'est pas un accord WhatsApp), et l'autorité
 * `import` ne lève jamais un STOP. Un maximum au-delà des places libres est refusé : le marchand gère sa limite, rien
 * ne s'écrit à moitié.
 */
export async function importerClients(deps: DepsGestionShopify, tenantId: string, maximum: unknown): Promise<Issue<BilanImport>> {
  if (typeof maximum !== 'number' || !Number.isInteger(maximum) || maximum < 1 || maximum > IMPORT_MAX) {
    return refus(400, `max_contacts : un entier de 1 à ${IMPORT_MAX}, le nombre de clients que le marchand a choisi d’importer.`);
  }
  const l = await lireAbonnes(deps, tenantId);
  if (!l.ok) return l;
  const { nouveaux, libres, complet } = l.valeur;
  // Ce qui serait ÉCRIT, et non le nombre demandé (relecture du lot 3) : 100 demandés pour 3 nouveaux et 50 places passent.
  if (libres !== null && Math.min(maximum, nouveaux.length) > libres) {
    return refus(402, `L’offre ne laisse que ${libres} place${libres > 1 ? 's' : ''} de contacts : importez au plus ${libres} clients, ou passez à l’offre supérieure.`);
  }
  const choisis = nouveaux.slice(0, maximum);
  let rapport: ImportReport = { created: 0, updated: 0, skipped: 0, errors: [] };
  if (choisis.length > 0) {
    try {
      rapport = await deps.importer({
        rows: choisis.map((c) => ({ phone: c.telephone, name: c.nom ?? '' })),
        mapping: { columns: { phone: { target: 'phone' }, name: { target: 'name' } } },
        tenantId, optIn: false, tags: [ETIQUETTE_SHOPIFY], autorite: 'import',
      });
    } catch (err) {
      // Deux écritures simultanées à la dernière place : la vérification de l'import tranche, et le dit.
      if (err instanceof LimiteOffreError) return refus(402, err.message);
      throw err;
    }
  }
  return {
    ok: true,
    valeur: {
      importes: rapport.created, retablis: rapport.updated, restent: nouveaux.length - choisis.length,
      placesLibres: libres === null ? null : Math.max(0, libres - rapport.created - rapport.updated),
      etiquette: ETIQUETTE_SHOPIFY, complet,
    },
  };
}
