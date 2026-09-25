import { estSuppression, type Operation } from './proposition';
import type { LigneHistorique } from '../../reglages/historique';
import { messageDe, texteDe } from '../../lib/erreur';

/**
 * APPLIQUER UN DIFF CHEZ META, OPÉRATION PAR OPÉRATION.
 *
 * 🔴 ON S'ARRÊTE À LA PREMIÈRE ERREUR, ET ON REND L'ÉTAT EXACT (décision de Julien du 2026-09-14). Meta
 * n'offre AUCUNE transaction : « tout annuler » voudrait dire défaire à la main ce qui est déjà passé, ce
 * qui peut échouer à son tour et produire un état encore moins lisible. Un arrêt net avec un compte rendu
 * exact est la seule chose qu'on puisse tenir.
 *
 * 🔴 ET RIEN N'EST JOURNALISÉ POUR UNE OPÉRATION QUI A ÉCHOUÉ. Une ligne d'historique sur un geste qui n'a
 * pas eu lieu ferait chercher une cause qui n'existe pas, sur le seul journal que le client consulte.
 *
 * ⚠️ LE CONTENU SUPPRIMÉ EST LU AVANT DE SUPPRIMER, jamais après : c'est le seul exemplaire qui en restera,
 * Meta ne le rend plus une fois l'objet parti.
 */

/** Ce dont l'application a besoin. Interface étroite : satisfaite par le vrai client MBA comme par un faux. */
export interface ApplicationDeps {
  /** Le numéro Meta de l'espace. `null` = rien à faire, l'espace n'a pas de MBA. */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  client(tenantId: string): Promise<ClientMbaEcriture>;
  /** Écrit une ligne d'historique. Voir `src/reglages/historique.ts`. */
  journaliser(tenantId: string, ligne: LigneHistorique): Promise<void>;
  /**
   * Le contenu d'une pièce jointe déposée dans le fil, par son jeton. `null` = jeton inconnu, expiré, ou
   * appartenant à un AUTRE espace.
   *
   * 🔴 LE TENANT EST UN ARGUMENT, PAS UNE DÉCORATION : c'est lui qui rend un jeton inutilisable ailleurs.
   * Il a été passé vide pendant une révision, ce qui aurait fait chercher toutes les pièces sous l'espace
   * `''`, donc rendu tout dépôt introuvable au moment de l'appliquer.
   */
  pieceJointe?(tenantId: string, jeton: string): Promise<{ nom: string; contenu: Blob } | null>;
  /** Qui agit, pour l'historique. */
  acteur: { id: string | null; email: string | null };
}

/** Ce que l'application attend du client Meta. Un sous-ensemble STRICT de `MbaClient`. */
export interface ClientMbaEcriture {
  listFaqs(p: string): Promise<Array<{ id?: string; question?: string; answer?: string }>>;
  createFaq(p: string, faq: unknown): Promise<unknown>;
  updateFaq(p: string, id: string, faq: unknown): Promise<unknown>;
  deleteFaq(p: string, id: string): Promise<void>;
  listSkills(p: string, agentId: string): Promise<Array<{ id?: string; name?: string; instruction?: string }>>;
  createSkill(p: string, agentId: string, s: unknown): Promise<unknown>;
  updateSkill(p: string, id: string, s: unknown): Promise<unknown>;
  deleteSkill(p: string, id: string): Promise<void>;
  listWebsites(p: string): Promise<Array<{ id?: string; url?: string }>>;
  createWebsite(p: string, url: string): Promise<unknown>;
  deleteWebsite(p: string, id: string): Promise<void>;
  listFiles(p: string): Promise<Array<{ id?: string; name?: string }>>;
  uploadFile(p: string, nom: string, contenu: Blob): Promise<unknown>;
  deleteFile(p: string, id: string): Promise<void>;
  /**
   * ⚠️ `unknown` ET NON `Record<string, unknown>` : le vrai `MbaClient` rend un type NOMMÉ (`BusinessInfo`),
   * qui n'a pas d'index de chaîne et n'est donc pas assignable. Resserrer ici obligerait à élargir là-bas,
   * c'est-à-dire à affaiblir un type juste pour satisfaire un contrat de test.
   */
  getBusinessInfo(p: string): Promise<unknown>;
  putBusinessInfo(p: string, info: unknown): Promise<unknown>;
  getSettings(p: string): Promise<unknown>;
  putSettings(p: string, s: unknown, agentId?: string): Promise<unknown>;
}

