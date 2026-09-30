import { ACTIONS, HANDLED_BY, INTENTS, SENTIMENTS } from '../analysis/schema';
import { NIVEAUX_RISQUE } from '../engagement/risque';

/**
 * LA LISTE UNIQUE DES CHAMPS DE LA FICHE (chantier « Tout sur la fiche », lot 2, spec
 * `docs/superpowers/specs/2026-09-30-fiche-unique-design.md`).
 *
 * Chaque endroit qui choisit un champ de la fiche lit cette liste au lieu de porter la sienne : les données
 * envoyées d'un connecteur (origine `fiche`), et, au lot 2b, les filtres de la liste des contacts, le ciblage
 * d'une campagne et le bloc Condition. La console la reçoit de l'API (`GET /tenants/:t/champs-fiche`) et n'en
 * recopie aucune. Les variables de message n'en font PAS partie (décision 9).
 *
 * 🔴 LISTE FERMÉE, et c'est une garde : un champ n'atteint un système tiers que s'il y figure avec `sortieTiers`,
 * et qu'un admin l'a choisi. Les colonnes techniques (jeton de suivi, identifiants internes, auteur d'un blocage)
 * n'y sont pas, et n'y entrent jamais par défaut.
 *
 * Les listes de valeurs viennent du schéma de l'analyse et des règles du risque : aucune n'est recopiée ici.
 */

export type ProvenanceChamp = 'base' | 'perso' | 'analyse' | 'risque';

export type TypeChamp =
  | { nature: 'texte' }
  | { nature: 'note' }
  | { nature: 'oui_non' }
  | { nature: 'date' }
  | { nature: 'choix'; valeurs: readonly string[] };

export interface ChampFiche {
  cle: string;
  /** [français, anglais] : la console choisit selon la langue, sans recopier de libellé. */
  libelle: readonly [string, string];
  provenance: ProvenanceChamp;
  type: TypeChamp;
  /** Modifiable à la main sur la fiche. Les champs d'analyse et le risque ne le sont jamais (décision 5). */
  modifiable: boolean;
  /** Peut partir dans les données envoyées d'un connecteur, quand un admin le choisit. */
  sortieTiers: boolean;
}

const texte = { nature: 'texte' } as const;
const note = { nature: 'note' } as const;
const date = { nature: 'date' } as const;
const choix = (valeurs: readonly string[]) => ({ nature: 'choix', valeurs }) as const;

/**
 * Les champs FIXES de la fiche, dans l'ordre d'affichage. Les champs personnalisés s'y ajoutent à la lecture
 * (`champsDeLaFiche`), depuis `user_fields`.
 */
export const CHAMPS_FICHE_FIXES = [
  { cle: 'wa_id', libelle: ['numéro du contact', 'contact’s number'], provenance: 'base', type: texte, modifiable: false, sortieTiers: true },
  { cle: 'nom', libelle: ['nom du contact', 'contact’s name'], provenance: 'base', type: texte, modifiable: true, sortieTiers: true },
  { cle: 'external_id', libelle: ['identifiant externe', 'external ID'], provenance: 'base', type: texte, modifiable: false, sortieTiers: true },
  { cle: 'created_at', libelle: ['date de création de la fiche', 'record creation date'], provenance: 'base', type: date, modifiable: false, sortieTiers: true },
  { cle: 'analyse_intention', libelle: ['intention de la dernière analyse', 'latest analysis intent'], provenance: 'analyse', type: choix(INTENTS), modifiable: false, sortieTiers: true },
  { cle: 'analyse_sentiment', libelle: ['sentiment de la dernière analyse', 'latest analysis sentiment'], provenance: 'analyse', type: choix(SENTIMENTS), modifiable: false, sortieTiers: true },
  { cle: 'analyse_satisfaction', libelle: ['satisfaction de la dernière analyse (0 à 10)', 'latest analysis satisfaction (0 to 10)'], provenance: 'analyse', type: note, modifiable: false, sortieTiers: true },
  { cle: 'analyse_urgence', libelle: ['urgence de la dernière analyse (0 à 10)', 'latest analysis urgency (0 to 10)'], provenance: 'analyse', type: note, modifiable: false, sortieTiers: true },
  { cle: 'analyse_resolue', libelle: ['dernière conversation résolue (oui/non)', 'latest conversation resolved (yes/no)'], provenance: 'analyse', type: { nature: 'oui_non' }, modifiable: false, sortieTiers: true },
  { cle: 'analyse_sujet', libelle: ['sujet de la dernière analyse', 'latest analysis topic'], provenance: 'analyse', type: texte, modifiable: false, sortieTiers: true },
  { cle: 'analyse_traitee_par', libelle: ['dernière conversation traitée par', 'latest conversation handled by'], provenance: 'analyse', type: choix(HANDLED_BY), modifiable: false, sortieTiers: true },
  { cle: 'analyse_action', libelle: ['action suggérée par la dernière analyse', 'latest analysis suggested action'], provenance: 'analyse', type: choix(ACTIONS), modifiable: false, sortieTiers: true },
  { cle: 'analyse_le', libelle: ['date de la dernière analyse', 'latest analysis date'], provenance: 'analyse', type: date, modifiable: false, sortieTiers: true },
  { cle: 'risque_depart', libelle: ['risque de départ du contact', 'contact’s churn risk'], provenance: 'risque', type: choix(NIVEAUX_RISQUE), modifiable: false, sortieTiers: true },
] as const satisfies readonly ChampFiche[];

export type CleFicheFixe = (typeof CHAMPS_FICHE_FIXES)[number]['cle'];
export const CLES_FICHE_FIXES: readonly CleFicheFixe[] = CHAMPS_FICHE_FIXES.map((c) => c.cle);

/** Les champs fixes qui peuvent partir chez un tiers : les clés que l'origine `fiche` d'un connecteur accepte. */
export const CLES_FICHE_SORTIE: readonly CleFicheFixe[] = CHAMPS_FICHE_FIXES.filter((c) => c.sortieTiers).map((c) => c.cle);

export function estCleFicheFixe(cle: string): cle is CleFicheFixe {
  return (CLES_FICHE_FIXES as readonly string[]).includes(cle);
}

export function champFiche(cle: string): ChampFiche | undefined {
  return CHAMPS_FICHE_FIXES.find((c) => c.cle === cle);
}

/**
 * Une clé qu'un champ personnalisé ne peut pas prendre : celle d'un champ fixe de la fiche. Sans cette garde, un
 * import CSV avec une colonne « analyse_sentiment » créerait un champ perso qui se confondrait avec le champ
 * d'analyse. Ensemble SÉPARÉ de `SYSTEM_FIELD_KEYS` (amendement 1 de la spec) : celui-là alimente les variables de
 * message et rend 403 en suppression.
 */
export function estCleReservee(cle: string): boolean {
  return estCleFicheFixe(cle);
}

/** Un champ personnalisé tel que `user_fields` le décrit. */
export interface DefinitionPerso {
  key: string;
  label: string;
  type: string;
}

/** La liste entière pour un espace : les champs fixes, puis ses champs personnalisés, modifiables, en texte. */
export function champsDeLaFiche(perso: readonly DefinitionPerso[]): ChampFiche[] {
  return [
    ...CHAMPS_FICHE_FIXES,
    ...perso
      .filter((d) => !estCleReservee(d.key))
      .map((d): ChampFiche => ({
        cle: d.key, libelle: [d.label, d.label], provenance: 'perso', type: texte, modifiable: true, sortieTiers: true,
      })),
  ];
}
