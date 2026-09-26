// web/lib/api-champs.ts
import { BORNES, type Bilingue } from './api-exemples';
import type { LienVers } from './doc-api-pages';

/**
 * LES TABLEAUX DE CHAMPS DE LA DOCUMENTATION DE L'API : pour chaque corps de requête, ses champs, leur type, leur
 * obligation et une description courte. Les pages les affichent (`<Champs>`, `components/doc-api/elements.tsx`),
 * elles ne les écrivent pas.
 *
 * 🔴 TENUS ÉGAUX AUX SCHÉMAS DU SERVEUR par `tests/api-champs-parite.test.ts` : chaque tableau est comparé aux clés
 * du schéma zod de sa route (`src/http/v1-*.ts`, `src/api/*`), dans les deux sens. Un champ ajouté au serveur sans
 * la doc, ou documenté sans exister, fait tomber le test ; l'obligation, le type, les valeurs d'une énumération,
 * le sort d'une clé inconnue et les clés refusées sont vérifiés de la même façon.
 *
 * ⚠️ AUCUN IMPORT DE VALEUR hors de `web/lib/` sans alias : ce fichier est lu par le build de la console ET par la
 * suite racine (la même contrainte que `api-exemples.ts`).
 *
 * ⚠️ AUCUN CODE D'ERREUR ICI : un code se cite dans une page par `<Code>`, typé sur la table des codes, pour
 * qu'un code inventé ne compile pas. Un texte d'ici ne le serait pas.
 */

/** Le type affiché d'un champ. Fermé : la suite le compare à ce que le schéma accepte. */
export type TypeChamp = 'string' | 'uuid' | 'integer' | 'object' | 'string[]' | 'object[]';

/** `oui`, `non`, ou une condition (« une clé au moins »), que la suite traite comme « optionnel dans le schéma ». */
export type Obligation = 'oui' | 'non' | Bilingue;

export interface ChampDoc {
  readonly nom: string;
  readonly type: TypeChamp;
  readonly obligatoire: Obligation;
  readonly quoi: Bilingue;
  /** Les valeurs d'une énumération : la suite les tient égales au schéma. */
  readonly valeurs?: readonly string[];
  /** Où lire la règle complète, quand elle vit ailleurs (Concepts). */
  readonly voir?: { readonly lien: LienVers; readonly libelle: Bilingue };
}

export interface TableDeChamps {
  readonly champs: readonly ChampDoc[];
  /** Ce que la route fait d'une clé qu'elle ne connaît pas. */
  readonly inconnues: 'ignorees' | 'refusees';
  /** Des clés que la route REFUSE (400) alors qu'on pourrait les croire admises. */
  readonly refusees?: { readonly noms: readonly string[]; readonly pourquoi: Bilingue };
}

const UNE_CLE: Bilingue = ['Une clé au moins', 'At least one key'];
const VOIR_IDENTIFICATION = {
  lien: { page: 'concepts', ancre: 'identification' },
  libelle: ['Désigner une personne', 'Identifying a person'],
} as const satisfies ChampDoc['voir'];
const VOIR_CONSENTEMENT = {
  lien: { page: 'concepts', ancre: 'consentement' },
  libelle: ['Consentement et STOP', 'Consent and STOP'],
} as const satisfies ChampDoc['voir'];

/** Les quatre clés d'une fiche. `obligatoire` dit la règle de la route (une clé au moins, en général). */
function clesDeFiche(obligatoire: Obligation = UNE_CLE): ChampDoc[] {
  return [
    {
      nom: 'contactId', type: 'uuid', obligatoire,
      quoi: ['L’identifiant de la fiche, rendu à sa création.', 'The record id, returned when it is created.'],
      voir: VOIR_IDENTIFICATION,
    },
    {
      nom: 'externalId', type: 'string', obligatoire,
      quoi: [
        `Votre identifiant de la personne, unique par espace, ${BORNES.externalId} caractères au plus.`,
        `Your id for the person, unique per workspace, ${BORNES.externalId} characters at most.`,
      ],
    },
    {
      nom: 'phone', type: 'string', obligatoire,
      quoi: ['Le numéro, au format international (+33…).', 'The phone number, in international format (+33…).'],
    },
    {
      nom: 'bsuid', type: 'string', obligatoire,
      quoi: ['L’identifiant WhatsApp d’une personne sans numéro visible.', 'The WhatsApp id of a person with no visible number.'],
    },
  ];
}