/** Le message d'erreur INTERNE d'un jeton de pièce jointe qui ne résout plus. Jamais montré tel quel. */
export const ERREUR_PIECE_ABSENTE = 'piece jointe introuvable ou expiree';

export interface EchecOperation {
  operation: Operation;
  /** En français, destiné au client. Le message BRUT de Meta va dans les journaux, pas ici. */
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
    case 'competence.ajouter': return `Compétence : ${o.nom}`;
    case 'competence.modifier': return `Compétence : ${o.nom}`;
    case 'competence.supprimer': return `Compétence : ${o.libelle}`;
    case 'site.ajouter': return `Site : ${o.url}`;
    case 'site.supprimer': return `Site : ${o.libelle}`;
    case 'fichier.ajouter': return `Document : ${o.nom}`;
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
    business: 'business_info', activation: 'activation',
  } as const)[famille as 'faq'] ?? 'faq';
}

/** L'opération d'historique correspondante. PUR. */
export function operationDe(o: Operation): LigneHistorique['operation'] {
  if (estSuppression(o)) return 'suppression';
  return o.type.endsWith('.ajouter') || o.type === 'activation.mettreEnService' ? 'ajout' : 'modification';
}

/**
 * Traduit une erreur de Meta en une phrase destinée au client.
 *
 * 🔴 LE MESSAGE BRUT NE REMONTE PAS TEL QUEL. Meta répond en anglais, souvent avec un code interne ; le
 * client n'a pas à le lire. Il reste dans les journaux serveur, où il sert au diagnostic.
 */
export function raisonLisible(err: unknown): string {
  const brut = texteDe(err);
  /**
   * 🔴 LE SEUL ÉCHEC QUI NE VIENT PAS DE META, et le confondre avec les siens ferait chercher la panne du
   * mauvais côté : le document déposé a expiré chez NOUS. Il se teste en premier, avant les motifs de Meta.
   */
  if (brut === ERREUR_PIECE_ABSENTE) {
    return 'Le document déposé n’est plus disponible : redéposez-le, puis réessayez.';
  }
  if (/blocked/i.test(brut)) return 'Meta a refusé ce contenu. Reformulez-le, puis réessayez.';
  if (/rate|429|limit/i.test(brut)) return 'Meta nous a demandé de ralentir. Réessayez dans un instant.';
  if (/not found|404/i.test(brut)) return 'Cet élément n’existe plus chez Meta : quelqu’un l’a peut-être supprimé entre-temps.';
  return 'Meta a refusé cette modification.';
}

/**
 * APPLIQUE LES OPÉRATIONS, DANS L'ORDRE, ET S'ARRÊTE À LA PREMIÈRE QUI ÉCHOUE.
 *
 * ⚠️ NE LÈVE JAMAIS : l'appelant est une route qui doit rendre un compte rendu, pas une pile. Tout ressort
 * dans `echec`.
 */
