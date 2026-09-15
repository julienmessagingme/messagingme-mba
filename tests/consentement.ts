/**
 * LE CONSENTEMENT, EN DEUX ADAPTATEURS NOMMÉS (lot 3 du plan 2026-09-14).
 *
 * 🔴 POURQUOI ILS EXISTENT. `estDesabonne` était une dépendance OPTIONNELLE dans les quatre interfaces qui
 * la consomment, « pour les câblages de test ». Absente, la garde ne tournait pas : un câblage qui l'oubliait
 * compilait, se déployait, et écrivait au contact qui avait répondu STOP. C'est arrivé deux fois en
 * 48 heures, les 13 et 14 septembre 2026. Elle est requise depuis ; les tests qui s'en moquent passent
 * `jamaisDesabonne`, ce qui DIT leur hypothèse au lieu de la laisser deviner.
 *
 * ⚠️ `jamaisDesabonne` REPRODUIT EXACTEMENT le comportement d'avant pour une fixture qui omettait la
 * dépendance : la garde ne bloquait rien. Le remplacer par lui ne change donc aucun verdict de test, et c'est
 * la raison pour laquelle ce lot ne modifie aucune assertion existante.
 */
export const jamaisDesabonne = async (): Promise<boolean> => false;

/**
 * Le contact a dit STOP. C'est CELUI-CI qui a une valeur de preuve : un test qui ne se sert que de
 * `jamaisDesabonne` vérifie qu'on n'a pas cassé le cas nominal, jamais que la garde REFUSE vraiment.
 */
export const toujoursDesabonne = async (): Promise<boolean> => true;
