import { z } from 'zod';

/**
 * Ce que l'assistant du MBA a le droit de proposer, et rien d'autre.
 * 🔴 Une frontière de sécurité : le contexte du modèle contient du texte que nous n'avons pas écrit (FAQ, pages
 * aspirées), qui peut tenter de l'orienter. Ce qu'il peut écrire est énuméré ici ; au pire, il propose des
 * opérations que le client voit dans un diff et refuse. Il ne peut pas retirer l'agent du service (cela se fait
 * sur la page d'accueil), ni créer un connecteur ou une source (adresse réseau et secret : geste
 * d'administrateur), ni supprimer plusieurs choses d'un coup (voir le `refine`).
 * Les clés inconnues sont ignorées, pas refusées (`safeParse` sans `.strict()`) : du bruit ne fait pas échouer
 * le tour, il n'obtient simplement rien de plus.
 */

const MAX_TEXTE = 4000;
const MAX_TITRE = 500;
/** L'identifiant d'un objet chez Meta. Opaque : on ne présume pas de sa forme, seulement de sa taille. */
const cible = z.string().trim().min(1).max(200);

const faqAjouter = z.object({
  type: z.literal('faq.ajouter'),
  question: z.string().trim().min(1).max(MAX_TITRE),
  reponse: z.string().trim().min(1).max(MAX_TEXTE),
});
const faqModifier = z.object({
  type: z.literal('faq.modifier'),
  cible,
  question: z.string().trim().min(1).max(MAX_TITRE),
  reponse: z.string().trim().min(1).max(MAX_TEXTE),
});
const faqSupprimer = z.object({
  type: z.literal('faq.supprimer'),
  cible,
  /** 🔴 Obligatoire : c'est lui qui nomme ce qu'on supprime, dans le diff et l'historique ; « supprimer faq_8f3a »
   *  ne permettrait à personne de vérifier la ligne. */
  libelle: z.string().trim().min(1).max(MAX_TITRE),
});

const competenceAjouter = z.object({
  type: z.literal('competence.ajouter'),
  nom: z.string().trim().min(1).max(MAX_TITRE),
  instruction: z.string().trim().min(1).max(MAX_TEXTE),
});
const competenceModifier = z.object({
  type: z.literal('competence.modifier'),
  cible,
  nom: z.string().trim().min(1).max(MAX_TITRE),
  instruction: z.string().trim().min(1).max(MAX_TEXTE),
});
const competenceSupprimer = z.object({
  type: z.literal('competence.supprimer'),
  cible,
  libelle: z.string().trim().min(1).max(MAX_TITRE),
});

const siteAjouter = z.object({
  type: z.literal('site.ajouter'),
  /**
   * 🔴 L'assistant ne devine jamais une adresse : elle vient du client. Le contrôle de fond (hôte privé, résolution
   * DNS) reste `src/lib/adresse-privee.ts`, appliqué à l'application : un `url()` de Zod ne dit rien de la résolution.
   */
  url: z.string().trim().url().max(2000),
});
const siteSupprimer = z.object({
  type: z.literal('site.supprimer'),
  cible,
  libelle: z.string().trim().min(1).max(MAX_TITRE),
});

const fichierSupprimer = z.object({
  type: z.literal('fichier.supprimer'),
  cible,
  libelle: z.string().trim().min(1).max(MAX_TITRE),
});

/** Les champs de `business-info`, en énumération fermée : le modèle ne peut pas en inventer un. */
export const CHAMPS_BUSINESS = ['description', 'horaires', 'adresse', 'telephone', 'email', 'site'] as const;
const businessModifier = z.object({
  type: z.literal('business.modifier'),
  champ: z.enum(CHAMPS_BUSINESS),
  valeur: z.string().trim().max(MAX_TEXTE),
});

/**
 * Il allume, il n'éteint pas : `activation.retirer` n'existe pas, et son absence est le contrôle (une
 * énumération qui la porterait laisserait au modèle l'idée qu'elle est possible).
 */
const activationMettreEnService = z.object({ type: z.literal('activation.mettreEnService') });

const operationSchema = z.discriminatedUnion('type', [
  faqAjouter, faqModifier, faqSupprimer,
  competenceAjouter, competenceModifier, competenceSupprimer,
  siteAjouter, siteSupprimer,
  fichierSupprimer,
  businessModifier, activationMettreEnService,
]);

export type Operation = z.infer<typeof operationSchema>;

/** Une opération est-elle une suppression ? Le suffixe est la règle, pour n'avoir pas à tenir une liste. */
export function estSuppression(o: Operation): boolean {
  return o.type.endsWith('.supprimer');
}

export const MAX_OPERATIONS = 20;

export const propositionMbaSchema = z.object({
  /** Ce que l'assistant dit au client, toujours présent : un diff sans explication ne se juge pas. */
  message: z.string().trim().min(1).max(MAX_TEXTE),
  /** Ce que le client vient de répondre, rattaché aux points de l'ordre du jour. Le tri est fait ailleurs. */
  reponses: z.array(z.object({
    point: z.string().trim().max(64),
    valeur: z.string().trim().max(2000).default(''),
  })).max(40).default([]),
  operations: z.array(operationSchema).max(MAX_OPERATIONS).default([]),
}).refine(
  (p) => p.operations.filter((o) => estSuppression(o as Operation)).length <= 1,
  {
    /**
     * 🔴 Une seule suppression par diff : Meta n'a ni corbeille ni historique, et rien n'est stocké chez nous. Une
     * demande en lot doit produire une liste et une question, jamais une purge qu'une acceptation rapide rendrait
     * définitive.
     */
    message: 'une seule suppression par diff',
    path: ['operations'],
  },
);

