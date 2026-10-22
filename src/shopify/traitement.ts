import { journaliser } from '../lib/journal';
import { messageDe } from '../lib/erreur';
import { moisDeParis } from '../offres/compteurs';
import { MAX_OPT_IN_SOURCE } from '../api/contacts-upsert';
import type { Emission } from '../emails-produit/emission';
import {
  DONNEES_PAR_EVENEMENT, donneesDeCommande, donneesDExpedition, schemaCommande, schemaDemandeDonnees,
  schemaEffacementClient, schemaExpedition, telephoneDeCommande, telephoneDExpedition, telephoneE164,
  numeroDeCommandeDExpedition, prenomDeCheckout, schemaCheckout, telephoneDeCheckout, valeurDeVariable,
  type DonneeShopify, type EvenementShopify,
} from './donnees';
import { envoyerShopify, type EnvoyerPublic, type IssueEnvoi } from './envoi';
import type { EtatBoutique, OrigineBoutique, PgShopifyStore } from './store.pg';

/**
 * LE TRAITEMENT D'UN WEBHOOK SHOPIFY DÉJÀ VÉRIFIÉ (plan 2026-10-21, lot 1), sujet par sujet.
 *
 * 🔴 DANS LA REQUÊTE, ET SHOPIFY EST LA FILE. L'envoi public n'existe que dans le processus de l'API (ses dépendances
 * se construisent dans `src/index.ts`), et les recopier dans le worker serait une liste tenue à la main. Shopify attend
 * sa réponse en 5 s et réessaie ce qui n'a pas reçu de 2xx : un 503 rendu ici est donc un « réessayez », jamais une
 * perte, et le traitement est rejouable de bout en bout (réservation de l'événement, clé d'idempotence de l'envoi).
 *
 * 🔴 AUCUN ORDRE ENTRE SUJETS (mesuré : `orders/paid` arrive avant `orders/create`). Chaque sujet se suffit à lui-même.
 *
 * Une boutique `coupee` n'envoie plus rien, mais ses trois sujets RGPD se traitent encore : Shopify envoie `shop/redact`
 * environ 48 h après la désinstallation.
 */

export interface BoutiqueRecue {
  tenantId: string;
  domaine: string;
  etat: EtatBoutique;
  pays: string | null;
  consentementAffirme: boolean;
  /** `console` : une boutique désinstallée perd son branchement, `shop/redact` ne viendra jamais (conception 2026-10-22). */
  origine: OrigineBoutique;
}

export interface DepsTraitementShopify {
  store: Pick<PgShopifyStore,
    'message' | 'reserverEvenement' | 'noterIssue' | 'libererEvenement' | 'noterDernierEvenement' | 'lierCommande'
    | 'couperParDomaine' | 'effacerBoutique' | 'contactsLies' | 'noterPanier' | 'fermerPanier' | 'fermerPanierExistant'
    | 'fermerPaniersDuTelephone' | 'effacerPaniersDuTelephone'>;
  envoyer: EnvoyerPublic;
  /** La fiche vivante d'un numéro E.164 dans l'espace, ou `null`. */
  ficheParTelephone(tenantId: string, e164: string): Promise<string | null>;
  /**
   * L'effacement de fiches demandé par Shopify, HORS limite d'effacements du jour : une obligation légale ne bute pas
   * sur une limite commerciale, et la demande est signée par la boutique elle-même.
   */
  effacerFiches(tenantId: string, ids: readonly string[]): Promise<void>;
  emails: { emettre(e: Emission): Promise<unknown> };
  /** La page Offre de la console, pour l'e-mail de la limite de contacts. */
  pageOffre: string;
  maintenant?: () => number;
}

/** 200 : traité ou délibérément ignoré. 503 : Shopify doit réessayer plus tard. */
export interface ReponseTraitement { statut: 200 | 503 }

const OK: ReponseTraitement = { statut: 200 };
const REESSAYER: ReponseTraitement = { statut: 503 };

