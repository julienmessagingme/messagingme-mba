import { isValidTemplateLanguage } from '../../web/lib/partage/langues-modeles';
import type { CreateTemplateInput } from '../meta/templates';
import { journaliser } from '../lib/journal';
import type { Emission } from '../emails-produit/emission';
import {
  CATEGORIES_ADMISES, DELAI_PANIER_MAX, DELAI_PANIER_MIN, DONNEES_PAR_EVENEMENT, EVENEMENTS_DISPONIBLES, estEvenementShopify,
  type DonneeShopify, type EvenementShopify,
} from './donnees';
import type { Issue, Refus } from './gestion';
import type { AttenteMessage, PgShopifyStore } from './store.pg';
import { EXEMPLES_DONNEES, langueDuPied, PIED_STOP, TEXTES_PROPOSES } from '../../web/lib/partage/shopify-messages';

// Le pied STOP et les textes proposés vivent dans le module que la console partage : l'aperçu de l'assistant et le
// modèle créé chez Meta disent la même chose.
export { PIED_STOP, TEXTES_PROPOSES };

/**
 * L'ASSISTANT DES MESSAGES SHOPIFY DE LA CONSOLE (conception 2026-10-22, plan lot 1) : préparer un message (le texte
 * devient un modèle créé chez Meta), puis l'activer SEUL à l'approbation de Meta.
 *
 * 🔴 Ce qui se joue : une relance de panier est un message marketing. Elle ne se prépare jamais sans le consentement
 * affirmé (celui de la boutique, ou celui de l'appel), et ne s'active jamais avant l'approbation de Meta. Le message
 * ACTIF n'est jamais touché par une préparation : il continue de partir jusqu'à l'approbation du nouveau, et reste en
 * place si Meta refuse (le marchand le sait par e-mail).
 *
 * Le dernier geste gagne : une nouvelle préparation remplace l'attente de l'événement, un branchement direct (Claude
 * Code, set_shopify_message) la retire.
 */

export interface DepsPreparation {
  store: Pick<PgShopifyStore, 'lire' | 'brancher' | 'poserAttente' | 'retirerAttente' | 'affirmerConsentement'
    | 'retirerConsentement' | 'reglerDelaiPanier' | 'message'>;
  /** La création de l'écran Modèles (creerUnModele), traduite : statut et catégorie de Meta, en minuscules. */
  creerModele(tenantId: string, input: CreateTemplateInput): Promise<{ ok: true; statut: string; categorie: string } | { ok: false; message: string }>;
  /** La date du nom du modèle ; injectable pour les tests. */
  maintenant?: () => number;
}

export interface DepsActivation {
  store: Pick<PgShopifyStore, 'lire' | 'brancher' | 'retirerAttente' | 'reglerDelaiPanier' | 'attenteDuModele'>;
  emails: { emettre(e: Emission): Promise<unknown> };
  /** La page Paramètres de la console, où vit la carte Shopify : le lien des deux e-mails. */
  pageParametres: string;
}

const refus = (statut: Refus['statut'], message: string): Refus => ({ ok: false, statut, message });

/** Un repère du texte de l'assistant : une donnée Shopify entre doubles accolades, {{first_name}}. */
const REPERE = /\{\{\s*([a-z_]+)\s*\}\}/g;
/** Les variables d'un modèle (borne de la gestion, VARIABLES_MAX) et la longueur d'un corps chez Meta. */
const VARIABLES_MAX = 10;
const CORPS_MAX = 1024;


/**
 * Le texte de l'assistant vers un corps de modèle : chaque repère devient {{1}}, {{2}}... dans l'ordre d'apparition, et
 * la liste des variables suit le même ordre. Seules les données que l'événement sait remplir sont permises.
 */
