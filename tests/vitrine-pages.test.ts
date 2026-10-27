import { describe, it, expect } from 'vitest';
import {
  DROITS, ESSAI_PRO_JOURS, FONCTIONS, PRIX_BUSINESS_HT_CENTIMES, PRIX_PRO_HT_CENTIMES, PRIX_SIEGE_BUSINESS_HT_CENTIMES,
  PRIX_SIEGE_HT_CENTIMES, type Fonction, type Offre,
} from '../src/offres/offres';
import { PRIX_NUMERO_HT_CENTIMES } from '../src/stripe/abonnement';
import { schema } from '../src/config';
import { JUMELLES } from '../scripts/vitrine/anglais';
import { lire, parAttribut, texte } from './vitrine-lecture';

/**
 * LA PAGE DES TARIFS DIT LA GRILLE DU CODE (offres v2, livraison 8). La vitrine est du HTML statique publié sans build :
 * rien ne la relie à `src/offres/offres.ts`, sauf ce test. Chaque chiffre marqué `data-offre` vaut ce que dit le code,
 * chaque fonction marquée `data-fonction` est celle que l'offre AJOUTE à la précédente (toutes y sont), la connexion SSO
 * est promise en Entreprise, et aucune limite invisible (clés, appels, quotas du jour, suppressions) n'y paraît.
 */

const PAGES = { fr: 'tarifs/index.html', en: 'en/pricing/index.html' } as const;

const ATTENDU: Record<string, number> = {
  'base.envois-modeles-mois': DROITS.base.limites.envoisModelesMois ?? NaN,
  'base.contacts': DROITS.base.limites.contacts ?? NaN,
  'base.utilisateurs': DROITS.base.limites.utilisateurs ?? NaN,
  'base.adresses-webhook': DROITS.base.limites.adressesWebhook ?? NaN,
  'base.conservation-jours': DROITS.base.limites.conservationJours,
  // « 3,50 » et « 3.50 » se lisent 350 : les centimes, comme la constante.
  'numero.prix-mois': PRIX_NUMERO_HT_CENTIMES,
  'pro.prix-mois': PRIX_PRO_HT_CENTIMES.mois / 100,
  'pro.prix-an': PRIX_PRO_HT_CENTIMES.an / 100,
  'pro.contacts': DROITS.pro.limites.contacts ?? NaN,
  'pro.utilisateurs': DROITS.pro.limites.utilisateurs ?? NaN,
  'pro.adresses-webhook': DROITS.pro.limites.adressesWebhook ?? NaN,
  'pro.conservation-jours': DROITS.pro.limites.conservationJours,
  // L'essai (livraison 6) et le prix d'un utilisateur en plus (livraison 7).
  'pro.essai-jours': ESSAI_PRO_JOURS,
  'pro.siege-mois': PRIX_SIEGE_HT_CENTIMES.mois / 100,
  // Pas la commission sur le crédit IA : la page ne la dit pas (décision de Julien du 2026-10-19).
  // Le crédit IA offert au premier numéro, en euros : le défaut du code (une surcharge de .env.prod ne se lit pas ici).
  'credit.offert-euros': schema.shape.CREDIT_OFFERT_MICRO_EUR.parse(undefined) / 1_000_000,
  // Le Business (spec Business) : posé à la main, jamais payé en ligne ; ses chiffres viennent du code comme les autres.
  'business.prix-mois': PRIX_BUSINESS_HT_CENTIMES.mois / 100,
  'business.contacts': DROITS.business.limites.contacts ?? NaN,
  'business.utilisateurs': DROITS.business.limites.utilisateurs ?? NaN,
  'business.siege-mois': PRIX_SIEGE_BUSINESS_HT_CENTIMES.mois / 100,
  'business.adresses-webhook': DROITS.business.limites.adressesWebhook ?? NaN,
  'business.conservation-jours': DROITS.business.limites.conservationJours,
  'business.credit-offert-euros': schema.shape.CREDIT_OFFERT_BUSINESS_MICRO_EUR.parse(undefined) / 1_000_000,
};

/**
 * Ce que la page dit en MOTS d'une valeur du code : « illimités » tant que le code ne pose aucune limite, « inclus » tant
 * que le numéro est inclus. Une limite posée demain rend la page fausse, et ce test rouge.
 */
const ATTENDU_TEXTE: Record<string, RegExp> = {
  'pro.envois-modeles-mois': DROITS.pro.limites.envoisModelesMois === null ? /illimités|unlimited/i : /(?!)/,
  'pro.automations': DROITS.pro.limites.automations === null ? /illimitées|unlimited/i : /(?!)/,
  'pro.numero-inclus': DROITS.pro.limites.numeroInclus ? /inclus|included/i : /(?!)/,
  'business.envois-modeles-mois': DROITS.business.limites.envoisModelesMois === null ? /illimités|unlimited/i : /(?!)/,
  'business.automations': DROITS.business.limites.automations === null ? /illimitées|unlimited/i : /(?!)/,
  'business.numero-inclus': DROITS.business.limites.numeroInclus ? /inclus|included/i : /(?!)/,
};

