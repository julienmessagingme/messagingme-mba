import { estSuppression, type Operation } from './proposition';
import type { LigneHistorique } from '../../reglages/historique';
import { messageDe, texteDe } from '../../lib/erreur';
import { ecrireRollout, type Skill } from '../client';
import {
  ID_MESSAGE_RE, validerCreation, validerModification,
  type CreationMessageInteractif, type MessageInteractif, type ModificationMessageInteractif,
} from '../messages-interactifs';

/**
 * Appliquer un diff chez Meta, opération par opération, en s'arrêtant à la première erreur avec l'état exact :
 * Meta n'offre aucune transaction, et « tout annuler » à la main pourrait échouer à son tour. Rien n'est
 * journalisé pour une opération qui a échoué. Le contenu supprimé, comme la consigne qu'une modification remplace,
 * est lu avant d'écrire : c'est le seul exemplaire qui en restera.
 */

/** Ce dont l'application a besoin. Interface étroite : satisfaite par le vrai client MBA comme par un faux. */
export interface ApplicationDeps {
  /** Le numéro Meta de l'espace. `null` = rien à faire, l'espace n'a pas de MBA. */
  numeros: { getTenantPhoneNumberId(tenantId: string): Promise<string | null> };
  meta: { mbaClientForTenant(tenantId: string): Promise<ClientMbaEcriture> };
  /** Écrit une ligne d'historique. Voir `src/reglages/historique.ts`. */
  historique: { ecrire(tenantId: string, ligne: LigneHistorique): Promise<void> };
  /** Qui agit, pour l'historique. */
  acteur: { id: string | null; email: string | null };
  /**
   * Notre drapeau `tenant_settings.mba_enabled`, écrit après la mise en service chez Meta, comme les deux
   * interrupteurs de la console : toute la mécanique de la liste le lit. Requis : oublié, l'agent serait allumé chez
   * Meta et éteint pour nous, et les réponses rangées en `standby` n'arriveraient à personne.
   */
  drapeau: { setMbaEnabled(tenantId: string, enabled: boolean): Promise<void> };
  /** Attendre avant la seconde relecture de l'audience à l'allumage (`ecrireRollout`). Injectée : les tests ne dorment pas. */
  attendre(ms: number): Promise<void>;
  /**
   * 🔴 Ce formulaire est-il un formulaire PUBLIÉ de CET espace (`PgFlowStore.isPublished`) ? Le modèle choisit un
   * identifiant dans la liste qu'on lui montre, mais rien ne l'empêche d'en écrire un autre : sans ce contrôle, un
   * espace ferait ouvrir par son agent le formulaire d'un autre espace.
   */
  formulaires: { estPublie(tenantId: string, flowId: string): Promise<boolean> };
}

/** Ce que l'application attend du client Meta, sous-ensemble strict de `MbaClient`. */
export interface ClientMbaEcriture {
  listFaqs(p: string): Promise<Array<{ id?: string; question?: string; answer?: string }>>;
  createFaq(p: string, faq: unknown): Promise<unknown>;
  updateFaq(p: string, id: string, faq: unknown): Promise<unknown>;
  deleteFaq(p: string, id: string): Promise<void>;
  /**
   * 🔴 Le corps est `Skill`, pas `unknown` : typé `unknown`, il a laissé partir `{ name, instruction }` jusqu'au
   * 2026-10-08, que Meta refusait à la création et ignorait à la modification. Le compilateur garde la forme.
   */
  listSkills(p: string, agentId: string): Promise<Skill[]>;
  createSkill(p: string, agentId: string, s: Skill): Promise<unknown>;
  updateSkill(p: string, id: string, s: Skill): Promise<unknown>;
  deleteSkill(p: string, id: string): Promise<void>;
  listWebsites(p: string): Promise<Array<{ id?: string; url?: string }>>;
  createWebsite(p: string, url: string): Promise<unknown>;
  deleteWebsite(p: string, id: string): Promise<void>;
  listFiles(p: string): Promise<Array<{ id?: string; name?: string }>>;
  deleteFile(p: string, id: string): Promise<void>;
  /**
   * `unknown` et non `Record<string, unknown>` : le vrai `MbaClient` rend un type nommé (`BusinessInfo`), sans
   * index de chaîne, donc non assignable ; resserrer ici obligerait à affaiblir ce type.
   */
  getBusinessInfo(p: string): Promise<unknown>;
  putBusinessInfo(p: string, info: unknown): Promise<unknown>;
  getSettings(p: string): Promise<unknown>;
  putSettings(p: string, s: unknown, agentId?: string): Promise<unknown>;
  listMessagesInteractifs(p: string): Promise<MessageInteractif[]>;
  creerMessageInteractif(p: string, c: CreationMessageInteractif): Promise<unknown>;
  modifierMessageInteractif(p: string, id: string, v: ModificationMessageInteractif): Promise<unknown>;
  supprimerMessageInteractif(p: string, id: string): Promise<void>;
}

