import { isValidTemplateLanguage } from '../../web/lib/partage/langues-modeles';
import type { CreateTemplateInput } from '../meta/templates';
import { journaliser } from '../lib/journal';
import { messageDe } from '../lib/erreur';
import { supprimerUnModele, type DepsGestionModeles } from '../templates/gestion';
import type { Emission } from '../emails-produit/emission';
import {
  avecPrenomDeSecours, CATEGORIES_ADMISES, DELAI_PANIER_MAX, DELAI_PANIER_MIN, DONNEES_PAR_EVENEMENT, EVENEMENTS_DISPONIBLES,
  estEvenementShopify, type DonneeShopify, type EvenementShopify,
} from './donnees';
import type { Issue, Refus } from './gestion';
import type { AttenteMessage, PgShopifyStore } from './store.pg';
import { EXEMPLES_DONNEES, LIBELLES_EVENEMENTS, langueDuPied, PIED_STOP, TEXTES_PROPOSES } from '../../web/lib/partage/shopify-messages';

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
 *
 * Le ménage (demande de Julien, 2026-10-23) : chaque nouveau texte crée un NOUVEAU modèle chez Meta (aucune édition, donc
 * aucune limite de Meta sur les modifications). Le modèle qu'il remplace, s'il a été créé par l'assistant, est supprimé
 * chez Meta : sinon chaque retouche en laisserait un de plus dans l'écran Modèles, sous le plafond de modèles du compte.
 *
 * 🔴 LA SUPPRESSION EST DIFFÉRÉE (relecture du lot) : un geste ne fait que PROGRAMMER un travail (`oublierPlusTard`, file
 * `FILE_OUBLI_MODELE`), qui relit tout un quart d'heure plus tard (`traiterOubli`). Supprimée tout de suite, la version
 * remplacée ferait échouer les envois qui l'ont lue juste avant (une confirmation de commande en vol, un lot de relances
 * réclamé), et une préparation concurrente d'une approbation pourrait supprimer le modèle que l'approbation vient de
 * brancher. Le travail sort aussi l'appel à Meta de la file des messages entrants.
 */

/** Supprimer un modèle chez Meta, toutes langues : `supprimerUnModele` (garde des campagnes actives), traduite. */
export type SupprimerModele = (tenantId: string, nom: string) => Promise<{ ok: true } | { ok: false; message: string }>;

/** La file du ménage différé (`BASE_QUEUES`), consommée par le worker. */
export const FILE_OUBLI_MODELE = 'shopify-oubli-modele';
/** Le délai avant la suppression : plus long que tout envoi en vol (un lot de relances se vide en moins d'une minute). */
export const DELAI_OUBLI_MS = 15 * 60_000;
/** Un refus (une campagne active s'en sert) se retente toutes les heures, six fois au plus, puis s'abandonne. */
export const REESSAI_OUBLI_MS = 60 * 60_000;
export const ESSAIS_OUBLI = 6;

export interface JobOubli { tenantId: string; modele: string; essai: number }
/** Enfiler un travail du ménage à son heure (`queue.enqueue` avec `startAfter`, lié par le câblage). */
export type ProgrammerOubli = (job: JobOubli, quand: Date) => Promise<void>;

/** La mise en service de l'assistant : aucun de ses modèles n'est plus ancien. */
const DEBUT_ASSISTANT = Date.UTC(2026, 9, 22);
const NOM_DE_L_ASSISTANT = /^shopify_(order_paid|order_fulfilled|checkout_abandoned)_([0-9a-z]{8})$/;

/**
 * Le modèle a-t-il été créé par l'assistant ? Son nom EXACT : `shopify_<événement>_<horodatage en base 36>`, et cet
 * horodatage tombe entre la mise en service de l'assistant et maintenant (plus un jour de marge). 🔴 C'est la seule garde
 * qui dit « créé par l'assistant » : un nom choisi par le marchand ou par Claude Code (`commande_payee`,
 * `shopify_order_paid_v2`, `shopify_order_paid_20261023`, qui décodé tombe en 1974) n'est jamais supprimé.
 */
export function estModeleDeLAssistant(nom: string, maintenant: number = Date.now()): boolean {
  const m = NOM_DE_L_ASSISTANT.exec(nom);
  if (!m) return false;
  const quand = parseInt(m[2]!, 36);
  return quand >= DEBUT_ASSISTANT && quand <= maintenant + 24 * 3600_000;
}

