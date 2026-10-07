import type { PreHandler } from '../src/auth/middleware';
import type { Gardes } from '../src/server';
import { PlafondPartage } from '../src/auth/plafond-partage';
import { CompteurDebitMemoire } from '../src/db/debit.memoire';
import { DROITS } from '../src/offres/offres';
import type { SourceOffres } from '../src/offres/offre.pg';

/**
 * LA GARDE QUI LAISSE PASSER, ET ELLE A UN NOM (lot 2 du plan 2026-09-14).
 *
 * 🔴 CE FICHIER EST DANS `tests/`, ET C'EST LE POINT. Une garde qui n'arrête personne n'a rien à faire dans
 * `src/` : elle y serait importable par le câblage de production, et il suffirait d'une ligne pour ouvrir un
 * espace entier sans que rien ne le signale. Ici, la frontière est mécanique.
 *
 * 🔴 POURQUOI UN ADAPTATEUR NOMMÉ PLUTÔT QU'UN PARAMÈTRE OPTIONNEL. C'est tout le lot 2. Le besoin de monter
 * un module sans authentification est RÉEL, mais il appartient aux tests ; le satisfaire par un `undefined`
 * que la production pouvait atteindre revenait à payer en sûreté un confort d'écriture. Un test qui écrit
 * `gardeOuverte` DÉCLARE son hypothèse ; un test qui omettait l'argument la cachait, et le lecteur ne pouvait
 * pas distinguer « ce test se moque de l'authentification » de « ce test a oublié la garde ».
 */
export const gardeOuverte: PreHandler = async () => {};

/** Le plafond des opérations coûteuses, COUPÉ (`max` à 0) : il laisse tout passer, et le dit par son nom. */
export const plafondCoupe = new PlafondPartage(new CompteurDebitMemoire(), {
  nom: 'couteux', max: 0, dureeMs: 60_000, siLaBaseEchoue: 'laisser-passer',
});

/**
 * L'offre de chaque espace, TOUT OUVERTE : chaque espace est en Entreprise (lot 6). L'hypothèse des tests qui montent un
 * module sans parler d'offre ; un test de l'offre construit sa propre source.
 */
export const offresToutOuvert: SourceOffres = {
  offreDe: async () => ({ offre: 'entreprise', droits: DROITS.entreprise, retourEnBaseLe: null }),
};

/** Les quatre gardes d'un `buildServer`, toutes ouvertes, et son plafond coûteux coupé. Pour les tests qui montent un
 *  module à la main. */
export const gardesOuvertes: Gardes = {
  auth: gardeOuverte,
  admin: gardeOuverte,
  encadrement: gardeOuverte,
  adminOuLien: gardeOuverte,
  ops: gardeOuverte,
  plafondCouteux: plafondCoupe,
  offres: offresToutOuvert,
};