/**
 * Un refus que NOUS opposons avant d'appeler Meta (une borne en octets, un formulaire qui n'est pas publié dans
 * l'espace) : son message est déjà en français et destiné au client, `raisonLisible` le rend tel quel.
 */
export class RefusAvantMeta extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusAvantMeta';
  }
}

export interface EchecOperation {
  operation: Operation;
  /** En français, destiné au client. Le message brut de Meta va dans les journaux, pas ici. */
  message: string;
}

export interface ResultatApplication {
  passees: Operation[];
  echec: EchecOperation | null;
  /** Celles qu'on n'a même pas tentées, parce qu'on s'est arrêté avant. */
  nonTentees: Operation[];
}

/** Le libellé d'une opération, pour le diff et pour l'historique. PUR. */
export function libelleDe(o: Operation): string {
  switch (o.type) {
    case 'faq.ajouter': return `FAQ : ${o.question}`;
    case 'faq.modifier': return `FAQ : ${o.question}`;
    case 'faq.supprimer': return `FAQ : ${o.libelle}`;
    case 'competence.ajouter': return `Consigne : ${o.titre}`;
    case 'competence.modifier': return `Consigne : ${o.titre}`;
    case 'competence.supprimer': return `Consigne : ${o.libelle}`;
    case 'message_interactif.ajouter': return `Message interactif : ${o.titre}`;
    case 'message_interactif.modifier': return `Message interactif : ${o.titre}`;
    case 'message_interactif.supprimer': return `Message interactif : ${o.libelle}`;
    case 'site.ajouter': return `Site : ${o.url}`;
    case 'site.supprimer': return `Site : ${o.libelle}`;
    case 'fichier.supprimer': return `Document : ${o.libelle}`;
    case 'business.modifier': return `Fiche d’activité : ${o.champ}`;
    case 'activation.mettreEnService': return 'Mise en service de l’agent';
    default: return 'Modification';
  }
}

/** L'élément d'historique visé par une opération. PUR. */
export function elementDe(o: Operation): LigneHistorique['element'] {
  const famille = o.type.split('.')[0];
  return ({
    faq: 'faq', competence: 'competence', site: 'site', fichier: 'fichier',
    business: 'business_info', activation: 'activation', message_interactif: 'message_interactif',
  } as const)[famille as 'faq'] ?? 'faq';
}

/** L'opération d'historique correspondante. PUR. */
export function operationDe(o: Operation): LigneHistorique['operation'] {
  if (estSuppression(o)) return 'suppression';
  return o.type.endsWith('.ajouter') || o.type === 'activation.mettreEnService' ? 'ajout' : 'modification';
}

/**
 * Traduit une erreur de Meta en une phrase destinée au client. Le message brut (anglais, codes internes) reste
 * dans les journaux serveur.
 */
export function raisonLisible(err: unknown): string {
  if (err instanceof RefusAvantMeta) return err.message;
  const brut = texteDe(err);
  if (/blocked/i.test(brut)) return 'Meta a refusé ce contenu. Reformulez-le, puis réessayez.';
  if (/rate|429|limit/i.test(brut)) return 'Meta nous a demandé de ralentir. Réessayez dans un instant.';
  if (/not found|404/i.test(brut)) return 'Cet élément n’existe plus chez Meta : quelqu’un l’a peut-être supprimé entre-temps.';
  return 'Meta a refusé cette modification.';
}

/**
 * Applique les opérations dans l'ordre et s'arrête à la première qui échoue. Ne lève jamais : l'appelant, une
 * route, rend un compte rendu, et tout ressort dans `echec`.
 */
