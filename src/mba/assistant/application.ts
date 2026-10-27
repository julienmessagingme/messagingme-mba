import { estSuppression, type Operation } from './proposition';
import type { LigneHistorique } from '../../reglages/historique';
import { messageDe, texteDe } from '../../lib/erreur';
import { ecrireRolloutPuisDrapeau, type AgentSettings, type BusinessInfo, type Skill } from '../client';
import {
  appliquerMutationConnaissance, RefusConnaissanceMba,
  type ClientConnaissanceMba, type MutationConnaissanceMba,
} from '../connaissance';
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
export interface ClientMbaEcriture extends ClientConnaissanceMba {
  putSettings(p: string, s: AgentSettings, agentId?: string): Promise<unknown>;
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
  /** Meta a accepté ces gestes mais notre historique ne les a pas enregistrés : ne pas les renvoyer. */
  avertissements: Operation[];
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
  if (err instanceof RefusAvantMeta || err instanceof RefusConnaissanceMba) return err.message;
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
  operations: readonly Operation[],
): Promise<ResultatApplication> {
  const passees: Operation[] = [];
  const avertissements: Operation[] = [];
  const numero = await deps.numeros.getTenantPhoneNumberId(tenantId);
  if (!numero) {
    return {
      passees: [],
      echec: operations[0]
        ? { operation: operations[0], message: 'Aucun numéro WhatsApp n’est rattaché à cet espace.' }
        : null,
      nonTentees: operations.slice(1),
      avertissements,
    };
  }
  const client = await deps.meta.mbaClientForTenant(tenantId);

  for (let i = 0; i < operations.length; i += 1) {
    const o = operations[i]!;
    try {
      const mutation = versMutationConnaissance(o);
      if (mutation) {
        const resultat = await appliquerMutationConnaissance(
          { historique: deps.historique },
          {
            tenantId, phoneNumberId: numero, client, origine: 'assistant', acteur: deps.acteur,
          },
          mutation,
        );
        passees.push(o);
        if (resultat.historique === 'indisponible') avertissements.push(o);
        continue;
      }
      const avant = await etatAvant(client, numero, o);
      await executer(deps, tenantId, client, numero, o);
      passees.push(o);
      await journaliserOuTaire(deps, tenantId, o, avant);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`assistant MBA : « ${libelleDe(o)} » refusée par Meta (${tenantId}) :`, messageDe(err));
      return { passees, echec: { operation: o, message: raisonLisible(err) }, nonTentees: operations.slice(i + 1), avertissements };
    }
  }
  return { passees, echec: null, nonTentees: [], avertissements };
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

/** Traduit le vocabulaire du diff vers le contrat unique des mutations de connaissance. */
function versMutationConnaissance(o: Operation): MutationConnaissanceMba | null {
  switch (o.type) {
    case 'faq.ajouter': return { type: o.type, valeur: { question: o.question, answer: o.reponse } };
    case 'faq.modifier': return { type: o.type, id: o.cible, valeur: { question: o.question, answer: o.reponse } };
    case 'faq.supprimer': return { type: o.type, id: o.cible, libelle: o.libelle };
    case 'competence.ajouter': return { type: o.type, valeur: versSkill(o) };
    case 'competence.modifier': return { type: o.type, id: o.cible, valeur: versSkill(o) };
    case 'competence.supprimer': return { type: o.type, id: o.cible, libelle: o.libelle };
    case 'site.ajouter': return { type: o.type, url: o.url };
    case 'site.supprimer': return { type: o.type, id: o.cible, libelle: o.libelle };
    case 'fichier.supprimer': return { type: o.type, id: o.cible, libelle: o.libelle };
    case 'business.modifier': return {
      type: o.type,
      patch: patchBusiness(o.champ, o.valeur),
      libelle: `Fiche d’activité : ${o.champ}`,
    };
    case 'activation.mettreEnService':
    case 'message_interactif.ajouter':
    case 'message_interactif.modifier':
    case 'message_interactif.supprimer':
      return null;
  }
}

function patchBusiness(champ: 'description' | 'horaires' | 'adresse' | 'email', valeur: string): BusinessInfo {
  switch (champ) {
    case 'description': return { business_description: valeur };
    case 'horaires': return { contact_info: { hours_of_operation: valeur } };
    case 'adresse': return { contact_info: { address: valeur } };
    case 'email': return { contact_info: { email: valeur } };
  }
}

/**
 * L'état avant, lu avant de toucher à quoi que ce soit. Les suppressions en ont besoin, absolument : Meta ne rend plus
 * un objet parti. La modification d'une consigne aussi : son `PUT` remplace le corps entier (jusqu'à 20 000
 * caractères écrits dans l'onglet), que le modèle n'a pas vu ; l'historique en garde la copie. Au mieux : une lecture
 * ratée ne bloque pas la modification, elle laisse `null`.
 */
async function etatAvant(
  client: ClientMbaEcriture, numero: string, o: Operation,
): Promise<unknown> {
  if (o.type !== 'message_interactif.supprimer') return null;
  return (await client.listMessagesInteractifs(numero).catch(() => []))
    .find((m) => m.id === o.cible) ?? { id: o.cible };
}

/** Ce que l'opération a posé, pour l'historique. `null` pour une suppression. */
function apresDe(o: Operation): unknown {
  if (estSuppression(o)) return null;
  const { type: _t, ...reste } = o as Record<string, unknown> & { type: string };
  return reste;
}

async function executer(
  deps: ApplicationDeps, tenantId: string, client: ClientMbaEcriture, numero: string, o: Operation,
): Promise<void> {
  switch (o.type) {
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
    case 'activation.mettreEnService': {
      // L'ordre que Meta prescrit (audience, relecture, puis `rollout`), sur la configuration de cet agent. Puis
      // notre drapeau : Meta d'abord, nous ensuite.
      // Le helper reprend l'`agent_id` des réglages qu'il vient de lire. Le numéro n'est jamais un agent_id.
      await ecrireRolloutPuisDrapeau(
        client,
        numero,
        true,
        { attendre: (ms) => deps.attendre(ms) },
        (enabled) => deps.drapeau.setMbaEnabled(tenantId, enabled),
      );
      return;
    }
    default: throw new Error('mutation de connaissance non déléguée');
  }
}

/** Une consigne dans la forme de Meta : le titre, le QUAND (`description`) et le corps (`skill`). */
function versSkill(o: { titre: string; quand: string; instruction: string }): Skill {
  return { title: o.titre, description: o.quand, skill: o.instruction };
}
