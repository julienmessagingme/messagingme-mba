/**
 * L'OFFRE DE L'ESPACE DE DÉMONSTRATION des captures : les prix, l'essai et la grille que montrent « Choisir mon offre » et
 * la barre de la console. Ils font foi ailleurs (`src/offres/offres.ts`) : `tests/vitrine-aide.test.ts` les confronte,
 * clé par clé dans les deux sens, et un écart dit de refaire les captures (`npm run aide:captures`).
 *
 * 🔴 CE FICHIER N'IMPORTE RIEN : le test de la racine le lit, et la racine n'a pas les paquets de la console
 * (`@playwright/test` n'est installé que dans `web/`). Relecture du lot 4 : le typecheck de la CI aurait échoué.
 */
export const PRIX_DEMO = {
  pro: { moisCentimes: 4900, anCentimes: 49000 }, siege: { moisCentimes: 1500, anCentimes: 15000 }, essaiJours: 14,
};

const MO = 1024 * 1024;
/** Le Pro : la console complète, comme la voit un client qui lit l'aide (les pages disent l'offre demandée). */
const PRO = ['inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'email', 'console'];
export const LIMITES_DEMO = {
  free: {
    utilisateurs: 1, admins: 1, contacts: 100, envoisModelesMois: 1000, automations: 10, suppressionsJour: 10,
    adressesWebhook: 1, journalWebhooksJours: 3, conservationJours: 30, commissionPct: 100, badge: true, numeroInclus: false,
    stockageOctets: 0, clesApi: 2, appelsMinute: 30, appelsHeure: 500, modelesJour: 500, reponsesJour: 2000,
  },
  pro: {
    utilisateurs: 3, admins: 2, contacts: 5000, envoisModelesMois: null, automations: null, suppressionsJour: null,
    adressesWebhook: 5, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 20, badge: false, numeroInclus: true,
    stockageOctets: 100 * MO, clesApi: 10, appelsMinute: 60, appelsHeure: 1000, modelesJour: 2000, reponsesJour: 2000,
  },
  entreprise: {
    utilisateurs: null, admins: null, contacts: null, envoisModelesMois: null, automations: null, suppressionsJour: null,
    adressesWebhook: null, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 10, badge: false, numeroInclus: true,
    stockageOctets: 500 * MO, clesApi: null, appelsMinute: null, appelsHeure: null, modelesJour: null, reponsesJour: null,
  },
};

export const OFFRE_PRO = {
  offre: 'pro', fonctions: PRO, limites: LIMITES_DEMO.pro,
  usage: { envoisModelesMois: 412, contacts: 248, automations: 3, membres: 2 },
  grille: {
    free: { fonctions: [] as string[], limites: LIMITES_DEMO.free },
    pro: { fonctions: PRO, limites: LIMITES_DEMO.pro },
    entreprise: { fonctions: [...PRO, 'analyse', 'publicites', 'chaines', 'crm', 'rcs', 'performance_lab'], limites: LIMITES_DEMO.entreprise },
  },
  upgradeUrl: 'https://console.messagingme.app/offre',
};
