import { roleAdminEffectifSql } from '../offres/membres';

/**
 * LE SECOND FACTEUR EST EXIGÉ D'UNE IDENTITÉ quand elle a un compte ADMIN actif dans un espace qui l'exige
 * (`tenants.second_facteur_admins`, migration 0230, décision de Julien du 2026-10-13). Jusque-là, tout admin y était
 * tenu, et c'était le premier geste demandé à qui venait de créer son espace : c'est désormais un choix de l'espace,
 * désactivé à sa création, que ses admins activent dans Compte & équipe, et qui vaut alors pour TOUS ses admins.
 *
 * 🔴 UN SEUL TEXTE POUR SES DEUX LECTURES : la connexion (`findIdentity`, `src/auth/store.ts`) et l'état du facteur
 * (`obligatoire`, `src/auth/mfa-store.pg.ts`, que lisent l'inscription, l'invitation et Mon compte). Deux copies
 * finiraient par dire deux choses, et l'écart serait une porte : l'écran refuserait de retirer un facteur que la
 * connexion n'exige plus, ou l'inverse.
 *
 * ⚠️ Un compte en attente d'invitation est actif (`disabled_at` nul) : l'admin invité dans un espace qui l'exige pose
 * son facteur en acceptant. Un compte révoqué n'oblige plus à rien.
 *
 * ⚠️ L'EXPLOITATION N'EN DÉPEND PAS : son entrée exige toujours un code ou un enrôlement (`entreeOps`), et sa garde
 * relit le facteur à chaque requête (`makeRequireOps`). Ni ce réglage ni son absence n'y touchent.
 *
 * `identite` : l'expression SQL de l'identifiant d'identité dans la requête appelante (`i.id`).
 *
 * Le rôle lu est le rôle EFFECTIF (spec Business, jaune 3 de la relecture de A) : en Pro, tout membre est administrateur,
 * donc tenu au second facteur quand l'espace l'exige.
 */
export const facteurExigeSql = (identite: string): string => `exists (
  select 1 from users a join tenants ta on ta.id = a.tenant_id
   where a.identity_id = ${identite} and ${roleAdminEffectifSql('a')} and a.disabled_at is null and ta.second_facteur_admins)`;