/** Ce qu'une offre ajoute à la précédente, dans l'ordre de la grille. */
const ajoutees = (offre: Offre, precedente: Offre): Fonction[] =>
  FONCTIONS.filter((f) => DROITS[offre].fonctions.has(f) && !DROITS[precedente].fonctions.has(f));

for (const [langue, page] of Object.entries(PAGES)) {
  describe(`la page des tarifs (${langue})`, () => {
    const html = lire(page);

    it('🔴 chaque chiffre marqué vaut ce que dit le code, et tous y sont', () => {
      const marques = parAttribut(html, 'data-offre');
      for (const { valeur, contenu } of marques) {
        if (valeur in ATTENDU_TEXTE) { expect(texte(contenu), valeur).toMatch(ATTENDU_TEXTE[valeur]!); continue; }
        expect(Object.keys(ATTENDU), `clé inconnue ${valeur}`).toContain(valeur);
        expect(Number(texte(contenu).replace(/\D/g, '')), valeur).toBe(ATTENDU[valeur]);
      }
      expect(new Set(marques.map((m) => m.valeur))).toEqual(new Set([...Object.keys(ATTENDU), ...Object.keys(ATTENDU_TEXTE)]));
    });

    it('🔴 les fonctions de chaque offre sont celles qu’elle AJOUTE dans le code, toutes, et rien d’autre', () => {
      const marques = parAttribut(html, 'data-fonction').map((m) => m.valeur);
      const de = (offre: string) => marques.filter((m) => m.startsWith(`${offre}:`)).map((m) => m.slice(offre.length + 1)).sort();
      expect(de('pro')).toEqual(ajoutees('pro', 'base').sort());
      expect(de('business')).toEqual(ajoutees('business', 'pro').sort());
      expect(de('entreprise')).toEqual(ajoutees('entreprise', 'business').sort());
      expect(marques.every((m) => /^(pro|business|entreprise):/.test(m))).toBe(true);
    });

    it('🔴 aucun « bientôt » sur la page : les fonctions du Business sont dites incluses (décision de Julien, 2026-10-27)', () => {
      expect(html.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/bientôt|coming soon|data-bientot/i);
    });

    it('🔴 spec Business : quatre cartes de même poids, aucune mise en avant', () => {
      expect(html.match(/<li class="tarif[ "]/g)).toHaveLength(4);
      expect(html).not.toContain('tarif-mis-en-avant');
    });

    it('🔴 spec Business : les données structurées portent le Business à 349 € par mois, hors taxe', () => {
      const ld = html.slice(html.indexOf('application/ld+json'), html.indexOf('</script>', html.indexOf('application/ld+json')));
      const bloc = ld.slice(ld.indexOf('"name": "Business"'));
      expect(bloc).toContain(`"price": "${PRIX_BUSINESS_HT_CENTIMES.mois / 100}"`);
      expect(bloc.slice(0, bloc.indexOf('}', bloc.indexOf('priceSpecification')))).toContain('"valueAddedTaxIncluded": false');
    });

    it('la connexion SSO est promise, dans la carte de l’Entreprise (spec offres v2)', () => {
      const entreprise = html.slice(html.indexOf('data-fonction="entreprise:'));
      expect(entreprise).toMatch(/<li data-promesse="sso">[^<]*SSO[^<]*<\/li>/);
      expect(html.slice(0, html.indexOf('data-fonction="entreprise:'))).not.toContain('SSO');
    });

    it('la commission sur le crédit IA n’y paraît pas (décision de Julien du 2026-10-19)', () => {
      expect(html.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/commission/i);
    });

    it('🔴 aucune limite invisible : ni clés d’API comptées, ni appels, ni quotas du jour, ni suppressions', () => {
      // Tout ce qui se lit, la description, les cartes de partage et le JSON-LD compris ; les commentaires HTML mis à part.
      const lu = html.replace(/<!--[\s\S]*?-->/g, '');
      expect(lu).not.toMatch(/\d[\d\s,.]*\s*(clés|keys|API keys)\b/i);
      expect(lu).not.toMatch(/par minute|par heure|par jour|quotidien|per minute|per hour|per day|daily|\/\s*min\b|suppressions? de contacts|contact deletions?/i);
    });

    it('la page est indexable, avec son adresse canonique', () => {
      expect(html).not.toMatch(/<meta name="robots" content="[^"]*noindex/);
      const adresse = langue === 'fr' ? '/tarifs/' : '/en/pricing/';
      expect(html).toContain(`<link rel="canonical" href="https://app.messagingme.fr${adresse}">`);
    });
  });
}

describe('l’adresse des tarifs', () => {
  it('🔴 /tarifs/ en français, /en/pricing/ en anglais, et l’ancienne /pricing/ redirigée pour toujours', () => {
    expect(JUMELLES['/tarifs/']).toBe('/en/pricing/');
    expect(Object.keys(JUMELLES)).not.toContain('/pricing/');
    const vercel = JSON.parse(lire('vercel.json')) as { redirects: Array<{ source: string; destination: string; permanent?: boolean }> };
    expect(vercel.redirects).toContainEqual({ source: '/pricing/', destination: '/tarifs/', permanent: true });
  });
});