/** La suppression de l'écran Modèles, liée par le câblage du worker : un refus ou une panne devient un message. */
export function suppressionDesModeles(deps: Pick<DepsGestionModeles, 'repo' | 'meta' | 'indices'>): SupprimerModele {
  return async (tenantId, nom) => {
    try {
      const issue = await supprimerUnModele(deps, tenantId, nom);
      if ('refus' in issue) return { ok: false, message: issue.refus.error };
      return issue.res.success ? { ok: true } : { ok: false, message: 'Meta n’a pas confirmé la suppression' };
    } catch (err) {
      return { ok: false, message: String(messageDe(err)) };
    }
  };
}

/**
 * Programmer l'oubli d'un modèle que ce geste remplace. Rien si le nom n'est pas celui de l'assistant, ou si c'est le
 * modèle qu'on vient de brancher (`garde`). Un enfilement qui échoue se journalise et ne bloque pas le geste : le
 * modèle reste simplement dans l'écran Modèles.
 */
export async function oublierPlusTard(
  deps: { programmerOubli: ProgrammerOubli; maintenant?: () => number },
  tenantId: string, modele: string | null | undefined, garde: string,
): Promise<void> {
  const maintenant = (deps.maintenant ?? Date.now)();
  if (!modele || modele === garde || !estModeleDeLAssistant(modele, maintenant)) return;
  try {
    await deps.programmerOubli({ tenantId, modele, essai: 0 }, new Date(maintenant + DELAI_OUBLI_MS));
  } catch (err) {
    journaliser('warn', 'shopify_modele_oubli_non_programme', { tenantId, modele, raison: String(messageDe(err)) });
  }
}

/**
 * Le travail du ménage (worker) : relire, puis supprimer le modèle s'il ne sert plus. Rien s'il est ENCORE branché à un
 * message ou attendu par une préparation (relus au moment même : un geste a pu le rebrancher entre-temps). Un refus se
 * retente une heure plus tard, `ESSAIS_OUBLI` fois au plus.
 */
export async function traiterOubli(
  deps: { store: Pick<PgShopifyStore, 'messages' | 'attentes'>; supprimerModele: SupprimerModele; programmerOubli: ProgrammerOubli; maintenant?: () => number },
  donnees: unknown,
): Promise<'supprime' | 'garde' | 'reessai' | 'abandon' | 'ignore'> {
  const j = donnees as Partial<JobOubli> | null;
  if (!j || typeof j.tenantId !== 'string' || typeof j.modele !== 'string' || typeof j.essai !== 'number') return 'ignore';
  const maintenant = (deps.maintenant ?? Date.now)();
  if (!estModeleDeLAssistant(j.modele, maintenant)) return 'ignore';
  const [messages, attentes] = await Promise.all([deps.store.messages(j.tenantId), deps.store.attentes(j.tenantId)]);
  if (messages.some((m) => m.modele === j.modele) || attentes.some((a) => a.modele === j.modele)) return 'garde';
  const r = await deps.supprimerModele(j.tenantId, j.modele);
  if (r.ok) {
    journaliser('info', 'shopify_modele_oublie', { tenantId: j.tenantId, modele: j.modele });
    return 'supprime';
  }
  if (j.essai + 1 < ESSAIS_OUBLI) {
    await deps.programmerOubli({ tenantId: j.tenantId, modele: j.modele, essai: j.essai + 1 }, new Date(maintenant + REESSAI_OUBLI_MS));
    journaliser('info', 'shopify_modele_oubli_reporte', { tenantId: j.tenantId, modele: j.modele, raison: r.message, essai: j.essai + 1 });
    return 'reessai';
  }
  journaliser('warn', 'shopify_modele_oubli_abandonne', { tenantId: j.tenantId, modele: j.modele, raison: r.message });
  return 'abandon';
}

