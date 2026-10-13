/**
 * Les étapes du guide de connexion Salesforce, dans l'ordre où l'admin les fait. Le serveur rend chaque manque de la
 * connexion avec l'étape qui le règle ; la console en fait un lien vers l'ANCRE de cette étape sur la page tuto
 * (`web/app/tuto-salesforce`, dont `tests/web-salesforce-guide-parite.test.ts` vérifie les ancres).
 */
export const ETAPES_GUIDE = ['adresse', 'package', 'utilisateur', 'run-as', 'droits', 'org'] as const;
export type EtapeGuide = (typeof ETAPES_GUIDE)[number];
