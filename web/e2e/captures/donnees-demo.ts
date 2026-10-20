import type { Locator, Page } from '@playwright/test';

/**
 * L'ESPACE DE DÉMONSTRATION DES CAPTURES DU CENTRE D'AIDE (tâche 8 du plan du centre d'aide). Une marque INVENTÉE
 * (« Votre marque », la collection d'automne, le code AUTOMNE20), des contacts inventés, des numéros de la plage
 * réservée à la fiction : aucune donnée d'un client n'apparaît jamais dans une capture. Les réponses de l'API sont
 * simulées ; la console, elle, est la vraie.
 */

export type Locale = 'fr' | 'en';

export const SESSION_DEMO = { token: 'demo', email: 'lea@votre-marque.test', role: 'admin', tenantId: 't-demo' };

/** Le Pro : la console complète, comme la voit un client qui lit l'aide (les pages disent l'offre demandée). */
const PRO = ['inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'email', 'console'];
const limitesPro = {
  utilisateurs: 3, admins: 2, contacts: 5000, envoisModelesMois: null, automations: null, suppressionsJour: null,
  adressesWebhook: 5, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 20, badge: false, numeroInclus: true,
};
export const OFFRE_PRO = {
  offre: 'pro', fonctions: PRO, limites: limitesPro,
  usage: { envoisModelesMois: 412, contacts: 248, automations: 3, membres: 2 },
  grille: {
    free: { fonctions: [], limites: { ...limitesPro, utilisateurs: 1, admins: 1, contacts: 100, envoisModelesMois: 1000, automations: 10, commissionPct: 50, badge: true, numeroInclus: false } },
    pro: { fonctions: PRO, limites: limitesPro },
    entreprise: { fonctions: [...PRO, 'analyse', 'publicites', 'chaines', 'crm', 'rcs', 'performance_lab'], limites: { ...limitesPro, utilisateurs: null, commissionPct: 10 } },
  },
  upgradeUrl: 'https://console.messagingme.app/offre',
};

/** Le modèle de la collection d'automne, avec son visuel : celui des films de la vitrine. */
export const MODELE_AUTOMNE = {
  id: 'tpl-automne', name: 'collection_automne', status: 'APPROVED', category: 'MARKETING', language: 'fr',
  body: 'Bonjour {{1}} 🍂 La collection d’automne est arrivée : -20 % avec le code AUTOMNE20.',
  headerFormat: 'IMAGE', headerMediaUrl: '/demo/automne.jpg', footer: 'Répondez STOP pour ne plus recevoir nos offres', isCarousel: false,
  buttons: [{ type: 'URL', text: 'Voir la collection', url: 'https://votre-marque.test/automne' }],
};
export const MODELE_SUIVI = {
  id: 'tpl-suivi', name: 'suivi_commande', status: 'APPROVED', category: 'UTILITY', language: 'fr',
  body: 'Bonjour {{1}}, votre commande {{2}} est en route. Livraison prévue demain.', headerFormat: null, isCarousel: false,
  buttons: [{ type: 'URL', text: 'Suivre ma commande', url: 'https://votre-marque.test/suivi' }],
};

export const TAGS_DEMO = [
  { tag: 'clientes-fideles', count: 186 }, { tag: 'newsletter', count: 412 }, { tag: 'boutique-lyon', count: 94 },
];
export const CHAMPS_DEMO = [
  { key: 'ville', label: 'Ville', type: 'text' }, { key: 'taille', label: 'Taille', type: 'text' },
];
/** Des numéros de la plage réservée à la fiction (+33 6 39 98 xx xx), jamais attribuée. */
const contact = (n: number, nom: string, prenom: string, tags: string[], ville: string, optInStatus = 'opted_in') => ({
  id: `c${n}`, phoneE164: `+336399801${String(n).padStart(2, '0')}`, bsuid: null, profileName: nom, tags, optInStatus,
  fields: { prenom, ville, email: `${prenom.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')}@exemple.test` },
  createdAt: '2026-09-14T09:30:00.000Z',
});
export const CONTACTS_DEMO = [
  contact(1, 'Léa Martin', 'Léa', ['clientes-fideles'], 'Lyon'),
  contact(2, 'Hugo Bernard', 'Hugo', ['newsletter'], 'Paris'),
  contact(3, 'Inès Petit', 'Inès', ['clientes-fideles', 'boutique-lyon'], 'Lyon'),
  contact(4, 'Lucas Moreau', 'Lucas', ['newsletter'], 'Nantes', 'opted_out'),
  contact(5, 'Chloé Garnier', 'Chloé', ['clientes-fideles'], 'Bordeaux'),
  contact(6, 'Nathan Roux', 'Nathan', ['newsletter', 'boutique-lyon'], 'Lyon'),
  contact(7, 'Camille Faure', 'Camille', ['clientes-fideles', 'newsletter'], 'Lille'),
  contact(8, 'Jules Mercier', 'Jules', [], 'Toulouse', 'unknown'),
];
/** Les réglages que lit l'Accueil, interrupteur HubSpot compris (sans lui, sa carte dit « Réglage indisponible »). */
export const REGLAGES_ACCUEIL = {
  controlHandbackSeconds: null, mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false,
  hubspotActif: false,
};
export const NUMEROS_DEMO = [{ id: 'pn-demo', displayPhoneNumber: '+33 6 39 98 01 00', verifiedName: 'Votre marque' }];
export const REGLAGES_DEMO = {
  controlHandbackSeconds: null, mbaHandoffMode: null, mbaEnabled: true, rcsEnabled: false, hubspotListsEnabled: false,
  campaignsPaused: false, autoRetryEnabled: true, timezone: 'Europe/Paris',
  // La forme du serveur (`BusinessHours`, web/lib/api/stats.ts) : clés '0' à '6', 0 = dimanche.
  businessHours: {
    0: { closed: true, open: '09:00', close: '19:00' }, 1: { closed: false, open: '09:00', close: '19:00' },
    2: { closed: false, open: '09:00', close: '19:00' }, 3: { closed: false, open: '09:00', close: '19:00' },
    4: { closed: false, open: '09:00', close: '19:00' }, 5: { closed: false, open: '09:00', close: '19:00' },
    6: { closed: false, open: '10:00', close: '18:00' },
  },
};

/**
 * Trente jours de chiffres plausibles, déterministes (une capture refaite donne la même image) : une valeur de base,
 * une ondulation, et des pics les jours de campagne.
 */
function serie(base: number, amplitude: number, pics: Record<number, number> = {}): Array<{ date: string; count: number }> {
  const depart = Date.UTC(2026, 8, 22);
  return Array.from({ length: 30 }, (_, i) => ({
    date: new Date(depart + i * 86_400_000).toISOString().slice(0, 10),
    count: pics[i] ?? Math.max(0, Math.round(base + amplitude * Math.sin(i * 1.3) + (i % 7 === 5 ? -amplitude : 0))),
  }));
}
/** Les contacts se CUMULENT (le total du mini-CRM chaque jour) : on additionne les arrivées du jour. */
function cumul(depart: number, arrivees: Array<{ date: string; count: number }>): Array<{ date: string; count: number }> {
  let total = depart;
  return arrivees.map((p) => ({ date: p.date, count: (total += p.count) }));
}
const ARRIVEES = serie(1, 1, { 9: 14, 24: 11 });
export const STATS_DEMO = {
  contacts: cumul(186, ARRIVEES),
  contactsActifs: cumul(181, ARRIVEES),
  templates: { utility: serie(18, 6), marketing: serie(0, 0, { 9: 412, 24: 186 }) },
  exchanged: serie(64, 22, { 9: 171, 10: 132, 24: 148 }),
  service: serie(41, 15),
  serviceParOrigine: { ia: 512, scenario: 236, humain: 418, indeterminee: 0 },
  serviceIaDetail: { agent: 512, mba: 0, mcp: 0 },
};

/** La langue de la console, comme la bascule FR/EN la mémorise. */
export async function langue(page: Page, locale: Locale): Promise<void> {
  await page.addInitScript((l) => window.localStorage.setItem('mba_locale', l), locale);
}

/**
 * Les réponses communes à tous les écrans : l'offre, le compte, les compteurs de la barre. Posées APRÈS les faux d'un
 * écran (Playwright essaie les routes de la dernière posée à la première) ; tout le reste continue vers eux.
 */
export async function communs(page: Page): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION_DEMO);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = new URL(route.request().url()).pathname.replace('/api/backend', '');
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/offre')) return json(OFFRE_PRO);
    if (chemin.endsWith('/me')) return json({ email: SESSION_DEMO.email, name: 'Léa Martin', role: 'admin' });
    if (chemin.endsWith('/conversations/unread-count')) return json({ count: 3 });
    if (chemin.endsWith('/abonnement-numero')) return json({ etat: 'aucun' });
    return route.fallback();
  });
  // Le visuel du modèle : celui de la vitrine (`site/rcs-automne.jpg`), servi localement, jamais une adresse externe.
  await page.route('**/demo/automne.jpg', (route) => route.fulfill({ path: '../site/rcs-automne.jpg' }));
}

