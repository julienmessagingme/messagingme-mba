import type { AgentSettings, BusinessInfo, Faq, KnowledgeFile, Skill, Website } from './client';
import type { LigneHistorique } from '../reglages/historique';
import { messageDe } from '../lib/erreur';
import { isSendableButtonUrl } from '../../web/lib/partage/button-url';

/**
 * L'adapter Meta dont la connaissance a besoin. L'objet reste entier : ses méthodes peuvent lire `this`, comme
 * celles de `MbaClient` en production.
 */
export interface ClientConnaissanceMba {
  getSettings(phoneNumberId: string): Promise<AgentSettings | null>;
  listFaqs(phoneNumberId: string): Promise<Faq[]>;
  createFaq(phoneNumberId: string, faq: Faq): Promise<unknown>;
  updateFaq(phoneNumberId: string, faqId: string, faq: Faq): Promise<unknown>;
  deleteFaq(phoneNumberId: string, faqId: string): Promise<void>;
  listSkills(phoneNumberId: string, agentId: string): Promise<Skill[]>;
  createSkill(phoneNumberId: string, agentId: string, skill: Skill): Promise<unknown>;
  updateSkill(phoneNumberId: string, skillId: string, skill: Skill): Promise<unknown>;
  deleteSkill(phoneNumberId: string, skillId: string): Promise<void>;
  listWebsites(phoneNumberId: string): Promise<Website[]>;
  createWebsite(phoneNumberId: string, url: string): Promise<unknown>;
  deleteWebsite(phoneNumberId: string, websiteId: string): Promise<void>;
  getBusinessInfo(phoneNumberId: string): Promise<BusinessInfo>;
  putBusinessInfo(phoneNumberId: string, info: BusinessInfo): Promise<unknown>;
  listFiles(phoneNumberId: string): Promise<KnowledgeFile[]>;
  deleteFile(phoneNumberId: string, fileId: string): Promise<void>;
}

export interface DependancesConnaissanceMba {
  historique: { ecrire(tenantId: string, ligne: LigneHistorique): Promise<void> };
}

export interface ContexteConnaissanceMba {
  tenantId: string;
  phoneNumberId: string;
  client: ClientConnaissanceMba;
  origine: 'formulaire' | 'assistant';
  acteur: { id: string | null; email: string | null };
}

export type MutationConnaissanceMba =
  | { type: 'faq.ajouter'; valeur: Faq }
  | { type: 'faq.modifier'; id: string; valeur: Faq }
  | { type: 'faq.supprimer'; id: string; libelle?: string }
  | { type: 'competence.ajouter'; valeur: Skill }
  | { type: 'competence.modifier'; id: string; valeur: Skill }
  | { type: 'competence.supprimer'; id: string; libelle?: string }
  | { type: 'site.ajouter'; url: string }
  | { type: 'site.supprimer'; id: string; libelle?: string }
  | { type: 'business.modifier'; patch: BusinessInfo; libelle?: string }
  | { type: 'fichier.supprimer'; id: string; libelle?: string };

export interface ResultatMutationConnaissance {
  valeur: unknown;
  /** `indisponible` signifie : Meta a accepté, ne surtout pas réessayer l'opération. */
  historique: 'ecrit' | 'non_requis' | 'indisponible';
}

/** Un refus local sûr, rendu tel quel au client sans accuser Meta. */
export class RefusConnaissanceMba extends Error {
  constructor(message: string, readonly statusCode: 400 | 409 = 400) {
    super(message);
    this.name = 'RefusConnaissanceMba';
  }
}

async function agentId(client: ClientConnaissanceMba, phoneNumberId: string): Promise<string> {
  const id = (await client.getSettings(phoneNumberId))?.agent_id;
  if (!id) throw new RefusConnaissanceMba("l'agent n'est pas encore configuré sur ce numéro", 409);
  return id;
}

function trouver<T extends { id?: string }>(lecture: Promise<T[]>, id: string): Promise<T | { id: string }> {
  return lecture.then((elements) => elements.find((e) => e.id === id) ?? { id }).catch(() => ({ id }));
}

function verifierIdOpaque(id: string): void {
  if (id === '.' || id === '..') throw new RefusConnaissanceMba('Identifiant Meta invalide.');
}

async function lireSkillAvant(client: ClientConnaissanceMba, phoneNumberId: string, id: string): Promise<Skill | { id: string }> {
  try {
    const idAgent = (await client.getSettings(phoneNumberId))?.agent_id;
    if (!idAgent) return { id };
    return (await client.listSkills(phoneNumberId, idAgent)).find((skill) => skill.id === id) ?? { id };
  } catch {
    return { id };
  }
}

