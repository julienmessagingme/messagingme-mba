import { z } from 'zod';
import { USER_FIELD_TYPES } from '../crm/fields';
import { JOURNAL_PAGE_MAX } from '../evenements/gestion';
import { TEXTE_MAX_CARACTERES } from '../traduction/traduire';
import { RCS_TEXTE_MAX } from '../../web/lib/partage/rcs';
import { schemaContactLotV1 } from './contacts-v1';
import { schemaClesFiche } from './fiche';

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

export const schemaMessageWhatsapp = z.strictObject({
  ...schemaClesFiche.shape,
  text: z.string().min(1).max(TEXTE_MAX_CARACTERES),
});

export const schemaMessageRcs = z.strictObject({
  ...schemaClesFiche.shape,
  text: z.string().trim().min(1).max(RCS_TEXTE_MAX),
});

export const requeteStatutModele = z.object({ language: z.string().max(20).optional() });

export const requeteJournal = z.strictObject({
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(JOURNAL_PAGE_MAX).optional(),
});

export const corpsRejeu = z.strictObject({ since: z.string().datetime({ offset: true }) });