/** La locale et le fuseau du navigateur, par langue : les dates s'écrivent comme chez un client. */
export const NAVIGATEUR: Readonly<Record<Locale, { locale: string; timezoneId: string }>> = {
  fr: { locale: 'fr-FR', timezoneId: 'Europe/Paris' },
  en: { locale: 'en-GB', timezoneId: 'Europe/Paris' },
};

/**
 * La capture d'une étape, dans `e2e/captures/sortie/<clé>/etape-<n>[-en].png` (le script de la racine en fait des
 * .webp). `zone` est l'élément que l'étape montre : la page défile pour le placer en haut, sous la barre.
 */
export async function capturer(
  page: Page, cle: string, numero: number, locale: Locale, zone?: Locator, ou: 'haut' | 'bas' = 'haut',
): Promise<void> {
  await page.waitForLoadState('networkidle');
  // Aucun champ en cours de saisie sur une capture : le curseur et la sélection ne disent rien au lecteur.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if (zone) {
    await zone.evaluate((e, bas) => {
      const r = e.getBoundingClientRect();
      const cible = bas ? r.bottom + window.scrollY - window.innerHeight + 60 : r.top + window.scrollY - 130;
      window.scrollTo(0, Math.max(0, cible));
    }, ou === 'bas');
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: `e2e/captures/sortie/${cle}/etape-${numero}${locale === 'en' ? '-en' : ''}.png` });
}
