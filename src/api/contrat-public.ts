import { z } from 'zod';
import { USER_FIELD_TYPES } from '../crm/fields';
import { JOURNAL_PAGE_MAX } from '../evenements/gestion';
import { TEXTE_MAX_CARACTERES } from '../traduction/traduire';
import { RCS_TEXTE_MAX } from '../../web/lib/partage/rcs';
import { horodatageIso } from '../lib/horodatage-iso';
import { schemaContactLotV1 } from './contacts-v1';
import { MAX_OPT_IN_SOURCE } from './contacts-upsert';
import { schemaClesFiche, videEnAbsent } from './fiche';

/**
 * LES ENTRÉES PROPRES À L'API PUBLIQUE `/v1`. Ce module possède leur forme et leurs bornes ; les adaptateurs HTTP
 * les appliquent et l'adaptateur OpenAPI les décrit. Une évolution du contrat ne peut donc plus dériver entre la
 * validation réelle, la documentation et ses exemples.
 *
 * Les schémas déjà possédés par un module métier (`contacts-v1`, `message-meta`, `modele-meta`, `envoi-public`,
 * gestion des événements) y restent : ce fichier ne les réexporte pas et ne fabrique pas un second inventaire.
 */

/** Un lot occupe l'unique place d'opération lourde du process ; les gros volumes passent par l'import CSV. */
export const MAX_BATCH = 50;

/** La route lit le conteneur, puis valide chaque fiche séparément afin de rendre son index dans les refus. */
export const conteneurDuLot = z.object({ contacts: z.array(z.unknown()) });

/** La vue agrégée du lot exposée dans OpenAPI. */
export const corpsLotDeFiches = z.strictObject({ contacts: z.array(schemaContactLotV1).min(1).max(MAX_BATCH) });

export const corpsChamp = z.strictObject({
  label: z.string().trim().min(1).max(100),
  type: z.enum(USER_FIELD_TYPES as [string, ...string[]]),
});

/**
 * `consent` et `consentSource` (plan 2026-10-23, tâche 4), facultatifs : sur un numéro relié par QR code, un message
 * écrit en premier (une personne sans fil, ou hors des 24 heures) exige une fiche `opted_in`, ou ce consentement
 * déclaré, écrit sur la fiche avant l'envoi, comme `POST /v1/sends` (source absente : `api`). Sans effet ailleurs : dans
 * les 24 heures, ou sur l'API de WhatsApp, qui n'écrit pas en premier par cette route. Seul `opted_in` se déclare ici :
 * un désabonnement passe par `PATCH /v1/contacts/{contactId}`.
 */
export const schemaMessageWhatsapp = z.strictObject({
  ...schemaClesFiche.shape,
  text: z.string().min(1).max(TEXTE_MAX_CARACTERES),
  consent: z.preprocess(videEnAbsent, z.enum(['opted_in']).optional()),
  consentSource: z.preprocess(videEnAbsent, z.string().trim().min(1).max(MAX_OPT_IN_SOURCE).optional()),
});

export const schemaMessageRcs = z.strictObject({
  ...schemaClesFiche.shape,
  text: z.string().trim().min(1).max(RCS_TEXTE_MAX),
});

export const requeteStatutModele = z.object({ language: z.string().max(20).optional() });

export const requeteJournal = z.strictObject({
  before: horodatageIso().optional(),
  limit: z.coerce.number().int().min(1).max(JOURNAL_PAGE_MAX).optional(),
});

export const corpsRejeu = z.strictObject({ since: horodatageIso() });
