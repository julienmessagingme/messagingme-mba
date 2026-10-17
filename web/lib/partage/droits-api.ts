/**
 * Les droits d'une clé d'API : ceux que la console propose en cases à cocher sont exactement ceux que le serveur
 * accepte. Un droit proposé et refusé rendrait 400 à la création ; un droit accepté mais jamais proposé ne serait
 * attribuable par personne.
 */

/**
 * Les droits qu'une clé peut porter (sous-ensemble non vide). `mcp:read` et `mcp:write` sont séparés des autres : une
 * clé donnée à un agent tiers pour lire l'Inbox n'emporte pas le droit d'écrire, et le serveur MCP ne liste même pas
 * les outils hors des droits de la clé.
 */
export const API_SCOPES = [
  'contacts:write', 'contacts:read', 'sends:create', 'mcp:read', 'mcp:write', 'conversations:read', 'templates:write',
  'webhooks:write', 'contacts:admin',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/**
 * Ce qui est COCHÉ D'AVANCE à la création d'une clé.
 *
 * 🔴 Les deux scopes MCP n'y sont volontairement PAS. L'écran cochait tout par défaut quand il n'y avait
 * que deux droits ; laisser ce geste tel quel aurait donné à toute clé neuve le droit d'ENVOYER des
 * WhatsApp au nom du client, sans que personne ne l'ait décidé. Ouvrir MCP doit rester une case qu'on coche.
 */
export const API_SCOPES_PAR_DEFAUT = ['contacts:write', 'sends:create'] as const satisfies readonly ApiScope[];

/**
 * Les droits de LA CLÉ DE L'APPLICATION, celle que créent la page « Démarrer », l'accueil d'une Free et l'outil MCP
 * `create_api_key` : ceux d'avance, plus la lecture des fils (lot 13), parce que l'application d'un vibe codeur répond
 * aux messages et que répondre demande le contexte. Partout ailleurs, ce droit reste une case à cocher.
 */
export const DROITS_CLE_APPLICATION = [...API_SCOPES_PAR_DEFAUT, 'conversations:read'] as const satisfies readonly ApiScope[];

/** La variable d'environnement où ranger la clé d'API de l'application. */
export const VARIABLE_CLE = 'MESSAGINGME_API_KEY';

/**
 * Le plafond de clés actives que la console suppose quand l'offre est inconnue (une panne, ou une API plus ancienne).
 * Le vrai plafond vient de l'offre depuis la spec offres v2 (`Limites.clesApi` : 2 en Free, 10 en Pro, sans limite en
 * Entreprise), et le serveur le tient en 402. Chaque clé active est un secret confié à quelqu'un : la borne limite les clés
 * oubliées chez d'anciens intégrateurs, et révoquer en libère une place.
 * ⚠️ Ce n'est PAS un limiteur de débit : le plafond de l'API est déjà commun à toutes les clés de l'espace. La clé du
 * relais de l'agent de Meta n'y compte pas, et les clés déjà au-delà ne sont pas révoquées : seule la création est refusée.
 */
export const MAX_CLES_API_ACTIVES = 10;

/**
 * Le droit de la clé que la publication chez Meta pose pour le relais (`src/mba/cle-relais.ts`). 🔴 Absent
 * d'`API_SCOPES`, donc attribuable par personne depuis l'écran : son porteur peut appeler les outils de l'espace au
 * nom de n'importe quel contact. Cette clé ne compte pas dans le plafond.
 */
export const DROIT_RELAIS = 'mba:relais';
