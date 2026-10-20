import type { BulkTarget } from '../crm/contact-store.pg';
import { filtersActive } from '../../web/lib/partage/contact-filters';
import { parseBulkTarget } from '../http/contacts';
import { estUuid } from '../http/scope';
import { CLES_FILTRABLES, estCleFiltrable, operateursDuChamp } from '../crm/filtre-fiche';
import { champFiche } from '../crm/champs-fiche';
import { FiltreContactInvalide, MAX_FIELD_FILTERS, MAX_TAGS } from '../crm/contact-filters';
import { LONGUEUR_MAX_ETIQUETTE } from '../crm/poser-etiquette';
import { OPERATEURS_FICHE_SEULS } from '../../web/lib/partage/contact-filters';
import { corpsRefusFonction } from '../offres/refus';
import type { Fonction } from '../offres/offres';
import type { ProprieteEntree } from './outils';
import { RefusOutil } from './saisie';

/**
 * LA CIBLE D'UN OUTIL DE CAMPAGNE (plan « Campagnes depuis Claude », tâche 4) : les contacts que l'assistant désigne,
 * par étiquettes, consentement et, en Entreprise, champs de la dernière analyse ; ou par identifiants de contacts ou de
 * conversations. 🔴 Elle passe par `parseBulkTarget`, l'analyseur du mini-CRM et de la création de campagne : un second
 * analyseur ferait viser à l'assistant autre chose que ce que la console montre. Ce module n'ajoute que ce qui précède
 * cet analyseur, et le durcit sur trois points qu'un modèle rencontre et pas un écran :
 * - une cible sans critère est REFUSÉE (la console appelle « tous les contacts » une cible vide, et une campagne
 *   construite dessus partirait à tout l'espace) ;
 * - ce qui dépasse un plafond est refusé, jamais tronqué (un filtre jeté élargit l'audience) ;
 * - l'analyse exige la fonction `analyse` (l'Entreprise), avec le lien de l'offre.
 */

/** Identifiants par appel : de quoi étiqueter les contacts de quelques centaines de conversations par passage (spec, choix 7). */
export const MAX_IDENTIFIANTS_CIBLE = 500;

export interface DepsCibleMcp {
  inbox: {
    /** Les fiches des conversations désignées, DANS l'espace : une conversation d'un autre espace ne rend rien. */
    contactIdsDesConversations(tenantId: string, conversationIds: string[]): Promise<string[]>;
  };
  contacts: {
    /** Les identifiants d'une cible, DANS l'espace : un contact d'un autre espace ne rend rien. */
    contactIdsForTarget(tenantId: string, target: BulkTarget, limite?: number): Promise<string[]>;
  };
}

const OPERATEURS_ANALYSE = [...OPERATEURS_FICHE_SEULS, 'empty', 'not_empty'];

/** Ce que chaque champ d'analyse accepte, DÉRIVÉ des champs de la fiche : jamais une liste recopiée. */
const AIDE_ANALYSE = CLES_FILTRABLES.map((cle) => {
  const champ = champFiche(cle)!;
  const valeurs = champ.type.nature === 'choix' ? ` (values: ${champ.type.valeurs.join(', ')})` : champ.type.nature === 'note' ? ' (value 0 to 10)' : champ.type.nature === 'date' ? ' (value: a number of days)' : '';
  return `${cle}: ${operateursDuChamp(champ).join('/')}${valeurs}`;
}).join('; ');

/** Les paramètres de cible, annoncés par chaque outil qui en prend une. Toute borne appliquée ici y figure. */
export const CHAMPS_CIBLE_FILTRES: Record<string, ProprieteEntree> = {
  tags: {
    type: 'array', minItems: 1, maxItems: MAX_TAGS, items: { type: 'string', minLength: 1, maxLength: LONGUEUR_MAX_ETIQUETTE },
    description: 'Contacts carrying these tags. A segment IS a tag: tag the contacts first (tag_contacts), then target the tag.',
  },
  tag_mode: { type: 'string', enum: ['all', 'any'], description: '"all" (default): every tag; "any": at least one.' },
  opt_in: {
    type: 'string', enum: ['opted_in', 'opted_out', 'unknown'],
    description: 'Marketing consent. A marketing template only ever reaches opted_in contacts, whatever the target.',
  },
  analysis: {
    type: 'array', minItems: 1, maxItems: MAX_FIELD_FILTERS,
    items: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: [...CLES_FILTRABLES], description: 'A field of the latest conversation analysis.' },
        op: { type: 'string', enum: OPERATEURS_ANALYSE, description: 'The operator, among those of the field.' },
        value: { type: 'string', maxLength: 500, description: 'Comma-separated values for "in"; empty for empty, not_empty, is_true, is_false.' },
      },
      required: ['field', 'op'],
      additionalProperties: false,
    },
    description: `Enterprise plan only. Filters on each contact's latest conversation analysis: ${AIDE_ANALYSE}.`,
  },
};
export const CHAMPS_CIBLE_IDENTIFIANTS: Record<string, ProprieteEntree> = {
  contact_ids: {
    type: 'array', minItems: 1, maxItems: MAX_IDENTIFIANTS_CIBLE, items: { type: 'string', format: 'uuid' },
    description: `Contacts by id (contact_id of list_conversations or find_contacts), ${MAX_IDENTIFIANTS_CIBLE} at most. Not combined with filters.`,
  },
  conversation_ids: {
    type: 'array', minItems: 1, maxItems: MAX_IDENTIFIANTS_CIBLE, items: { type: 'string', format: 'uuid' },
    description: `The contacts of these conversations, ${MAX_IDENTIFIANTS_CIBLE} at most. Not combined with filters.`,
  },
};