const CONSENT = (quoi: Bilingue): ChampDoc => ({
  nom: 'consent', type: 'string', obligatoire: 'non', valeurs: ['opted_in', 'opted_out'], quoi, voir: VOIR_CONSENTEMENT,
});
const CONSENT_SOURCE: ChampDoc = {
  nom: 'consentSource', type: 'string', obligatoire: 'non',
  quoi: [
    `D’où vient le consentement, ${BORNES.consentSource} caractères au plus. Absent : api.`,
    `Where the consent comes from, ${BORNES.consentSource} characters at most. Missing: api.`,
  ],
};

const CONTACT: TableDeChamps = {
  champs: [
    ...clesDeFiche(),
    { nom: 'name', type: 'string', obligatoire: 'non', quoi: ['Le nom affiché.', 'The display name.'] },
    {
      nom: 'fields', type: 'object', obligatoire: 'non',
      quoi: [
        `Les champs de la fiche, par clé technique ou code fld_, ${BORNES.parFiche} au plus. Valeur texte, nombre ou booléen, enregistrée en texte. Un champ inconnu de l’espace est refusé : créez-le d’abord dans la console (Bibliothèque > Champs).`,
        `The record fields, by technical key or fld_ code, ${BORNES.parFiche} at most. Text, number or boolean value, stored as text. A field unknown to the workspace is refused: create it first in the console (Library > Fields).`,
      ],
    },
    {
      nom: 'tags', type: 'string[]', obligatoire: 'non',
      quoi: [
        `Des tags à ajouter, ${BORNES.parFiche} au plus. Aucun n’est retiré : PATCH le fait. Un tag inconnu de l’espace est refusé : déclarez-le d’abord dans la console (Bibliothèque > Étiquettes).`,
        `Tags to add, ${BORNES.parFiche} at most. None is removed: PATCH does that. A tag unknown to the workspace is refused: declare it first in the console (Library > Tags).`,
      ],
    },
    CONSENT(['Absent : inchangé.', 'Missing: unchanged.']),
    CONSENT_SOURCE,
  ],
  inconnues: 'ignorees',
  refusees: { noms: ['optIn', 'optInSource'], pourquoi: ['les anciens noms de consent et consentSource', 'the former names of consent and consentSource'] },
};