export function versCorps(evenement: EvenementShopify, texte: unknown):
  { ok: true; corps: string; variables: DonneeShopify[]; exemples: string[] } | { ok: false; message: string } {
  if (typeof texte !== 'string' || texte.trim() === '') return { ok: false, message: 'texte : le message à envoyer.' };
  const permises = DONNEES_PAR_EVENEMENT[evenement];
  const variables: DonneeShopify[] = [];
  let inconnu: string | null = null;
  const corps = texte.trim().replace(REPERE, (tout, cle: string) => {
    const donnee = permises.find((d) => d === cle);
    if (!donnee) {
      inconnu ??= cle;
      return tout;
    }
    variables.push(donnee);
    return `{{${variables.length}}}`;
  });
  if (inconnu !== null) {
    return { ok: false, message: `texte : {{${inconnu}}} n’est pas une donnée de cet événement (permises : ${permises.map((d) => `{{${d}}}`).join(', ')}).` };
  }
  if (variables.length > VARIABLES_MAX) return { ok: false, message: `texte : ${VARIABLES_MAX} données au plus dans un message.` };
  // Meta refuse un corps qui commence ou finit par une variable : le dire ici, avant de lui envoyer le modèle.
  if (/^\{\{\d+\}\}/.test(corps) || /\{\{\d+\}\}$/.test(corps)) {
    return { ok: false, message: 'texte : le message ne peut ni commencer ni finir par une donnée ; ajoutez quelques mots avant ou après.' };
  }
  if (corps.length > CORPS_MAX) return { ok: false, message: `texte : ${CORPS_MAX} caractères au plus.` };
  return { ok: true, corps, variables, exemples: variables.map((v) => EXEMPLES_DONNEES[v]) };
}

export interface Preparation {
  evenement: unknown;
  texte: unknown;
  langue: unknown;
  /** checkout_abandoned seulement. */
  delaiMinutes?: unknown;
  /** L'affirmation de la boutique (une par boutique) : true l'affirme, absente la laisse telle quelle. */
  consentementAffirme?: unknown;
}

export interface IssuePreparation {
  /** actif : Meta a approuvé tout de suite ; en_validation : le message s'activera seul à l'approbation. */
  etat: 'actif' | 'en_validation';
  modele: string;
}

export async function preparerMessage(deps: DepsPreparation, tenantId: string, p: Preparation, par: string | null): Promise<Issue<IssuePreparation>> {
  if (!estEvenementShopify(p.evenement) || !EVENEMENTS_DISPONIBLES.includes(p.evenement)) {
    return refus(400, `evenement : un de ${EVENEMENTS_DISPONIBLES.join(', ')}.`);
  }
  const evenement = p.evenement;
  if (typeof p.langue !== 'string' || !isValidTemplateLanguage(p.langue)) return refus(400, 'langue : une langue WhatsApp (fr, en_US...).');
  const langue = p.langue;
  const boutique = await deps.store.lire(tenantId);
  if (boutique === null) return refus(409, 'Aucune boutique Shopify n’est branchée : branchez-la d’abord.');
  if (boutique.etat !== 'connectee') return refus(409, 'La boutique Shopify est coupée : rebranchez-la d’abord.');
  const relance = evenement === 'checkout_abandoned';
  if (p.delaiMinutes !== undefined && p.delaiMinutes !== null) {
    if (!relance) return refus(400, 'delaiMinutes : seulement pour la relance de panier.');
    if (typeof p.delaiMinutes !== 'number' || !Number.isInteger(p.delaiMinutes) || p.delaiMinutes < DELAI_PANIER_MIN || p.delaiMinutes > DELAI_PANIER_MAX) {
      return refus(400, `delaiMinutes : un nombre entier de minutes, de ${DELAI_PANIER_MIN} à ${DELAI_PANIER_MAX}.`);
    }
  }
  if (p.consentementAffirme !== undefined && typeof p.consentementAffirme !== 'boolean') return refus(400, 'consentementAffirme : true ou false.');
  // Retirer l'affirmation vaut pour toute la boutique : c'est le réglage qui le fait, et qui le dit (relecture des lots 0
  // et 1 : ici, `false` était accepté sans rien faire).
  if (p.consentementAffirme === false) return refus(400, 'consentementAffirme : true pour affirmer ; le retrait se fait par le réglage du message.');
  if (relance && boutique.consentement === null && p.consentementAffirme !== true) {
    return refus(409, 'La relance de panier est un message marketing : affirmez d’abord que vos clients ont accepté de recevoir vos messages WhatsApp.');
  }
  const c = versCorps(evenement, p.texte);
  if (!c.ok) return refus(400, c.message);

  if (p.consentementAffirme === true) await deps.store.affirmerConsentement(tenantId, par);
  const modele = `shopify_${evenement}_${(deps.maintenant ?? Date.now)().toString(36)}`;
  const categorie = relance ? 'MARKETING' : 'UTILITY';
  const cree = await deps.creerModele(tenantId, {
    name: modele, category: categorie, language: langue, body: c.corps,
    ...(c.exemples.length > 0 ? { example: c.exemples } : {}),
    ...(relance ? { footer: PIED_STOP[langueDuPied(langue)] } : {}),
  });
  if (!cree.ok) return refus(422, `Meta refuse ce modèle : ${cree.message}`);
  // Un refus dès la création ne viendra pas forcément par le statut : le dire tout de suite plutôt que d'attendre.
  if (cree.statut === 'rejected') {
    return refus(422, 'Meta a refusé ce modèle dès sa création : reformulez le texte (sans promotion pour un message de commande), puis réessayez.');
  }
  // Meta peut reclasser un modèle de service en marketing : un message de commande n'est admis qu'en service.
  if (!(CATEGORIES_ADMISES[evenement] as readonly string[]).includes(cree.categorie)) {
    return refus(422, `Meta a classé ce message en ${cree.categorie} : un message de commande doit rester un message de service. Retirez-en toute promotion, puis réessayez.`);
  }
  const delaiMinutes = relance && typeof p.delaiMinutes === 'number' ? p.delaiMinutes : null;
  if (cree.statut === 'approved') {
    await activer(deps.store, tenantId, { evenement, modele, langue, variables: c.variables, delaiMinutes });
    // Le dernier geste gagne : une attente plus ancienne du même événement ne s'activera pas par-dessus.
    await deps.store.retirerAttente(tenantId, { evenement });
    return { ok: true, valeur: { etat: 'actif', modele } };
  }
  await deps.store.poserAttente(tenantId, { evenement, modele, langue, variables: c.variables, delaiMinutes, par });
  journaliser('info', 'shopify_message_prepare', { tenantId, evenement, modele });
  return { ok: true, valeur: { etat: 'en_validation', modele } };
}