export interface DepsPreparation {
  store: Pick<PgShopifyStore, 'lire' | 'brancher' | 'poserAttente' | 'retirerAttente' | 'affirmerConsentement'
    | 'retirerConsentement' | 'reglerDelaiPanier' | 'message' | 'messages' | 'attentes'>;
  /** Le ménage : programmer l'oubli du modèle remplacé, s'il vient de l'assistant (`oublierPlusTard`). */
  programmerOubli: ProgrammerOubli;
  /** La création de l'écran Modèles (creerUnModele), traduite : statut et catégorie de Meta, en minuscules. */
  creerModele(tenantId: string, input: CreateTemplateInput): Promise<{ ok: true; statut: string; categorie: string } | { ok: false; message: string }>;
  /** La date du nom du modèle ; injectable pour les tests. */
  maintenant?: () => number;
}

export interface DepsActivation {
  store: Pick<PgShopifyStore, 'lire' | 'brancher' | 'retirerAttente' | 'reglerDelaiPanier' | 'attenteDuModele' | 'messages' | 'attentes'>;
  /** Le ménage : programmer l'oubli du modèle que l'approbation remplace, ou de celui que Meta refuse. */
  programmerOubli: ProgrammerOubli;
  emails: { emettre(e: Emission): Promise<unknown> };
  /** La carte Shopify de la console (Tools > Intégrations, son ancre) : le lien des deux e-mails. */
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

/**
 * LE TEXTE SIMPLE D'UN NUMÉRO RELIÉ PAR QR CODE (plan 2026-10-23, tâche 5) : aucun modèle, donc aucune règle propre à
 * Meta (ni « pas de donnée au début ou à la fin », ni 1 024 caractères, ni 10 variables). La borne est celle d'un message
 * WhatsApp, et de la porte « écrire en premier » (`src/application/premier-message.ts`), annoncée dans le schéma de
 * `set_shopify_message`.
 */
export const TEXTE_SHOPIFY_MAX = 4096;

/**
 * Valide le texte d'un message Shopify : de 1 à `TEXTE_SHOPIFY_MAX` caractères, et chaque repère entre doubles
 * accolades est une donnée que l'événement sait remplir. 🔴 Un repère qui n'en est pas une ({{1}} recopié d'un modèle,
 * {{First_Name}}) est refusé : il partirait tel quel chez le client. Rend le texte nettoyé et les données citées, dans
 * l'ordre de leur première apparition.
 */
export function validerTexteShopify(evenement: EvenementShopify, texte: unknown):
  { ok: true; texte: string; variables: DonneeShopify[] } | { ok: false; message: string } {
  if (typeof texte !== 'string' || texte.trim() === '' || texte.length > TEXTE_SHOPIFY_MAX) {
    return { ok: false, message: `text : le message à envoyer, de 1 à ${TEXTE_SHOPIFY_MAX} caractères, les données Shopify entre doubles accolades ({{first_name}}).` };
  }
  const permises = DONNEES_PAR_EVENEMENT[evenement];
  const inconnu = (repere: string) => ({
    ok: false as const,
    message: `text : ${repere} n’est pas une donnée de cet événement (permises : ${permises.map((d) => `{{${d}}}`).join(', ')}).`,
  });
  const variables: DonneeShopify[] = [];
  for (const m of texte.matchAll(REPERE)) {
    const donnee = permises.find((d) => d === m[1]);
    if (!donnee) return inconnu(m[0]);
    if (!variables.includes(donnee)) variables.push(donnee);
  }
  const reste = /\{\{[^{}]*\}\}/.exec(texte.replace(REPERE, ''));
  if (reste) return inconnu(reste[0]);
  return { ok: true, texte: texte.trim(), variables };
}

/**
 * Le texte qui part : chaque repère remplacé par sa valeur, le prénom absent par son mot de secours, et pour la relance
 * de panier seulement, la consigne STOP en dernière ligne (comme le pied du modèle sur l'API). 🔴 Une donnée manquante
 * se constate AVANT (`donnee_manquante`, dans le traitement) : ici, un repère sans valeur resterait tel quel.
 */
export function composerTexteShopify(
  texte: string, evenement: EvenementShopify, valeurs: Partial<Record<DonneeShopify, string>>, langue: string,
): string {
  const v = avecPrenomDeSecours(valeurs, langue);
  const permises = DONNEES_PAR_EVENEMENT[evenement];
  const corps = texte.trim().replace(REPERE, (tout, cle: string) => {
    const donnee = permises.find((d) => d === cle);
    return donnee === undefined ? tout : (v[donnee] ?? tout);
  });
  return evenement === 'checkout_abandoned' ? `${corps}\n\n${PIED_STOP[langueDuPied(langue)]}` : corps;
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
  // Ce que ce geste remplacera, lu AVANT : l'attente précédente de l'événement, et le message en place.
  const [attenteAvant, actifAvant] = await Promise.all([
    deps.store.attentes(tenantId).then((as) => as.find((a) => a.evenement === evenement) ?? null),
    deps.store.message(tenantId, evenement),
  ]);
  const categorie = relance ? 'MARKETING' : 'UTILITY';
  const cree = await deps.creerModele(tenantId, {
    name: modele, category: categorie, language: langue, body: c.corps,
    ...(c.exemples.length > 0 ? { example: c.exemples } : {}),
    ...(relance ? { footer: PIED_STOP[langueDuPied(langue)] } : {}),
  });
  if (!cree.ok) return refus(422, `La création du modèle chez Meta a échoué : ${cree.message}`);
  // Un refus dès la création ne viendra pas forcément par le statut : le dire tout de suite plutôt que d'attendre.
  if (cree.statut === 'rejected') {
    await oublierPlusTard(deps, tenantId, modele, '');
    return refus(422, 'Meta a refusé ce modèle dès sa création : reformulez le texte (sans promotion pour un message de commande), puis réessayez.');
  }
  // Meta peut reclasser un modèle de service en marketing : un message de commande n'est admis qu'en service.
  if (!(CATEGORIES_ADMISES[evenement] as readonly string[]).includes(cree.categorie)) {
    await oublierPlusTard(deps, tenantId, modele, '');
    return refus(422, `Meta a classé ce message en ${cree.categorie} : un message de commande doit rester un message de service. Retirez-en toute promotion, puis réessayez.`);
  }
  const delaiMinutes = relance && typeof p.delaiMinutes === 'number' ? p.delaiMinutes : null;
  if (cree.statut === 'approved') {
    await activer(deps.store, tenantId, { evenement, modele, langue, variables: c.variables, delaiMinutes });
    // Le dernier geste gagne : une attente plus ancienne du même événement ne s'activera pas par-dessus.
    const retiree = await deps.store.retirerAttente(tenantId, { evenement });
    await oublierPlusTard(deps, tenantId, actifAvant?.modele, modele);
    await oublierPlusTard(deps, tenantId, retiree?.modele, modele);
    return { ok: true, valeur: { etat: 'actif', modele } };
  }
  await deps.store.poserAttente(tenantId, { evenement, modele, langue, variables: c.variables, delaiMinutes, par });
  // La version précédente, encore en validation, ne s'activera jamais : elle part. Le message ACTIF, lui, reste.
  await oublierPlusTard(deps, tenantId, attenteAvant?.modele, modele);
  journaliser('info', 'shopify_message_prepare', { tenantId, evenement, modele });
  return { ok: true, valeur: { etat: 'en_validation', modele } };
}

/** Branche le message approuvé, avec son délai. L'attente se retire APRÈS, par l'appelant. */
async function activer(
  store: Pick<PgShopifyStore, 'brancher' | 'reglerDelaiPanier'>, tenantId: string,
  a: Pick<AttenteMessage, 'evenement' | 'modele' | 'langue' | 'variables' | 'delaiMinutes'>,
): Promise<void> {
  await store.brancher(tenantId, { evenement: a.evenement, modele: a.modele, texte: null, langue: a.langue, variables: a.variables, actif: true, par: null });
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
  // Le modèle en place, que l'approbation va remplacer : lu AVANT de brancher.
  const actifAvant = (await deps.store.messages(tenantId)).find((m) => m.evenement === attente.evenement) ?? null;
  const valeurs = { boutique: boutique?.domaine ?? '', message: LIBELLES_EVENEMENTS[attente.evenement][0], lien_parametres: deps.pageParametres };
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
    await oublierPlusTard(deps, tenantId, actifAvant?.modele, s.modele);
    return 'active';
  }
  if ((await deps.store.retirerAttente(tenantId, { modele: s.modele, langue: s.langue })) === null) return 'rien';
  // Le modèle refusé ne servira jamais : il part (le message actif, lui, reste en place).
  await oublierPlusTard(deps, tenantId, s.modele, actifAvant?.modele ?? '');
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