export async function appliquer(
  deps: ApplicationDeps,
  tenantId: string,
  agentId: string,
  operations: readonly Operation[],
): Promise<ResultatApplication> {
  const passees: Operation[] = [];
  const numero = await deps.numeros.getTenantPhoneNumberId(tenantId);
  if (!numero) {
    return {
      passees: [],
      echec: operations[0]
        ? { operation: operations[0], message: 'Aucun numéro WhatsApp n’est rattaché à cet espace.' }
        : null,
      nonTentees: operations.slice(1),
    };
  }
  const client = await deps.meta.mbaClientForTenant(tenantId);

  for (let i = 0; i < operations.length; i += 1) {
    const o = operations[i]!;
    try {
      const avant = await etatAvant(client, numero, agentId, o);
      await executer(deps, tenantId, client, numero, agentId, o);
      passees.push(o);
      await journaliserOuTaire(deps, tenantId, o, avant);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`assistant MBA : « ${libelleDe(o)} » refusée par Meta (${tenantId}) :`, messageDe(err));
      return { passees, echec: { operation: o, message: raisonLisible(err) }, nonTentees: operations.slice(i + 1) };
    }
  }
  return { passees, echec: null, nonTentees: [] };
}

/**
 * Écrit la ligne d'historique, sans jamais faire échouer l'opération : une panne de notre journal survient après
 * que Meta a accepté l'écriture, et la traiter en échec afficherait l'opération faite et arrêtée à la fois,
 * accuserait Meta, et abandonnerait les suivantes. Best-effort : on perd une ligne, pas un geste déjà passé.
 */
