import { z } from 'zod';
import { TITRE_MAX, TITRE_RE, TYPES_MESSAGE_INTERACTIF } from '../messages-interactifs';

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
/**
 * Le titre d'une consigne comme celui d'un message interactif : un slug borné à la limite de Meta (64), la même règle
 * pour les deux (mesuré le 2026-10-07).
 */
const titreSlug = z.string().trim().min(1).max(TITRE_MAX).regex(TITRE_RE);

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

/**
 * Une consigne, dans la forme que Meta exige (`Skill`, `src/mba/client.ts`) : un titre en slug, le QUAND (la
 * `description` de Meta, qui décide quand l'agent l'applique) et le corps. 🔴 Jusqu'au 2026-10-08 elle portait
 * `nom` et `instruction`, envoyés tels quels : Meta refusait la création en 400 et acceptait la modification en 200
 * sans rien changer (mesuré ce jour-là sur le numéro de test). `MAX_QUAND` est la limite de Meta pour `description`.
 */
export const MAX_QUAND = 1024;
const competenceAjouter = z.object({
  type: z.literal('competence.ajouter'),
  titre: titreSlug,
  quand: z.string().trim().min(1).max(MAX_QUAND),
  instruction: z.string().trim().min(1).max(MAX_TEXTE),
});
const competenceModifier = z.object({
  type: z.literal('competence.modifier'),
  cible,
  titre: titreSlug,
  quand: z.string().trim().min(1).max(MAX_QUAND),
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
 * Les messages interactifs (lot du 2026-10-07, `src/mba/messages-interactifs.ts`). La clé du composant s'appelle
 * `composant`, pas `type` : `type` est déjà le discriminant de l'opération. Le formulaire est un identifiant Meta
 * (des chiffres), requis pour un composant `flow` et refusé sinon (le `refine` plus bas) ; qu'il soit un formulaire
 * PUBLIÉ DE L'ESPACE se vérifie à l'application, en base. Le titre est `titreSlug`, comme celui d'une consigne ;
 * l'application recompte en octets, comme Meta.
 */
const ID_FORMULAIRE = /^\d{1,20}$/;
const consigneMessage = z.string().trim().min(1).max(MAX_TEXTE);
const messageInteractifAjouter = z.object({
  type: z.literal('message_interactif.ajouter'),
  titre: titreSlug,
  composant: z.enum(TYPES_MESSAGE_INTERACTIF),
  consigne: consigneMessage,
  formulaire: z.string().trim().regex(ID_FORMULAIRE).optional(),
});
const messageInteractifModifier = z.object({
  type: z.literal('message_interactif.modifier'),
  cible,
  titre: titreSlug,
  consigne: consigneMessage,
});
const messageInteractifSupprimer = z.object({
  type: z.literal('message_interactif.supprimer'),
  cible,
  libelle: z.string().trim().min(1).max(MAX_TITRE),
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
  messageInteractifAjouter, messageInteractifModifier, messageInteractifSupprimer,
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
).refine(
  (p) => p.operations.every((o) => o.type !== 'message_interactif.ajouter' || (o.composant === 'flow') === (o.formulaire !== undefined)),
  { message: 'un message interactif de type formulaire désigne son formulaire, et seulement lui', path: ['operations'] },
);

/** Les types d'opération, dans l'ordre de l'union : le schéma annoncé les énumère. */
export const TYPES_OPERATION = operationSchema.options.map((o) => o.shape.type.value);

/**
 * LE SCHÉMA ANNONCÉ AU MODÈLE, écrit à la main comme celui de l'autre assistant (`SCHEMA_PROPOSITION`,
 * `src/agent/setup/proposition.ts`) : dériver de Zod ajoute du bruit payé à chaque tour. Une opération y est un objet
 * À PLAT, `type` en énumération et chaque champ avec ses bornes, sans `anyOf` (que tous les fournisseurs ne lisent pas).
 * 🔴 Toute borne que Zod applique y figure : `tests/mba-assistant-bornes.test.ts` les extrait de Zod et les compare.
 * Il ne disait jusqu'au 2026-10-07 que `type`, pour les onze opérations d'alors.
 */
export const SCHEMA_PROPOSITION_MBA = {
  type: 'object',
  properties: {
    message: { type: 'string', minLength: 1, maxLength: MAX_TEXTE, description: 'Ce que tu dis au client, en français.' },
    reponses: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        properties: { point: { type: 'string', maxLength: 64 }, valeur: { type: 'string', maxLength: 2000 } },
        required: ['point'],
      },
    },
    operations: {
      type: 'array',
      maxItems: MAX_OPERATIONS,
      description: 'Les modifications à appliquer chez Meta. Vide si tu poses seulement une question. Une seule suppression par proposition.',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: TYPES_OPERATION },
          cible: { type: 'string', minLength: 1, maxLength: 200, description: 'L’identifiant chez Meta de l’élément à modifier ou supprimer.' },
          libelle: { type: 'string', minLength: 1, maxLength: MAX_TITRE, description: 'Le nom lisible de ce que tu supprimes.' },
          question: { type: 'string', minLength: 1, maxLength: MAX_TITRE, description: 'faq : la question.' },
          reponse: { type: 'string', minLength: 1, maxLength: MAX_TEXTE, description: 'faq : la réponse.' },
          quand: {
            type: 'string', minLength: 1, maxLength: MAX_QUAND,
            description: 'competence.ajouter et .modifier, requis : QUAND l’agent applique la consigne (ex. « Quand le client demande un remboursement »).',
          },
          instruction: {
            type: 'string', minLength: 1, maxLength: MAX_TEXTE,
            description: 'competence.ajouter et .modifier, requis avec titre et quand : ce que l’agent fait, le corps de la consigne. '
              + 'En modification, il REMPLACE le corps actuel, que tu ne vois pas : demande d’abord au client ce qu’il garde.',
          },
          url: { type: 'string', maxLength: 2000, description: 'site.ajouter : l’adresse donnée par le client, jamais devinée.' },
          champ: { type: 'string', enum: [...CHAMPS_BUSINESS], description: 'business.modifier : le champ de la fiche.' },
          valeur: { type: 'string', maxLength: MAX_TEXTE, description: 'business.modifier : la nouvelle valeur.' },
          titre: {
            type: 'string', minLength: 1, maxLength: TITRE_MAX, pattern: TITRE_RE.source,
            description: 'competence et message_interactif : son titre, en minuscules, chiffres et tirets (ex. « politique-de-retour », « boutons-rdv »).',
          },
          composant: {
            type: 'string',
            enum: [...TYPES_MESSAGE_INTERACTIF],
            description: 'message_interactif.ajouter : le composant WhatsApp. Il ne se change plus ensuite.',
          },
          consigne: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_TEXTE,
            description: 'message_interactif : « Quand : <la situation> » sur la première ligne, puis ce que le message contient.',
          },
          formulaire: {
            type: 'string',
            pattern: ID_FORMULAIRE.source,
            description: 'message_interactif.ajouter, composant flow SEULEMENT : l’identifiant d’un formulaire publié de la liste fournie.',
          },
        },
        required: ['type'],
      },
    },
  },
  required: ['message'],
} as const;

