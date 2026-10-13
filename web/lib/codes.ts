/**
 * Codes publics calculables côté front. Module PUR, zéro import : c'est ce qui permet de le tester depuis la
 * suite racine par import relatif (le tsconfig racine n'a pas la lib DOM, donc tirer `./api` ferait échouer
 * la compilation sur `window`). Même parti pris que `web/lib/flow-mapping.ts`.
 */

/**
 * Code public DÉTERMINISTE et réservé d'un champ SYSTÈME (name/prenom/phone/bsuid/wa_id/email) :
 * `fld_<tenantCode>_sys_<key>`. Pas de ligne en base, pas d'ULID : les champs système sont des constantes de
 * code, leur identifiant se CALCULE, donc un consommateur de l'API peut le dériver sans nous le demander.
 * Le segment `sys_` le distingue sans ambiguïté d'un ULID (26 caractères majuscules).
 *
 * Le pendant SERVEUR n'est pas un générateur mais un LECTEUR : `SYS_RE` dans `src/ids/resolve.ts` reconnaît
 * ce format pour résoudre un champ système sans toucher la base. Les deux doivent rester d'accord.
 */
export function systemFieldCode(tenantCode: string, key: string): string {
  return `fld_${tenantCode}_sys_${key}`;
}