async function journaliserOuTaire(
  deps: ApplicationDeps, tenantId: string, o: Operation, avant: unknown,
): Promise<void> {
  try {
    await deps.historique.ecrire(tenantId, {
      surface: 'mba',
      surfaceId: null,
      element: elementDe(o),
      operation: operationDe(o),
      cible: 'cible' in o ? o.cible : null,
      libelle: libelleDe(o),
      avant,
      apres: apresDe(o),
      origine: 'assistant',
      acteurEmail: deps.acteur.email,
      acteurId: deps.acteur.id,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`assistant MBA : « ${libelleDe(o)} » appliquée mais NON journalisée (${tenantId}) :`, messageDe(err));
  }
}

/**
 * L'état avant, lu avant de toucher à quoi que ce soit. Les suppressions en ont besoin, absolument : Meta ne rend plus
 * un objet parti. La modification d'une consigne aussi : son `PUT` remplace le corps entier (jusqu'à 20 000
 * caractères écrits dans l'onglet), que le modèle n'a pas vu ; l'historique en garde la copie. Au mieux : une lecture
 * ratée ne bloque pas la modification, elle laisse `null`.
 */
async function etatAvant(
  client: ClientMbaEcriture, numero: string, agentId: string, o: Operation,
): Promise<unknown> {
  if (o.type === 'competence.modifier') {
    return (await client.listSkills(numero, agentId).catch(() => null))?.find((s) => s.id === o.cible) ?? null;
  }
  if (!estSuppression(o)) return null;
  const cible = 'cible' in o ? o.cible : '';
  if (o.type === 'faq.supprimer') return (await client.listFaqs(numero)).find((f) => f.id === cible) ?? { id: cible };
  if (o.type === 'competence.supprimer') return (await client.listSkills(numero, agentId)).find((s) => s.id === cible) ?? { id: cible };
  if (o.type === 'site.supprimer') return (await client.listWebsites(numero)).find((w) => w.id === cible) ?? { id: cible };
  if (o.type === 'fichier.supprimer') return (await client.listFiles(numero)).find((f) => f.id === cible) ?? { id: cible };
  if (o.type === 'message_interactif.supprimer') return (await client.listMessagesInteractifs(numero)).find((m) => m.id === cible) ?? { id: cible };
  return { id: cible };
}

/** Ce que l'opération a posé, pour l'historique. `null` pour une suppression. */
function apresDe(o: Operation): unknown {
  if (estSuppression(o)) return null;
  const { type: _t, ...reste } = o as Record<string, unknown> & { type: string };
  return reste;
}

async function executer(
  deps: ApplicationDeps, tenantId: string, client: ClientMbaEcriture, numero: string, agentId: string, o: Operation,
): Promise<void> {
  switch (o.type) {
    case 'faq.ajouter': await client.createFaq(numero, { question: o.question, answer: o.reponse }); return;
    case 'faq.modifier': await client.updateFaq(numero, o.cible, { question: o.question, answer: o.reponse }); return;
    case 'faq.supprimer': await client.deleteFaq(numero, o.cible); return;
    case 'competence.ajouter': await client.createSkill(numero, agentId, versSkill(o)); return;
    // La cible entre telle quelle dans le chemin de Meta : comme pour un message interactif, rien qui l'en fasse sortir
    // (`..` remonterait d'un cran, et `encodeURIComponent` ne l'encode pas).
    case 'competence.modifier':
      if (!ID_MESSAGE_RE.test(o.cible)) throw new RefusAvantMeta('Identifiant de consigne invalide.');
      await client.updateSkill(numero, o.cible, versSkill(o));
      return;
    case 'competence.supprimer':
      if (!ID_MESSAGE_RE.test(o.cible)) throw new RefusAvantMeta('Identifiant de consigne invalide.');
      await client.deleteSkill(numero, o.cible);
      return;
    case 'site.ajouter': await client.createWebsite(numero, o.url); return;
    case 'site.supprimer': await client.deleteWebsite(numero, o.cible); return;
    case 'fichier.supprimer': await client.deleteFile(numero, o.cible); return;
    case 'message_interactif.ajouter': {
      // La même validation que l'onglet (`src/http/mba.ts`), dont les bornes en OCTETS : Zod a borné en caractères.
      const v = validerCreation({ titre: o.titre, type: o.composant, consigne: o.consigne, formulaireId: o.formulaire ?? null });
      if (!v.ok) throw new RefusAvantMeta(v.erreur);
      if (v.valeur.formulaireId !== null && !(await deps.formulaires.estPublie(tenantId, v.valeur.formulaireId))) {
        throw new RefusAvantMeta('Ce formulaire n’est pas un formulaire publié de cet espace.');
      }
      await client.creerMessageInteractif(numero, v.valeur);
      return;
    }
    case 'message_interactif.modifier': {
      if (!ID_MESSAGE_RE.test(o.cible)) throw new RefusAvantMeta('Identifiant de message interactif invalide.');
      const v = validerModification({ titre: o.titre, consigne: o.consigne });
      if (!v.ok) throw new RefusAvantMeta(v.erreur);
      await client.modifierMessageInteractif(numero, o.cible, v.valeur);
      return;
    }
    case 'message_interactif.supprimer':
      if (!ID_MESSAGE_RE.test(o.cible)) throw new RefusAvantMeta('Identifiant de message interactif invalide.');
      await client.supprimerMessageInteractif(numero, o.cible);
      return;
    case 'business.modifier': {
      // Lecture puis fusion : `putBusinessInfo` remplace, et envoyer le seul champ modifié effacerait les autres
      // (la description de l'activité). Même règle que `fusionnerBusinessInfo` (`src/mba/client.ts`).
      const actuel = (await client.getBusinessInfo(numero)) as Record<string, unknown>;
      await client.putBusinessInfo(numero, { ...actuel, [champMeta(o.champ)]: o.valeur });
      return;
    }
    case 'activation.mettreEnService': {
      // L'ordre que Meta prescrit (audience, relecture, puis `rollout`), sur la configuration de cet agent. Puis
      // notre drapeau : Meta d'abord, nous ensuite.
      await ecrireRollout(client, numero, true, { attendre: (ms) => deps.attendre(ms), agentId });
      await deps.drapeau.setMbaEnabled(tenantId, true);
      return;
    }
    default: throw new Error('operation inconnue');
  }
}

/** Une consigne dans la forme de Meta : le titre, le QUAND (`description`) et le corps (`skill`). */
function versSkill(o: { titre: string; quand: string; instruction: string }): Skill {
  return { title: o.titre, description: o.quand, skill: o.instruction };
}

/**
 * La clé que Meta attend pour un champ de fiche d'activité : notre écran dit « description », Meta veut
 * `business_description`. La table est ici, en un seul endroit.
 */
function champMeta(champ: string): string {
  return ({
    description: 'business_description',
    horaires: 'business_hours',
    adresse: 'address',
    telephone: 'phone_number',
    email: 'email',
    site: 'website',
  } as Record<string, string>)[champ] ?? champ;
}
