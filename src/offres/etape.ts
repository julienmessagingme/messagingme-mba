import type { FastifyReply, FastifyRequest } from 'fastify';
import { scopeTenant } from '../http/scope';
import type { Fonction } from './offres';
import type { SourceOffres } from './offre.pg';
import { STATUT_REFUS_OFFRE, corpsRefusFonction } from './refus';

/**
 * L'ÉTAPE D'OFFRE (lot 6, spec § 4) : posée au montage, juste après `etapeEspace`, sur chaque route `:tenantId` d'un
 * module dont l'entrée du registre déclare une fonction (`src/server.ts`). Le module ne la voit pas et ne peut pas
 * l'oublier, comme l'isolation entre espaces.
 *
 * Elle relit l'espace par `scopeTenant` et non par `espaceVerifie` : si l'étape d'espace a déjà refusé, elle n'a rien à
 * faire, et ne doit surtout pas lever une 500 par-dessus le 403.
 */
export function etapeOffre(fonction: Fonction, offres: SourceOffres) {
  return async function etapeOffreDuModule(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (reply.sent) return;
    const tenant = scopeTenant(req);
    if (tenant === null) return;
    const { droits } = await offres.offreDe(tenant);
    if (!droits.fonctions.has(fonction)) await reply.code(STATUT_REFUS_OFFRE).send(corpsRefusFonction(fonction));
  };
}

/** Ce que l'offre garde sur une route d'un module : la fonction exigée, ou `null` (route ouverte à toutes les offres). */
export type FonctionDeRoute = (route: { methodes: readonly string[]; chemin: string }) => Fonction | null;

/** Toutes les routes du module exigent la fonction. */
export const toutes = (f: Fonction): FonctionDeRoute => () => f;

const estLecture = (methodes: readonly string[]): boolean => methodes.every((m) => m === 'GET' || m === 'HEAD');

/** Seules les écritures exigent la fonction : la lecture reste ouverte (l'écran du widget lit la liste des scénarios). */
export const ecritures = (f: Fonction): FonctionDeRoute => (r) => (estLecture(r.methodes) ? null : f);

/**
 * LE MODULE DES STATISTIQUES (décision de Julien du 2026-10-07 : Pro le quantitatif, Entreprise la Synthèse, l'analyse
 * des conversations et « Mes tableaux »). Il sert le Performance Lab ET des écrans de tous les jours, d'où un partage
 * route par route, d'après l'ÉCRAN qui la lit :
 *  - ouvert à toutes les offres : ce que lisent l'accueil (les volumes, la vue d'ensemble, les modèles, la courbe des
 *    coûts), la page Campagnes (le coût de chaque campagne) et le journal des erreurs du centre de Sécurité. 🔴 Une route
 *    lue AUSSI par un écran payant (`/stats` nourrit « Messages & contacts ») reste ouverte : c'est la console qui grise
 *    l'écran, et fermer la route casserait l'accueil d'une Base ;
 *  - Entreprise (`performance_lab`) : l'analyse des conversations (`/stats/conversations...`) et les compteurs de
 *    « Mes tableaux » (`/stats/workflow/...`) ; les tableaux eux-mêmes sont un autre module (`workflowReports`) ;
 *  - Pro (`statistiques`) : le reste, le quantitatif (entonnoir, page Performance, coûts détaillés).
 * La table complète, route par route avec son écran, est tenue par `tests/offres-fonctions.test.ts`.
 */
const STATISTIQUES_OUVERTES: ReadonlySet<string> = new Set([
  '/accueil/volumes', '/stats', '/stats/templates', '/stats/cost', '/stats/cost/campaigns',
]);

export const fonctionDesStatistiques: FonctionDeRoute = (r) => {
  const chemin = r.chemin.replace(/^\/tenants\/:tenantId/, '');
  if (STATISTIQUES_OUVERTES.has(chemin) || chemin === '/stats/errors' || chemin.startsWith('/stats/errors/')) return null;
  if (chemin === '/stats/conversations' || chemin.startsWith('/stats/conversations/') || chemin.startsWith('/stats/workflow/')) {
    return 'performance_lab';
  }
  return 'statistiques';
};