export async function appliquer(
  deps: ApplicationDeps,
  tenantId: string,
  agentId: string,
  operations: readonly Operation[],
): Promise<ResultatApplication> {
  const passees: Operation[] = [];
  const numero = await deps.numeroDuTenant(tenantId);
  if (!numero) {
    return {
      passees: [],
      echec: operations[0]
        ? { operation: operations[0], message: 'Aucun numéro WhatsApp n’est rattaché à cet espace.' }
        : null,
      nonTentees: operations.slice(1),
    };
  }
  const client = await deps.client(tenantId);

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
 * ÉCRIT LA LIGNE D'HISTORIQUE, ET NE FAIT JAMAIS ÉCHOUER L'OPÉRATION.
 *
 * 🔴 ELLE ÉTAIT DANS LE `try` DE LA BOUCLE, ET C'EST UN DÉFAUT À TROIS TÊTES. Une panne de NOTRE base
 * (journal indisponible) survenait APRÈS que Meta ait accepté l'écriture, donc :
 *  - l'opération se retrouvait à la fois dans `passees` et dans `echec.operation`, et l'écran l'affichait
 *    sous « Fait » ET sous « Arrêté sur » ;
 *  - `raisonLisible` rendait « Meta a refusé cette modification », c'est-à-dire qu'on accusait Meta d'une
 *    panne qui vient de chez nous, exactement ce que la traduction des erreurs existe pour éviter ;
 *  - les opérations suivantes étaient abandonnées, pour un journal muet.
 *
 * ⚠️ BEST-EFFORT, comme `JournalAppels.clore` : un journal muet ne doit pas tuer un geste qui a eu lieu. Ce
 * qu'on perd est une ligne d'historique ; ce qu'on éviterait en levant est pire, puisque le geste, lui, est
 * déjà passé chez Meta et ne se défait pas.
 */
async function journaliserOuTaire(
  deps: ApplicationDeps, tenantId: string, o: Operation, avant: unknown,
): Promise<void> {
  try {
    await deps.journaliser(tenantId, {
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
 * L'ÉTAT AVANT, LU AVANT DE TOUCHER À QUOI QUE CE SOIT.
 *
 * 🔴 SEULES LES SUPPRESSIONS EN ONT BESOIN, et elles en ont ABSOLUMENT besoin : c'est le seul exemplaire
 * qui restera. Le lire après coup serait trop tard, Meta ne rend plus un objet parti.
 */
async function etatAvant(
  client: ClientMbaEcriture, numero: string, agentId: string, o: Operation,
): Promise<unknown> {
  if (!estSuppression(o)) return null;
  const cible = 'cible' in o ? o.cible : '';
  if (o.type === 'faq.supprimer') return (await client.listFaqs(numero)).find((f) => f.id === cible) ?? { id: cible };
  if (o.type === 'competence.supprimer') return (await client.listSkills(numero, agentId)).find((s) => s.id === cible) ?? { id: cible };
  if (o.type === 'site.supprimer') return (await client.listWebsites(numero)).find((w) => w.id === cible) ?? { id: cible };
  if (o.type === 'fichier.supprimer') return (await client.listFiles(numero)).find((f) => f.id === cible) ?? { id: cible };
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
    case 'competence.ajouter': await client.createSkill(numero, agentId, { name: o.nom, instruction: o.instruction }); return;
    case 'competence.modifier': await client.updateSkill(numero, o.cible, { name: o.nom, instruction: o.instruction }); return;
    case 'competence.supprimer': await client.deleteSkill(numero, o.cible); return;
    case 'site.ajouter': await client.createWebsite(numero, o.url); return;
    case 'site.supprimer': await client.deleteWebsite(numero, o.cible); return;
    case 'fichier.supprimer': await client.deleteFile(numero, o.cible); return;
    case 'fichier.ajouter': {
      /**
       * ⚠️ LE JETON, PAS LE CONTENU : le fichier n'a jamais traversé le prompt. Un jeton inconnu ou expiré
       * est une erreur LISIBLE, pas un silence : le client vient de déposer quelque chose et doit savoir
       * que ce n'est pas parti.
       */
      const piece = deps.pieceJointe ? await deps.pieceJointe(tenantId, o.jeton) : null;
      if (!piece) throw new Error(ERREUR_PIECE_ABSENTE);
      await client.uploadFile(numero, piece.nom, piece.contenu);
      return;
    }
    case 'business.modifier': {
      // ⚠️ LECTURE PUIS FUSION : `putBusinessInfo` REMPLACE. Envoyer le seul champ modifié effacerait tous
      // les autres, c'est-à-dire la description de l'activité, sur un geste annoncé comme « changer les
      // horaires ». Même règle que `fusionnerBusinessInfo` (`src/mba/client.ts`).
      const actuel = (await client.getBusinessInfo(numero)) as Record<string, unknown>;
      await client.putBusinessInfo(numero, { ...actuel, [champMeta(o.champ)]: o.valeur });
      return;
    }
    case 'activation.mettreEnService': {
      const actuel = (await client.getSettings(numero)) as Record<string, unknown> | null;
      await client.putSettings(numero, { ...(actuel ?? {}), rollout: { enabled: true } }, agentId);
      return;
    }
    default: throw new Error('operation inconnue');
  }
}

/**
 * La clé que Meta attend pour un champ de fiche d'activité.
 *
 * ⚠️ NOS NOMS NE SONT PAS LES SIENS : notre écran dit « description », Meta veut `business_description`. La
 * table est ici, en un seul endroit, plutôt que dispersée dans les appels.
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