export const CHAMPS = {
  contact: CONTACT,
  lot: {
    champs: [{
      nom: 'contacts', type: 'object[]', obligatoire: 'oui',
      quoi: [
        `De 1 à ${BORNES.contactsParLot} fiches, chacune avec les champs de POST /v1/contacts, mais ${BORNES.parFicheEnLot} champs et ${BORNES.parFicheEnLot} tags au plus par fiche.`,
        `From 1 to ${BORNES.contactsParLot} records, each with the fields of POST /v1/contacts, but ${BORNES.parFicheEnLot} fields and ${BORNES.parFicheEnLot} tags at most per record.`,
      ],
    }],
    inconnues: 'ignorees',
  },
  recherche: {
    champs: clesDeFiche(['Exactement une', 'Exactly one']).filter((c) => c.nom !== 'contactId'),
    inconnues: 'ignorees',
  },
  modification: {
    champs: [
      { nom: 'name', type: 'string', obligatoire: 'non', quoi: ['Le nouveau nom. null le vide.', 'The new name. null clears it.'] },
      {
        nom: 'fields', type: 'object', obligatoire: 'non',
        quoi: [
          `Fusionnés avec les champs de la fiche, ${BORNES.parFiche} au plus. Une valeur null vide le champ. Un champ inconnu de l’espace est refusé.`,
          `Merged with the record fields, ${BORNES.parFiche} at most. A null value clears the field. A field unknown to the workspace is refused.`,
        ],
      },
      {
        nom: 'addTags', type: 'string[]', obligatoire: 'non',
        quoi: [
          `Des tags à ajouter, ${BORNES.parFiche} au plus. Un tag inconnu de l’espace est refusé.`,
          `Tags to add, ${BORNES.parFiche} at most. A tag unknown to the workspace is refused.`,
        ],
      },
      {
        nom: 'removeTags', type: 'string[]', obligatoire: 'non',
        quoi: [`Des tags à retirer, ${BORNES.parFiche} au plus.`, `Tags to remove, ${BORNES.parFiche} at most.`],
      },
      CONSENT(['Absent : inchangé.', 'Missing: unchanged.']),
      CONSENT_SOURCE,
      {
        nom: 'externalId', type: 'string', obligatoire: 'non',
        quoi: [
          `Pose ou remplace votre identifiant, ${BORNES.externalId} caractères au plus.`,
          `Sets or replaces your id, ${BORNES.externalId} characters at most.`,
        ],
      },
    ],
    inconnues: 'ignorees',
    refusees: { noms: ['phone', 'bsuid'], pourquoi: ['ils portent les conversations de la fiche', 'they carry the record’s conversations'] },
  },
  messageWhatsapp: {
    champs: [
      ...clesDeFiche(),
      {
        nom: 'text', type: 'string', obligatoire: 'oui',
        quoi: [`Le texte, ${BORNES.texteWhatsapp} caractères au plus.`, `The text, ${BORNES.texteWhatsapp} characters at most.`],
      },
    ],
    inconnues: 'refusees',
  },
  messageRcs: {
    champs: [
      ...clesDeFiche(),
      {
        nom: 'text', type: 'string', obligatoire: 'oui',
        quoi: [`Le texte, ${BORNES.texteRcs} caractères au plus.`, `The text, ${BORNES.texteRcs} characters at most.`],
      },
    ],
    inconnues: 'refusees',
  },
  envoi: {
    champs: [
      {
        nom: 'idempotencyKey', type: 'string', obligatoire: ['Oui, ici ou en en-tête Idempotency-Key', 'Yes, here or in the Idempotency-Key header'],
        quoi: [
          `La clé qui rend l’appel rejouable sans double envoi, ${BORNES.cleIdempotence} caractères au plus.`,
          `The key that makes the call safe to replay without a double send, ${BORNES.cleIdempotence} characters at most.`,
        ],
        voir: { lien: { page: 'concepts', ancre: 'idempotence' }, libelle: ['Idempotence', 'Idempotency'] },
      },
      {
        nom: 'target', type: 'object', obligatoire: 'oui',
        quoi: ['Ce qui part : un template, un scénario, un bloc ou un message RCS.', 'What goes out: a template, a scenario, a block or an RCS message.'],
      },
      {
        nom: 'recipients', type: 'object[]', obligatoire: 'oui',
        quoi: [`De 1 à ${BORNES.destinatairesParEnvoi} destinataires.`, `From 1 to ${BORNES.destinatairesParEnvoi} recipients.`],
      },
      {
        nom: 'params', type: 'object[]', obligatoire: 'non',
        quoi: ['Les variables du template qui part.', 'The variables of the template that goes out.'],
      },
      {
        nom: 'category', type: 'string', obligatoire: ['Oui, sauf pour un template', 'Yes, except for a template'],
        valeurs: ['marketing', 'utility'],
        quoi: [
          'Refusée sur un template : sa catégorie est lue chez Meta.',
          'Refused on a template: its category is read at Meta.',
        ],
      },
      {
        nom: 'ratePerMinute', type: 'integer', obligatoire: 'non',
        quoi: [
          `De 1 à ${BORNES.debitParMinute} messages par minute. Le plafond du canal s’applique ensuite, il peut être plus bas.`,
          `From 1 to ${BORNES.debitParMinute} messages per minute. The channel’s own cap applies afterwards, and may be lower.`,
        ],
      },
      {
        nom: 'phoneNumberId', type: 'string', obligatoire: 'non',
        quoi: [
          'Le numéro WhatsApp qui envoie. Absent : le numéro par défaut de l’espace. Ignoré pour un message RCS.',
          'The WhatsApp number that sends. Missing: the workspace’s default number. Ignored for an RCS message.',
        ],
      },
    ],
    inconnues: 'refusees',
  },
  destinataire: {
    champs: [
      ...clesDeFiche(),
      CONSENT([
        'Écrit sur la fiche avant le tri. opted_out désabonne et écarte ce destinataire.',
        'Written on the record before filtering. opted_out opts the record out and skips this recipient.',
      ]),
      CONSENT_SOURCE,
      {
        nom: 'variables', type: 'object', obligatoire: 'non',
        quoi: [
          `Des valeurs propres à ce destinataire, jamais écrites sur la fiche. ${BORNES.variablesParDestinataire} au plus, de ${BORNES.valeurVariable} caractères au plus ; noms en lettres, chiffres, _, . ou -.`,
          `Values specific to this recipient, never written on the record. ${BORNES.variablesParDestinataire} at most, of ${BORNES.valeurVariable} characters at most; names in letters, digits, _, . or -.`,
        ],
      },
    ],
    inconnues: 'ignorees',
  },
  param: {
    champs: [
      {
        nom: 'position', type: 'integer', obligatoire: 'oui',
        quoi: ['La variable du template : 1 pour {{1}}. Positions de 1 à N, sans trou.', 'The template variable: 1 for {{1}}. Positions 1 to N, with no gap.'],
      },
      { nom: 'source', type: 'object', obligatoire: 'oui', quoi: ['D’où vient la valeur.', 'Where the value comes from.'] },
      {
        nom: 'fallback', type: 'string', obligatoire: 'non',
        quoi: ['La valeur de repli, quand la source est vide.', 'The fallback value, when the source is empty.'],
      },
    ],
    inconnues: 'ignorees',
  },
} as const satisfies Record<string, TableDeChamps>;