/** Branche le message approuvé, avec son délai. L'attente se retire APRÈS, par l'appelant. */
async function activer(
  store: Pick<PgShopifyStore, 'brancher' | 'reglerDelaiPanier'>, tenantId: string,
  a: Pick<AttenteMessage, 'evenement' | 'modele' | 'langue' | 'variables' | 'delaiMinutes'>,
): Promise<void> {
  await store.brancher(tenantId, { evenement: a.evenement, modele: a.modele, langue: a.langue, variables: a.variables, actif: true, par: null });
  if (a.delaiMinutes !== null) await store.reglerDelaiPanier(tenantId, a.delaiMinutes);
}

export interface Reglage {
  evenement: unknown;
  delaiMinutes?: unknown;
  consentementAffirme?: unknown;
}

/**
 * Le délai et la case, sans repasser par Meta (le texte n'a pas changé). Retirer l'affirmation la retire pour toute la
 * boutique : la relance cesse alors de noter et de relancer (gardes du traitement et du balayage), et la réponse le dit.
 */
export async function reglerMessage(deps: Pick<DepsPreparation, 'store'>, tenantId: string, r: Reglage, par: string | null): Promise<Issue<{ relanceArretee: boolean }>> {
  if (!estEvenementShopify(r.evenement)) return refus(400, `evenement : un de ${EVENEMENTS_DISPONIBLES.join(', ')}.`);
  const boutique = await deps.store.lire(tenantId);
  if (boutique === null) return refus(409, 'Aucune boutique Shopify n’est branchée.');
  if (r.delaiMinutes !== undefined) {
    if (r.evenement !== 'checkout_abandoned') return refus(400, 'delaiMinutes : seulement pour la relance de panier.');
    if (typeof r.delaiMinutes !== 'number' || !Number.isInteger(r.delaiMinutes) || r.delaiMinutes < DELAI_PANIER_MIN || r.delaiMinutes > DELAI_PANIER_MAX) {
      return refus(400, `delaiMinutes : un nombre entier de minutes, de ${DELAI_PANIER_MIN} à ${DELAI_PANIER_MAX}.`);
    }
  }
  if (r.consentementAffirme !== undefined && typeof r.consentementAffirme !== 'boolean') return refus(400, 'consentementAffirme : true ou false.');
  if (typeof r.delaiMinutes === 'number') await deps.store.reglerDelaiPanier(tenantId, r.delaiMinutes);
  let relanceArretee = false;
  if (r.consentementAffirme === true) await deps.store.affirmerConsentement(tenantId, par);
  if (r.consentementAffirme === false && boutique.consentement !== null) {
    await deps.store.retirerConsentement(tenantId);
    relanceArretee = (await deps.store.message(tenantId, 'checkout_abandoned'))?.actif === true;
  }
  return { ok: true, valeur: { relanceArretee } };
}