/** Le nom de la ligne dans Campagnes, par événement. */
const LIBELLE: Readonly<Record<EvenementShopify, string>> = {
  order_paid: 'commande payée',
  order_fulfilled: 'commande expédiée',
  checkout_abandoned: 'panier abandonné',
};

/** Les issues qui ne sont pas un envoi : le traitement s'arrête avant l'envoi public. */
type IssueAvantEnvoi = 'sans_telephone' | 'donnee_manquante';
export type IssueEvenement = Exclude<IssueEnvoi, 'en_cours'> | IssueAvantEnvoi;

const SUJETS_RGPD = new Set(['customers/redact', 'customers/data_request', 'shop/redact']);

export async function traiterWebhookShopify(
  deps: DepsTraitementShopify, b: BoutiqueRecue, sujet: string, corps: unknown,
): Promise<ReponseTraitement> {
  // Une boutique coupée n'écoute plus que le RGPD, et la désinstallation d'une boutique de la console : c'est le seul
  // signal qui efface son branchement, le parcours nominal étant « Couper » puis désinstaller (relecture des lots 0 et 1).
  if (b.etat === 'coupee' && !SUJETS_RGPD.has(sujet) && !(sujet === 'app/uninstalled' && b.origine === 'console')) return OK;
  switch (sujet) {
    case 'orders/paid': {
      const c = schemaCommande.safeParse(corps);
      if (!c.success) return illisible(b, sujet);
      // Une commande payée ferme aussi son panier : `orders/create` peut arriver après (aucun ordre entre sujets).
      await fermerSiPanier(deps, b, c.data.checkout_token, telephoneDeCommande(c.data, b.pays));
      return servir(deps, b, {
        evenement: 'order_paid', cle: `orders/paid:${c.data.id}`, sujet,
        commandeId: String(c.data.id), clientId: c.data.customer?.id ? String(c.data.customer.id) : null,
        telephone: telephoneDeCommande(c.data, b.pays), valeurs: donneesDeCommande(c.data), numero: c.data.name,
      });
    }
    case 'fulfillments/create': {
      const f = schemaExpedition.safeParse(corps);
      if (!f.success) return illisible(b, sujet);
      return servir(deps, b, {
        evenement: 'order_fulfilled', cle: `fulfillments/create:${f.data.id}`, sujet,
        commandeId: String(f.data.order_id), clientId: null,
        telephone: telephoneDExpedition(f.data, b.pays), valeurs: donneesDExpedition(f.data),
        numero: numeroDeCommandeDExpedition(f.data.name),
      });
    }
    case 'orders/create': {
      // Le panier se ferme dès qu'une commande en naît, même non payée : un client qui a commandé par virement ne
      // reçoit pas « vous avez oublié votre panier ».
      const c = schemaCommande.safeParse(corps);
      if (!c.success) return illisible(b, sujet);
      await fermerSiPanier(deps, b, c.data.checkout_token, telephoneDeCommande(c.data, b.pays));
      return OK;
    }
    case 'checkouts/create':
    case 'checkouts/update':
      return noterCheckout(deps, b, sujet, corps);
    case 'app/uninstalled':
      // Une boutique de la console ne recevra jamais shop/redact (ses sujets RGPD ne s'abonnent pas sans la CLI) : son
      // branchement part tout de suite, le secret ne servait plus qu'à vérifier ce sujet. Les fiches restent.
      if (b.origine === 'console') await deps.store.effacerBoutique(b.tenantId);
      else await deps.store.couperParDomaine(b.domaine, 'app désinstallée de la boutique');
      return OK;
    case 'customers/redact':
      return effacerClient(deps, b, corps);
    case 'customers/data_request': {
      const d = schemaDemandeDonnees.safeParse(corps);
      if (!d.success) return illisible(b, sujet);
      const jour = new Date((deps.maintenant ?? Date.now)()).toISOString().slice(0, 10);
      await deps.emails.emettre({
        cle: 'shopify_demande_donnees', tenantId: b.tenantId, a: 'admins',
        occasion: `${b.domaine}:${d.data.customer?.id ?? (d.data.orders_requested ?? []).join(',')}:${jour}`.slice(0, 200),
        valeurs: { boutique: b.domaine },
      });
      return OK;
    }
    case 'shop/redact':
      // Shopify l'envoie ~48 h après la désinstallation. Une boutique reconnectée entre-temps est `connectee` : ne pas
      // effacer un branchement vivant (relecture du lot 1).
      if (b.etat === 'connectee') {
        journaliser('warn', 'shopify_shop_redact_ignore', { tenantId: b.tenantId });
        return OK;
      }
      await deps.store.effacerBoutique(b.tenantId);
      return OK;
    default:
      // Un sujet inconnu ne se réessaie pas.
      return OK;
  }
}