export type NomDeTable = keyof typeof CHAMPS;

/** Les cibles d'un envoi (`target`), et le canal que chacune donne. */
export interface CibleDoc {
  readonly nom: 'template' | 'scenario' | 'node' | 'rcsMessage';
  /** Les clés d'une cible objet (le template) ; absent pour une cible texte. */
  readonly cles?: readonly string[];
  readonly valeur: Bilingue;
  readonly canal: Bilingue;
}

export const CIBLES = [
  {
    nom: 'template', cles: ['name', 'language'],
    valeur: [
      'un objet : name et language d’un template approuvé (GET /v1/templates)',
      'an object: name and language of an approved template (GET /v1/templates)',
    ],
    canal: ['WhatsApp', 'WhatsApp'],
  },
  {
    nom: 'scenario',
    valeur: ['le code scn_ ou le nom d’un scénario (GET /v1/scenarios)', 'the scn_ code or the name of a scenario (GET /v1/scenarios)'],
    canal: ['celui de son premier envoi', 'that of its first send'],
  },
  {
    nom: 'node',
    valeur: [
      'le code nod_ d’un bloc (Contenu > Blocs, ou entryNode dans GET /v1/scenarios)',
      'the nod_ code of a block (Content > Blocks, or entryNode in GET /v1/scenarios)',
    ],
    canal: ['celui de son premier envoi', 'that of its first send'],
  },
  {
    nom: 'rcsMessage',
    valeur: [
      'le nom d’un message de Contenu > Messages RCS (GET /v1/rcs-messages)',
      'the name of a message in Content > RCS messages (GET /v1/rcs-messages)',
    ],
    canal: ['RCS, par l’agent RCS de l’espace', 'RCS, from the workspace’s RCS agent'],
  },
] as const satisfies readonly CibleDoc[];

/** Les sources d'un paramètre (`params[].source`) : leur `type`, la clé qu'elles portent, ce qu'elles lisent. */
export interface SourceDoc {
  readonly type: 'field' | 'attribute' | 'now' | 'literal' | 'variable';
  /** La seconde clé de la source, obligatoire quand elle existe. */
  readonly cle?: 'key' | 'value';
  /** Les valeurs admises de cette clé, quand elles sont fermées. */
  readonly valeurs?: readonly string[];
  readonly quoi: Bilingue;
}

export const SOURCES_PARAM = [
  { type: 'field', cle: 'key', quoi: ['un champ de la fiche, par sa clé', 'a record field, by its key'] },
  {
    type: 'attribute', cle: 'key', valeurs: ['name', 'phone', 'bsuid', 'wa_id'],
    quoi: ['un attribut de la fiche', 'a record attribute'],
  },
  { type: 'now', quoi: ['la date du jour (JJ/MM/AAAA, heure de Paris)', 'today’s date (DD/MM/YYYY, Paris time)'] },
  { type: 'literal', cle: 'value', quoi: ['un texte fixe', 'a fixed text'] },
  {
    type: 'variable', cle: 'key',
    quoi: ['une variable du destinataire (recipients[].variables), sur un template seulement', 'a recipient variable (recipients[].variables), on a template only'],
  },
] as const satisfies readonly SourceDoc[];