/** Les libellés des messages, dans les e-mails. */
const LIBELLES: Readonly<Record<EvenementShopify, string>> = {
  order_paid: 'Commande payée', order_fulfilled: 'Commande expédiée', checkout_abandoned: 'Relance de panier abandonné',
};

/**
 * Le statut d'un modèle tranché par Meta, pour une boutique de l'espace : APPROVED active le message préparé qui porte
 * CE modèle, REJECTED retire l'attente et prévient (le message actif reste en place). Sans attente pour ce modèle (un
 * branchement direct l'a retirée, ou c'est un autre modèle), rien. Appelé par le traitement des statuts (worker) et par
 * le filet (API).
 */
export async function activerSelonStatut(
  deps: DepsActivation, tenantId: string, s: { modele: string; langue: string; statut: string; raison: string | null },
): Promise<'active' | 'refuse' | 'rien'> {
  const statut = s.statut.toUpperCase();
  if (statut !== 'APPROVED' && statut !== 'REJECTED') return 'rien';
  if (!s.modele.startsWith('shopify_')) return 'rien';
  const attente = await deps.store.attenteDuModele(tenantId, s.modele, s.langue);
  if (attente === null) return 'rien';
  const boutique = await deps.store.lire(tenantId);
  const valeurs = { boutique: boutique?.domaine ?? '', message: LIBELLES[attente.evenement], lien_parametres: deps.pageParametres };
  if (statut === 'APPROVED') {
    // 🔴 BRANCHER AVANT DE RETIRER L'ATTENTE (relecture des lots 0 et 1) : une panne entre les deux laisse l'attente, que
    // le rejeu du statut ou le filet retrouve ; dans l'autre ordre, le message était perdu sans trace. Un second passage
    // (statut et filet) rebranche à l'identique et ne trouve plus rien à retirer : l'e-mail ne part qu'une fois.
    if (boutique !== null) await activer(deps.store, tenantId, attente);
    const retiree = await deps.store.retirerAttente(tenantId, { modele: s.modele, langue: s.langue });
    if (retiree === null || boutique === null) return 'rien';
    // L'e-mail « actif » ne dit que la vérité : une boutique coupée, ou une relance dont l'affirmation a été retirée
    // pendant la validation, ne part pas (les gardes de l'envoi la retiennent ; la carte la montre en pause).
    const part = boutique.etat === 'connectee' && (attente.evenement !== 'checkout_abandoned' || boutique.consentement !== null);
    if (part) await deps.emails.emettre({ cle: 'shopify_message_actif', tenantId, a: 'admins', occasion: s.modele, valeurs }).catch(() => undefined);
    journaliser('info', 'shopify_message_active', { tenantId, evenement: attente.evenement, modele: s.modele, part });
    return 'active';
  }
  if ((await deps.store.retirerAttente(tenantId, { modele: s.modele, langue: s.langue })) === null) return 'rien';
  await deps.emails.emettre({
    cle: 'shopify_modele_refuse', tenantId, a: 'admins', occasion: s.modele, valeurs: { ...valeurs, raison: (s.raison ?? 'non précisée').slice(0, 300) },
  }).catch(() => undefined);
  journaliser('info', 'shopify_modele_refuse', { tenantId, evenement: attente.evenement, modele: s.modele });
  return 'refuse';
}

/** Le filet : relire chez Meta les modèles des attentes anciennes, au cas où leur statut ne serait pas arrivé. */
export async function relireAttentes(
  deps: DepsActivation & {
    store: DepsActivation['store'] & Pick<PgShopifyStore, 'attentesAnciennes'>;
    statutModele(tenantId: string, modele: string, langue: string): Promise<{ statut: string; raison: string | null } | null>;
  },
  minutes: number, limite: number,
): Promise<number> {
  let tranches = 0;
  for (const a of await deps.store.attentesAnciennes(minutes, limite)) {
    const s = await deps.statutModele(a.tenantId, a.modele, a.langue).catch(() => null);
    if (s === null) continue;
    if ((await activerSelonStatut(deps, a.tenantId, { modele: a.modele, langue: a.langue, ...s })) !== 'rien') tranches += 1;
  }
  return tranches;
}