/** Le message de relance est-il branché et actif ? Sans lui, aucun panier ne se garde : un téléphone sans raison. */
async function relanceActive(deps: DepsTraitementShopify, b: BoutiqueRecue): Promise<boolean> {
  return (await deps.store.message(b.tenantId, 'checkout_abandoned'))?.actif === true;
}

/**
 * Une commande ferme son panier. 🔴 TOUJOURS celui qui existe, relance éteinte comprise : éteinte puis rallumée, elle
 * relançait sinon le client qui avait commandé pendant la pause (rouge de la relecture du lot 2). La ligne d'un panier
 * pas encore reçu (fermeture avant le panier) ne s'écrit, elle, que relance active. Et les autres paniers ouverts du
 * même numéro se ferment aussi : un achat express passe par un autre checkout.
 */
async function fermerSiPanier(deps: DepsTraitementShopify, b: BoutiqueRecue, jeton: string | null | undefined, telephone: string | null): Promise<void> {
  if (jeton) {
    if (await relanceActive(deps, b)) await deps.store.fermerPanier(b.tenantId, jeton);
    else await deps.store.fermerPanierExistant(b.tenantId, jeton);
  }
  if (telephone !== null) await deps.store.fermerPaniersDuTelephone(b.tenantId, telephone);
}

/**
 * Un checkout : payé, il ferme le panier ; sinon il le note, avec le téléphone saisi, le prénom et le lien de reprise.
 * Sans téléphone, rien ne se garde (le suivant en portera peut-être un).
 */
async function noterCheckout(deps: DepsTraitementShopify, b: BoutiqueRecue, sujet: string, corps: unknown): Promise<ReponseTraitement> {
  const c = schemaCheckout.safeParse(corps);
  if (!c.success) return illisible(b, sujet);
  if (c.data.completed_at) {
    await fermerSiPanier(deps, b, c.data.token, null);
    return OK;
  }
  // Un panier ne se garde qu'avec la relance active ET le consentement affirmé : sinon c'est un téléphone sans usage,
  // qu'une affirmation ultérieure ferait relancer d'un coup (relecture du lot 2).
  if (!b.consentementAffirme || !(await relanceActive(deps, b))) return OK;
  const telephone = telephoneDeCheckout(c.data, b.pays);
  if (telephone === null) return OK;
  await deps.store.noterPanier(b.tenantId, {
    jeton: c.data.token, telephone, nom: prenomDeCheckout(c.data), lien: valeurDeVariable(c.data.abandoned_checkout_url),
  });
  return OK;
}

/** Un corps bien signé qui ne se lit pas : 200 et une trace, jamais un 4xx (Shopify réessaierait, puis désabonnerait). */
function illisible(b: BoutiqueRecue, sujet: string): ReponseTraitement {
  journaliser('warn', 'shopify_corps_illisible', { tenantId: b.tenantId, sujet });
  return OK;
}

interface Service {
  evenement: EvenementShopify;
  cle: string;
  sujet: string;
  commandeId: string;
  clientId: string | null;
  telephone: string | null;
  valeurs: Partial<Record<DonneeShopify, string>>;
  numero: string;
}

