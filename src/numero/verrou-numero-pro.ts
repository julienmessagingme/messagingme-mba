/**
 * 🔴 LE VERROU D'ESPACE DU NUMÉRO ET DU PRO (lot 6, livraison B2b, J2 de la relecture de B1). La transaction de libération
 * (`PgLiberationStore.liberer`) relit le Pro avant de résilier le numéro chez DIDWW, geste irréversible ; l'enregistrement
 * d'un Pro (`PgAbonnementsOffreStore.enregistrer`) écrit ce Pro. Sans verrou commun, un Pro écrit PENDANT la libération
 * (relu absent, puis DIDWW appelé) laissait partir le numéro qu'il venait de payer. Les deux prennent ce verrou, par
 * espace, en tête de leur transaction : l'une attend l'autre, et la seconde voit ce que la première a écrit.
 *
 * Un verrou d'avis de TRANSACTION : relâché au `commit` ou au `rollback`, jamais oublié par une copie qui meurt.
 */
export const VERROU_NUMERO_PRO_SQL = `select pg_advisory_xact_lock(hashtext('numero-pro:' || $1::text))`;
