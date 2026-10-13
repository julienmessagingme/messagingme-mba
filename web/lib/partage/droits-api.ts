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
 * Au plus dix clés actives par espace (décision de Julien, 2026-10-04). Chaque clé active est un secret confié à
 * quelqu'un : la borne limite les clés oubliées chez d'anciens intégrateurs, et révoquer en libère une place.
 * ⚠️ Ce n'est PAS un limiteur de débit : le plafond de l'API est déjà commun à toutes les clés de l'espace. La clé du
 * relais de l'agent de Meta n'y compte pas, et les clés déjà au-delà ne sont pas révoquées : seule la création est
 * refusée (409 au serveur, dit avant par l'écran).
 */
export const MAX_CLES_API_ACTIVES = 10;

/**
 * Le droit de la clé que la publication chez Meta pose pour le relais (`src/mba/cle-relais.ts`). 🔴 Absent
 * d'`API_SCOPES`, donc attribuable par personne depuis l'écran : son porteur peut appeler les outils de l'espace au
 * nom de n'importe quel contact. Cette clé ne compte pas dans le plafond.
 */
export const DROIT_RELAIS = 'mba:relais';