async function servir(deps: DepsTraitementShopify, b: BoutiqueRecue, s: Service): Promise<ReponseTraitement> {
  const m = await deps.store.message(b.tenantId, s.evenement);
  // Aucun message branché : rien ne s'écrit, pas même une fiche (elle compterait dans la limite de l'offre).
  if (!m || !m.actif) return OK;
  const cle = `shopify:${b.domaine}:${s.cle}`;
  const resa = await deps.store.reserverEvenement(b.tenantId, cle, s.sujet);
  if (resa === 'servi') return OK;
  if (resa === 'en_cours') return REESSAYER;
  try {
    let issue: IssueEvenement | 'en_cours';
    const manque = m.variables.some((v) => s.valeurs[v] === undefined);
    if (s.telephone === null) issue = 'sans_telephone';
    else if (manque || m.variables.some((v) => !DONNEES_PAR_EVENEMENT[s.evenement].includes(v))) issue = 'donnee_manquante';
    else {
      issue = await envoyerShopify(deps.envoyer, {
        tenantId: b.tenantId, cle, nomLigne: `Shopify · ${LIBELLE[s.evenement]} · ${s.numero}`,
        modele: m.modele, langue: m.langue, variables: m.variables, valeurs: s.valeurs, telephone: s.telephone,
        // Bornée comme toute source de consentement (`MAX_OPT_IN_SOURCE`) : trop longue, le destinataire serait écarté.
        sourceConsentement: b.consentementAffirme ? `shopify:${b.domaine}`.slice(0, MAX_OPT_IN_SOURCE) : null,
      });
    }
    // Un autre traitement tient la même clé d'envoi : le laisser finir, Shopify réessaiera.
    if (issue === 'en_cours') return REESSAYER;
    await deps.store.noterIssue(b.tenantId, cle, issue);
    if (s.telephone !== null) {
      const fiche = await deps.ficheParTelephone(b.tenantId, s.telephone);
      if (fiche !== null) await deps.store.lierCommande(b.tenantId, s.commandeId, s.clientId, fiche);
    }
    if (issue === 'limite_contacts') {
      await deps.emails.emettre({
        cle: 'shopify_limite_contacts', tenantId: b.tenantId, a: 'admins',
        occasion: moisDeParis((deps.maintenant ?? Date.now)()), valeurs: { boutique: b.domaine, lien_offre: deps.pageOffre },
      });
    }
    await deps.store.noterDernierEvenement(b.tenantId);
    return OK;
  } catch (err) {
    // Rien n'est perdu : la réservation repart, et l'envoi qui aurait pu partir est protégé par sa clé.
    journaliser('error', 'shopify_traitement_en_echec', { tenantId: b.tenantId, sujet: s.sujet, erreur: messageDe(err) });
    await deps.store.libererEvenement(b.tenantId, cle).catch(() => undefined);
    return REESSAYER;
  }
}

/**
 * `customers/redact` : les fiches liées aux commandes nommées ou au client Shopify, et celle de son numéro, DANS l'espace
 * de la boutique. Un échec rend 503 : Shopify réessaie.
 */
async function effacerClient(deps: DepsTraitementShopify, b: BoutiqueRecue, corps: unknown): Promise<ReponseTraitement> {
  const d = schemaEffacementClient.safeParse(corps);
  if (!d.success) return illisible(b, 'customers/redact');
  try {
    const ids = new Set(await deps.store.contactsLies(
      b.tenantId, (d.data.orders_to_redact ?? []).map(String), d.data.customer?.id ? String(d.data.customer.id) : null,
    ));
    const tel = telephoneE164([{ brut: d.data.customer?.phone }], b.pays);
    const parNumero = tel === null ? null : await deps.ficheParTelephone(b.tenantId, tel);
    // Ses paniers en attente partent aussi, fiche ou pas (relecture du lot 2).
    if (tel !== null) await deps.store.effacerPaniersDuTelephone(b.tenantId, tel);
    if (parNumero !== null) ids.add(parNumero);
    if (ids.size > 0) await deps.effacerFiches(b.tenantId, [...ids]);
    journaliser('info', 'shopify_client_efface', { tenantId: b.tenantId, fiches: ids.size });
    return OK;
  } catch (err) {
    journaliser('error', 'shopify_effacement_en_echec', { tenantId: b.tenantId, erreur: messageDe(err) });
    return REESSAYER;
  }
}