const present = (v: unknown): boolean => v !== undefined && v !== null;

function identifiants(v: unknown, cle: string): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new RefusOutil(`paramètre « ${cle} » : une liste d'identifiants non vide est attendue`);
  if (v.length > MAX_IDENTIFIANTS_CIBLE) throw new RefusOutil(`paramètre « ${cle} » : ${MAX_IDENTIFIANTS_CIBLE} identifiants au plus par appel`);
  if (!v.every(estUuid)) throw new RefusOutil(`paramètre « ${cle} » : identifiant mal formé`);
  return [...new Set(v)];
}

/**
 * Lit la cible d'un outil. `identifiants` : l'outil accepte-t-il une liste d'identifiants (`tag_contacts`, la cible
 * d'une campagne) ou seulement des filtres (`find_contacts`, qui les compte) ? Lève `RefusOutil` sur tout ce qui ne se
 * lit pas, AVANT toute lecture en base.
 */
export async function lireCibleMcp(
  args: Record<string, unknown>, fonctions: ReadonlySet<Fonction>, deps: DepsCibleMcp, tenantId: string, opts: { identifiants: boolean },
): Promise<BulkTarget> {
  const parContacts = present(args.contact_ids);
  const parConversations = present(args.conversation_ids);
  const parFiltres = ['tags', 'tag_mode', 'opt_in', 'analysis'].some((k) => present(args[k]));

  if (parContacts || parConversations) {
    if (!opts.identifiants) throw new RefusOutil('cet outil cible par étiquettes, consentement ou analyse, pas par identifiants');
    if (parContacts && parConversations) throw new RefusOutil('contact_ids ou conversation_ids, pas les deux');
    if (parFiltres) throw new RefusOutil('une liste d’identifiants ne se combine pas avec des filtres : l’un ou l’autre');
    // Résolus DANS l'espace, aux deux portes : un identifiant d'ailleurs ne désigne personne, et une liste qui ne désigne
    // personne est refusée plutôt que de répondre « 0 » (relecture du lot des campagnes, constat 2).
    const ids = parContacts
      ? await deps.contacts.contactIdsForTarget(tenantId, { ids: identifiants(args.contact_ids, 'contact_ids') })
      : await deps.inbox.contactIdsDesConversations(tenantId, identifiants(args.conversation_ids, 'conversation_ids'));
    const cible = parseBulkTarget({ ids });
    if (cible === null) {
      throw new RefusOutil(parContacts
        ? 'aucun de ces contacts n’existe dans cet espace'
        : 'aucune de ces conversations n’a de contact dans cet espace');
    }
    return cible;
  }

  const tags = args.tags;
  if (present(tags) && (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string'))) throw new RefusOutil('paramètre « tags » : une liste de textes est attendue');
  if (Array.isArray(tags) && tags.length > MAX_TAGS) throw new RefusOutil(`paramètre « tags » : ${MAX_TAGS} étiquettes au plus`);
  if (present(args.tag_mode) && args.tag_mode !== 'all' && args.tag_mode !== 'any') throw new RefusOutil('paramètre « tag_mode » : "all" ou "any"');
  if (present(args.opt_in) && !['opted_in', 'opted_out', 'unknown'].includes(args.opt_in as string)) {
    throw new RefusOutil('paramètre « opt_in » : opted_in, opted_out ou unknown');
  }
  const analyse = args.analysis;
  if (present(analyse) && !Array.isArray(analyse)) throw new RefusOutil('paramètre « analysis » : une liste de filtres est attendue');
  const filtresAnalyse = Array.isArray(analyse) ? analyse : [];
  if (filtresAnalyse.length > MAX_FIELD_FILTERS) throw new RefusOutil(`paramètre « analysis » : ${MAX_FIELD_FILTERS} filtres au plus`);
  if (filtresAnalyse.length > 0 && !fonctions.has('analyse')) throw new RefusOutil(corpsRefusFonction('analyse').error);
  const fieldFilters = filtresAnalyse.map((f: unknown) => {
    const { field, op, value } = (f !== null && typeof f === 'object' ? f : {}) as { field?: unknown; op?: unknown; value?: unknown };
    // Seuls les champs de la dernière analyse : un champ personnalisé n'est pas annoncé, donc pas accepté.
    if (!estCleFiltrable(field)) throw new RefusOutil(`filtre d’analyse : champ inconnu (${CLES_FILTRABLES.join(', ')})`);
    return { key: field, op, value: typeof value === 'string' ? value : '' };
  });

  let cible: BulkTarget | null;
  try {
    cible = parseBulkTarget({
      filters: { tags: Array.isArray(tags) ? tags : [], tagMode: args.tag_mode === 'any' ? 'or' : 'and', optIn: args.opt_in, fieldFilters },
    });
  } catch (e) {
    // Un opérateur ou une valeur que le champ ne connaît pas : la phrase du mini-CRM, telle quelle.
    if (e instanceof FiltreContactInvalide) throw new RefusOutil(e.message);
    throw e;
  }
  // 🔴 Une cible sans critère n'est JAMAIS « tout le monde » ici, contrairement au « tout sélectionner » de la console.
  if (cible === null || !('filters' in cible) || !filtersActive(cible.filters)) {
    throw new RefusOutil('précisez au moins un critère : tags, opt_in, analysis, ou une liste de contact_ids ou de conversation_ids');
  }
  return cible;
}
