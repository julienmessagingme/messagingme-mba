import { z } from 'zod';

/**
 * CE QUE L'ASSISTANT DU MBA A LE DROIT DE PROPOSER, ET RIEN D'AUTRE.
 *
 * 🔴 C'EST UNE FRONTIÈRE DE SÉCURITÉ, PAS UNE COMMODITÉ DE PARSING. Le contexte envoyé au modèle contient
 * les FAQ du client et les pages aspirées de son site, c'est-à-dire du texte que nous n'avons pas écrit :
 * un contenu hostile peut tenter de l'orienter. Ce qu'il peut écrire est donc ÉNUMÉRÉ ici, et rien d'autre
 * ne passe. Compromettre la conversation ne compromet alors pas le robot : au pire, elle propose des
 * opérations que le client voit passer dans un diff et refuse.
 *
 * 🔴 CE QU'IL NE PEUT PAS FAIRE, ET LA LISTE COMPTE AUTANT QUE L'AUTRE :
 *  - RETIRER l'agent du service. Julien : « si tu veux retirer, tu débranches ton agent MBA en première
 *    page ». Couper les réponses aux vrais clients dans la seconde ne se déclenche pas sur une phrase
 *    interprétée ;
 *  - créer un connecteur ou une source. Déclarer une source, c'est écrire une adresse réseau et un secret :
 *    cela reste un geste d'administrateur, la même frontière que pour l'assistant d'agent IA ;
 *  - supprimer PLUSIEURS choses d'un coup (voir le `refine` en bas).
 *
 * ⚠️ LES CLÉS INCONNUES SONT IGNORÉES, PAS REFUSÉES : `safeParse` d'un objet Zod sans `.strict()` les
 * laisse tomber en silence, ce qui est exactement le comportement voulu. Un modèle qui renvoie du bruit ne
 * doit pas faire échouer tout un tour de conversation ; il doit juste ne rien obtenir de plus.
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
  /** 🔴 OBLIGATOIRE : c'est lui qui NOMME ce qu'on supprime, dans le diff et dans l'historique. Un diff qui
   *  dirait « supprimer faq_8f3a » ne permettrait à personne de vérifier qu'on ne se trompe pas de ligne. */
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
   * 🔴 L'ASSISTANT NE DEVINE JAMAIS UNE ADRESSE : elle vient du client, il ne fait que la reprendre. Le
   * contrôle de fond (hôte privé, résolution DNS) reste celui de `src/lib/adresse-privee.ts`, appliqué à
   * l'APPLICATION : un `url()` de Zod ne dit rien de ce vers quoi l'adresse résout.
   */
  url: z.string().trim().url().max(2000),
});
const siteSupprimer = z.object({
  type: z.literal('site.supprimer'),
  cible,
  libelle: z.string().trim().min(1).max(MAX_TITRE),
});

const fichierAjouter = z.object({
  type: z.literal('fichier.ajouter'),
  /** Le jeton rendu par le dépôt de pièce jointe : le CONTENU ne transite jamais par le modèle. */
  jeton: z.string().trim().regex(/^[a-f0-9]{32}$/),
  nom: z.string().trim().min(1).max(300),
});
const fichierSupprimer = z.object({
  type: z.literal('fichier.supprimer'),
  cible,
  libelle: z.string().trim().min(1).max(MAX_TITRE),
});

/** Les champs de `business-info`, en ÉNUMÉRATION FERMÉE : le modèle ne peut pas en inventer un. */
export const CHAMPS_BUSINESS = ['description', 'horaires', 'adresse', 'telephone', 'email', 'site'] as const;
const businessModifier = z.object({
  type: z.literal('business.modifier'),
  champ: z.enum(CHAMPS_BUSINESS),
  valeur: z.string().trim().max(MAX_TEXTE),
});

/**
 * 🔴 IL ALLUME, IL N'ÉTEINT PAS : `activation.retirer` N'EXISTE PAS, et son absence est le contrôle. Une
 * énumération qui la porterait, même refusée plus loin, laisserait au modèle l'idée qu'elle est possible.
 */
const activationMettreEnService = z.object({ type: z.literal('activation.mettreEnService') });

const operationSchema = z.discriminatedUnion('type', [
  faqAjouter, faqModifier, faqSupprimer,
  competenceAjouter, competenceModifier, competenceSupprimer,
  siteAjouter, siteSupprimer,
  fichierAjouter, fichierSupprimer,
  businessModifier, activationMettreEnService,
]);

export type Operation = z.infer<typeof operationSchema>;

/** Une opération est-elle une suppression ? Le suffixe est la règle, pour n'avoir pas à tenir une liste. */
export function estSuppression(o: Operation): boolean {
  return o.type.endsWith('.supprimer');
}

export const MAX_OPERATIONS = 20;

export const propositionMbaSchema = z.object({
  /** Ce que l'assistant DIT au client. Toujours présent : un diff sans explication ne se juge pas. */
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
     * 🔴 UNE SEULE SUPPRESSION PAR DIFF (décision de Julien du 2026-09-14). Rien n'est stocké chez nous :
     * Meta n'a ni corbeille ni historique. Une demande en lot (« nettoie mes FAQ ») doit produire une liste
     * et une question, jamais une purge qu'une acceptation rapide rendrait définitive.
     */
    message: 'une seule suppression par diff',
    path: ['operations'],
  },
);

export type PropositionMba = z.infer<typeof propositionMbaSchema>;

/** Le nom de l'outil que le modèle appelle, et son schéma JSON. Même forme que l'assistant d'agent IA. */
export const OUTIL_PROPOSER_MBA = 'proposer';
