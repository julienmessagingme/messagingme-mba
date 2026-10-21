import type { LectureModele } from '../api/modele-envoi';
import { domaineShopify, pageApps, type IssueVerification } from './connexion';
import {
  CATEGORIES_ADMISES, DONNEES_PAR_EVENEMENT, EVENEMENTS_DISPONIBLES, estDonneeShopify, estEvenementShopify,
  type DonneeShopify, type EvenementShopify,
} from './donnees';
import type { MessageBranche, PgShopifyStore, VueBoutique } from './store.pg';

/**
 * LA GESTION DU CONNECTEUR SHOPIFY, porte unique des outils MCP et de la console (plan 2026-10-21, lot 1) : connecter
 * la boutique, brancher un message sur un événement, lire l'état, couper. Aucune des deux portes n'ajoute de contrôle.
 *
 * Un refus est rendu avec son statut et sa phrase, que l'outil MCP rend tel quel et que la route traduit.
 */

export interface DepsGestionShopify {
  store: Pick<PgShopifyStore, 'lire' | 'connecter' | 'couper' | 'messages' | 'brancher' | 'affirmerConsentement' | 'retirerConsentement' | 'compteurs'>;
  /** `verifierBoutique` lié à `fetchPublic` par le câblage. */
  verifier(domaine: string, clientId: string, secret: string): Promise<IssueVerification>;
  /** Le modèle lu chez Meta, la MÊME lecture que l'envoi public. */
  lireModele(tenantId: string, nom: string, langue: string): Promise<LectureModele>;
  /** `ENCRYPTION_KEY` sait chiffrer : sans elle, aucun secret de boutique ne peut être gardé. Sondé au câblage. */
  chiffrementPret: boolean;
}

export type Refus = { ok: false; statut: 400 | 409 | 422 | 503; message: string };
export type Issue<T> = { ok: true; valeur: T } | Refus;

const refus = (statut: Refus['statut'], message: string): Refus => ({ ok: false, statut, message });

/** Les chiffres que la carte et l'outil d'état montrent : les 30 derniers jours. */
export const JOURS_COMPTES = 30;
const VARIABLES_MAX = 10;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SECRET = /^[\x21-\x7e]{1,200}$/;

export interface EtatShopify {
  boutique: VueBoutique | null;
  messages: MessageBranche[];
  compteurs: Record<string, number>;
  /** La page des apps de la boutique, d'où le marchand désinstalle l'app (aucune API ne le fait). */
  pageApps: string | null;
}

export async function etatShopify(deps: DepsGestionShopify, tenantId: string): Promise<EtatShopify> {
  const boutique = await deps.store.lire(tenantId);
  if (boutique === null) return { boutique: null, messages: [], compteurs: {}, pageApps: null };
  return {
    boutique,
    messages: await deps.store.messages(tenantId),
    compteurs: await deps.store.compteurs(tenantId, JOURS_COMPTES),
    pageApps: pageApps(boutique.domaine),
  };
}

export async function connecterShopify(
  deps: DepsGestionShopify, tenantId: string, saisie: { boutique: unknown; clientId: unknown; secret: unknown }, par: string | null,
): Promise<Issue<VueBoutique>> {
  const domaine = domaineShopify(saisie.boutique);
  if (domaine === null) return refus(400, 'boutique : le domaine de la boutique, de la forme <nom>.myshopify.com.');
  if (typeof saisie.clientId !== 'string' || !CLIENT_ID.test(saisie.clientId)) {
    return refus(400, 'client_id : l’identifiant de l’app, tel que « shopify app env show » le donne (SHOPIFY_API_KEY).');
  }
  if (typeof saisie.secret !== 'string' || !SECRET.test(saisie.secret)) {
    return refus(400, 'client_secret : le secret de l’app, tel que « shopify app env show » le donne (SHOPIFY_API_SECRET).');
  }
  if (!deps.chiffrementPret) return refus(503, 'Le chiffrement des secrets n’est pas configuré sur cette instance : impossible de brancher une boutique.');
  const v = await deps.verifier(domaine, saisie.clientId, saisie.secret);
  if (!v.ok) return refus(v.code === 'passager' ? 503 : 422, v.message);
  const issue = await deps.store.connecter(tenantId, {
    domaine, clientId: saisie.clientId, secretClair: saisie.secret, nom: v.nom, pays: v.pays, devise: v.devise, par,
  });
  if (issue === 'boutique_ailleurs') {
    return refus(409, 'Cette boutique est déjà branchée à un autre espace Messaging Me : coupez-la d’abord dans cet espace.');
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
}

export async function brancherMessage(
  deps: DepsGestionShopify, tenantId: string, b: Branchement, par: string | null,
): Promise<Issue<MessageBranche[]>> {
  if (!estEvenementShopify(b.evenement) || !EVENEMENTS_DISPONIBLES.includes(b.evenement)) {
    return refus(400, `event : ${EVENEMENTS_DISPONIBLES.join(' ou ')} (la relance de panier arrive bientôt).`);
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

  const boutique = await deps.store.lire(tenantId);
  if (boutique === null) return refus(409, 'Aucune boutique Shopify n’est branchée à cet espace : connect_shopify d’abord.');
  if (boutique.etat === 'coupee') return refus(409, 'La boutique est coupée : rebranchez-la avec connect_shopify avant d’y brancher un message.');

  const modele = b.modele.trim();
  const langue = b.langue.trim();
  if (actif) {
    const m = await deps.lireModele(tenantId, modele, langue);
    if (m.statut === 'illisible') return refus(503, 'Le modèle n’a pas pu être lu chez Meta : réessayez dans un instant.');
    if (m.statut !== 'approuve') {
      return refus(422, `Le modèle « ${modele} » (${langue}) n’est pas approuvé chez Meta, ou ne peut pas partir : suivez sa validation avec get_template_status.`);
    }
    if (!CATEGORIES_ADMISES[evenement].includes(m.categorie)) {
      return refus(422, `Le modèle « ${modele} » est de catégorie ${m.categorie} : un message de commande doit être un modèle utility (service).`);
    }
    if (m.variables !== variables.length) {
      return refus(422, `Le modèle « ${modele} » a ${m.variables} variable(s) : variables doit en nommer exactement autant, dans l’ordre.`);
    }
  }
  await deps.store.brancher(tenantId, { evenement, modele, langue, variables, actif, par });
  // Trois états : vrai affirme, faux RETIRE (plus aucune fiche n'est écrite consentante), absent ne change rien.
  if (affirme) await deps.store.affirmerConsentement(tenantId, par);
  else if (b.consentementAffirme === false) await deps.store.retirerConsentement(tenantId);
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