/** Une écriture de connaissance, quel que soit l'adapter qui l'a demandée. */
export async function appliquerMutationConnaissance(
  deps: DependancesConnaissanceMba,
  contexte: ContexteConnaissanceMba,
  mutation: MutationConnaissanceMba,
): Promise<ResultatMutationConnaissance> {
  let valeur: unknown;
  let avant: unknown = null;
  let element: LigneHistorique['element'];
  let operation: LigneHistorique['operation'];
  let cible: string | null;
  let libelle: string;
  let apres: unknown;
  const { client, phoneNumberId } = contexte;

  switch (mutation.type) {
    case 'faq.ajouter':
      valeur = await client.createFaq(phoneNumberId, mutation.valeur);
      element = 'faq'; operation = 'ajout'; cible = null;
      libelle = `FAQ : ${mutation.valeur.question}`; apres = mutation.valeur;
      break;
    case 'faq.modifier':
      verifierIdOpaque(mutation.id);
      valeur = await client.updateFaq(phoneNumberId, mutation.id, mutation.valeur);
      element = 'faq'; operation = 'modification'; cible = mutation.id;
      libelle = `FAQ : ${mutation.valeur.question}`; apres = mutation.valeur;
      break;
    case 'faq.supprimer': {
      verifierIdOpaque(mutation.id);
      avant = await trouver(client.listFaqs(phoneNumberId), mutation.id);
      await client.deleteFaq(phoneNumberId, mutation.id);
      valeur = { deleted: mutation.id };
      const nom = (avant as Faq).question ?? mutation.libelle ?? mutation.id;
      element = 'faq'; operation = 'suppression'; cible = mutation.id;
      libelle = `FAQ : ${nom}`; apres = null;
      break;
    }
    case 'competence.ajouter': {
      valeur = await client.createSkill(phoneNumberId, await agentId(client, phoneNumberId), mutation.valeur);
      element = 'competence'; operation = 'ajout'; cible = null;
      libelle = `Consigne : ${mutation.valeur.title}`; apres = mutation.valeur;
      break;
    }
    case 'competence.modifier': {
      verifierIdOpaque(mutation.id);
      // Seul l'assistant journalise une modification. La console n'a donc rien à précharger ici : deux lectures
      // Meta inutiles (réglages puis liste) doubleraient le rayon de panne et consommeraient le quota à chaque édition.
      if (contexte.origine === 'assistant') avant = await lireSkillAvant(client, phoneNumberId, mutation.id);
      valeur = await client.updateSkill(phoneNumberId, mutation.id, mutation.valeur);
      element = 'competence'; operation = 'modification'; cible = mutation.id;
      libelle = `Consigne : ${mutation.valeur.title}`; apres = mutation.valeur;
      break;
    }
    case 'competence.supprimer': {
      verifierIdOpaque(mutation.id);
      avant = await lireSkillAvant(client, phoneNumberId, mutation.id);
      await client.deleteSkill(phoneNumberId, mutation.id);
      valeur = { deleted: mutation.id };
      const nom = (avant as Skill).title ?? mutation.libelle ?? mutation.id;
      element = 'competence'; operation = 'suppression'; cible = mutation.id;
      libelle = `Consigne : ${nom}`; apres = null;
      break;
    }
    case 'site.ajouter': {
      const url = mutation.url.trim();
      if (!isSendableButtonUrl(url)) {
        throw new RefusConnaissanceMba('URL invalide (adresse complète attendue, ex. https://www.exemple.fr).');
      }
      valeur = await client.createWebsite(phoneNumberId, url);
      element = 'site'; operation = 'ajout'; cible = null;
      libelle = `Site : ${url}`; apres = { url };
      break;
    }
    case 'site.supprimer': {
      verifierIdOpaque(mutation.id);
      avant = await trouver(client.listWebsites(phoneNumberId), mutation.id);
      await client.deleteWebsite(phoneNumberId, mutation.id);
      valeur = { deleted: mutation.id };
      const nom = (avant as Website).url ?? mutation.libelle ?? mutation.id;
      element = 'site'; operation = 'suppression'; cible = mutation.id;
      libelle = `Site : ${nom}`; apres = null;
      break;
    }
    case 'business.modifier': {
      const actuel = await client.getBusinessInfo(phoneNumberId);
      avant = actuel;
      const contact = mutation.patch.contact_info === undefined
        ? actuel.contact_info
        : mutation.patch.contact_info === null
          ? null
          : { ...(actuel.contact_info ?? {}), ...mutation.patch.contact_info };
      const complet: BusinessInfo = {
        ...actuel,
        ...mutation.patch,
        ...(mutation.patch.contact_info === undefined ? {} : { contact_info: contact }),
      };
      valeur = await client.putBusinessInfo(phoneNumberId, complet);
      const champs = Object.keys(mutation.patch);
      element = 'business_info'; operation = 'modification'; cible = champs[0] ?? null;
      libelle = mutation.libelle ?? 'Fiche d’activité'; apres = mutation.patch;
      break;
    }
    case 'fichier.supprimer': {
      verifierIdOpaque(mutation.id);
      avant = await trouver(client.listFiles(phoneNumberId), mutation.id);
      await client.deleteFile(phoneNumberId, mutation.id);
      valeur = { deleted: mutation.id };
      element = 'fichier'; operation = 'suppression'; cible = mutation.id;
      libelle = `Document : ${(avant as KnowledgeFile).file_name ?? mutation.libelle ?? mutation.id}`; apres = null;
      break;
    }
  }

  if (contexte.origine === 'formulaire' && operation !== 'suppression') {
    return { valeur, historique: 'non_requis' };
  }
  try {
    await deps.historique.ecrire(contexte.tenantId, {
      surface: 'mba', surfaceId: null, element, operation, cible, libelle, avant, apres,
      origine: contexte.origine, acteurEmail: contexte.acteur.email, acteurId: contexte.acteur.id,
    });
    return { valeur, historique: 'ecrit' };
  } catch (err) {
    // Meta a déjà accepté : ce défaut local ne transforme jamais le geste en échec réessayable.
    // eslint-disable-next-line no-console
    console.warn(`connaissance MBA : « ${libelle} » appliquée mais NON journalisée (${contexte.tenantId}) :`, messageDe(err));
    return { valeur, historique: 'indisponible' };
  }
}
