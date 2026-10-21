import { ficheOutilMcp } from '../../web/lib/partage/catalogue-mcp';
import type { AnnotationsMcp, OutilMcp } from './outils';
import { RefusOutil, texteObligatoire } from './saisie';
import { CHAMPS_CIBLE_FILTRES, CHAMPS_CIBLE_IDENTIFIANTS, lireCibleMcp } from './cible';
import { ecriture, LOURDE, plafondCouteux, signataire } from './outils-agent';
import { creerChamp, type ChampsDep } from '../http/fields';
import { defPourEcriture } from '../crm/fields';
import { USER_FIELD_TYPES, canonicalizeFieldValue, validateFieldValue } from '../crm/fields';
import type { UserFieldDef } from '../crm/types';
import { SOCLE_FIELDS } from '../../web/lib/partage/champs';

/**
 * LES CHAMPS DEPUIS L'ASSISTANT (plan docs/superpowers/plans/2026-10-20-champs-depuis-claude.md) : les lister (une
 * variable de `prepare_campaign` peut en venir), en créer un, en remplir un sur une cible de contacts. 🔴 Aucune logique
 * propre : `creerChamp` est celle de l'écran Contenu et de `POST /v1/fields`, et le remplissage est l'action en masse
 * « définir un champ » du mini-CRM (`defPourEcriture`, `validateFieldValue`, `applyEditsMany`, qui n'émet rien).
 */
export interface DepsChampsMcp {
  /** Le référentiel des champs, le MÊME que l'écran et `/v1/fields`. */
  champs: Pick<ChampsDep, 'list' | 'create'>;
  /** Matérialise un champ de base (prénom, e-mail) absent, comme l'action en masse de la console. */
  ensureSocleField(tenantId: string, key: string, label: string, type: UserFieldDef['type']): Promise<void>;
}

const lecture = (title: string): AnnotationsMcp => ({ title, readOnlyHint: true, openWorldHint: false });

/** Libellé d'un champ : de quoi le reconnaître dans la console. */
export const LONGUEUR_MAX_LIBELLE_CHAMP = 80;
/** Clé d'un champ (le slug de son libellé) et valeur saisie, bornées comme la console. */
export const LONGUEUR_MAX_CLE_CHAMP = 120;
export const LONGUEUR_MAX_VALEUR_CHAMP = 1000;

export const OUTILS_CHAMPS: OutilMcp[] = [
  {
    ...ficheOutilMcp('list_fields'),
    fonction: null,
    description:
      'Lists the workspace\'s custom contact fields: key, label, type. A template variable can come from one of them in '
      + 'prepare_campaign ({"type":"field","key":"<key>"}); set_contact_field fills one on a target of contacts. The '
      + 'contact\'s name and number are not fields: use {"type":"attribute","key":"name"} or "phone".',
    annotations: lecture('List contact fields'),
    entree: { type: 'object', properties: {} },
    async executer(deps, tenantId) {
      const champs = await deps.champs.list(tenantId);
      // Les champs de base (prénom, e-mail) existent avant d'avoir servi : la fiche de la console les montre toujours, et
      // set_contact_field les crée à la première écriture. Sans eux, Claude ne saurait pas que le prénom est là.
      const absents = SOCLE_FIELDS.filter((s) => !champs.some((c) => c.key === s.key));
      return { fields: [...absents, ...champs].map((c) => ({ key: c.key, label: c.label, type: c.type })) };
    },
  },
  {
    ...ficheOutilMcp('create_field'),
    fonction: null,
    description:
      'Creates a custom contact field, as the console does: its key is derived from the label and never changes. '
      + 'A label that would duplicate a base field (name, phone…) or an existing field is refused.',
    annotations: ecriture('Create a contact field', false, false),
    entree: {
      type: 'object',
      properties: {
        label: { type: 'string', minLength: 1, maxLength: LONGUEUR_MAX_LIBELLE_CHAMP, description: 'The field label, e.g. "City".' },
        type: { type: 'string', enum: [...USER_FIELD_TYPES], description: 'The value type.' },
      },
      required: ['label', 'type'],
    },
    async executer(deps, tenantId, args, personne) {
      signataire(personne);
      const label = texteObligatoire(args, 'label', LONGUEUR_MAX_LIBELLE_CHAMP);
      const r = await creerChamp(deps.champs, tenantId, label, typeof args.type === 'string' ? args.type : '');
      if (!r.ok) throw new RefusOutil(r.erreur);
      return { key: r.champ.key, label: r.champ.label, type: r.champ.type };
    },
  },
  {
    ...ficheOutilMcp('set_contact_field'),
    fonction: 'console',
    description:
      'Sets a custom field to the same value on every contact of a target (same filters as find_contacts) or of a list '
      + 'of contacts or conversations, like the console\'s bulk action. The field must exist (list_fields, create_field); '
      + 'the value must match its type. It OVERWRITES the current value of every contact of the target: count the target '
      + 'with find_contacts first. Starts no automation. Returns how many contacts were updated. ' + LOURDE,
    annotations: ecriture('Set a contact field', true, false),
    entree: {
      type: 'object',
      properties: {
        key: { type: 'string', minLength: 1, maxLength: LONGUEUR_MAX_CLE_CHAMP, description: 'The field key (list_fields).' },
        value: { type: 'string', minLength: 1, maxLength: LONGUEUR_MAX_VALEUR_CHAMP, description: 'The value, matching the field type (number, date, true or false, https URL…).' },
        ...CHAMPS_CIBLE_FILTRES,
        ...CHAMPS_CIBLE_IDENTIFIANTS,
      },
      required: ['key', 'value'],
    },
    async executer(deps, tenantId, args, personne) {
      signataire(personne);
      const key = texteObligatoire(args, 'key', LONGUEUR_MAX_CLE_CHAMP);
      const value = texteObligatoire(args, 'value', LONGUEUR_MAX_VALEUR_CHAMP);
      const fonctions = (await deps.offres.offreDe(tenantId)).droits.fonctions;
      const cible = await lireCibleMcp(args, fonctions, deps, tenantId, { identifiants: true });
      const def = await defPourEcriture(deps, tenantId, key);
      if (!def) throw new RefusOutil(`champ inconnu : ${key} (list_fields donne les champs de l’espace, create_field en crée un)`);
      if (!validateFieldValue(def.type, value)) throw new RefusOutil(`valeur invalide pour « ${def.label} » (${def.type})`);
      await plafondCouteux(deps, tenantId);
      const { affected } = await deps.contacts.applyEditsMany(tenantId, cible, { setField: { key, value: canonicalizeFieldValue(def.type, value) } });
      return { updated: affected };
    },
  },
];
