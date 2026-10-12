/** Contrat de l'onglet Outils de l'agent de Meta, partagé par la route et la console. */
import type { RisqueOutil } from './risque-outil';
export const TYPES_OUTIL_MBA = ['tag', 'champ', 'bloc', 'scenario', 'connecteur'] as const;
export type TypeOutilMba = (typeof TYPES_OUTIL_MBA)[number];

export const BORNES_OUTIL_MBA = { titre: 120, texte: 2000, tag: 64, champ: 64, valeur: 120, valeurs: 50 } as const;

export interface TextesOutil {
  name: string;
  title: string;
  description: string;
  nePasUtiliser: string;
}

/** Ce que la console peut envoyer à la route de création ou de modification. */
export type CibleSaisie =
  | { type: 'tag'; tag: string }
  | { type: 'champ'; champ: string; valeurs: string[] }
  | { type: 'bloc'; workflowId: string; code: string }
  | { type: 'scenario'; workflowId: string }
  | { type: 'connecteur'; requeteId: string };

/** Cible enrichie pour l'affichage ; MCP et inconnu ne se créent pas dans cet onglet. */
export type CibleVue =
  | { type: 'tag'; tag: string }
  | { type: 'champ'; champ: string; valeurs: string[] }
  | { type: 'bloc'; workflowId: string; code: string; scenario: string | null; bloc: string | null }
  | { type: 'scenario'; workflowId: string; scenario: string | null }
  | { type: 'connecteur'; requeteId: string; libelle: string | null }
  | { type: 'mcp'; sourceId: string | null; serveur: string | null }
  | { type: 'inconnu' };

export interface OutilMbaVue extends TextesOutil {
  id: string;
  type: TypeOutilMba | 'mcp' | 'inconnu';
  cible: CibleVue;
  cibleManquante: string | null;
  aussiUtilisePar: string[];
  actif: boolean;
  risque: RisqueOutil;
  publiable: boolean;
}

export interface OutilMcpProposable {
  id: string;
  name: string;
  title: string;
  description: string;
  serveur: string | null;
  risque: RisqueOutil;
  aussiUtilisePar: string[];
}

export interface BlocPropose {
  workflowId: string;
  scenario: string;
  code: string;
  nom: string;
  type: string;
  envoyable: boolean;
  raison: string | null;
}
