import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DROITS, PRIX_PRO_HT_CENTIMES } from '../src/offres/offres';
import { CODE_RE } from '../src/http/widget-public';
import { PRIX_NUMERO_HT_CENTIMES } from '../src/stripe/abonnement';
import { schema } from '../src/config';
import { adresseDuScript, baliseDuScript } from '../src/widgets/adresses';
import { API_PUBLIQUE, COMMANDE_DEMARRAGE, COMMANDES_PLUGIN, SERVEUR_PLUGIN_MCP } from '../web/lib/demarrer';
import { MARQUE_DEBUT } from '../scripts/plugin/generer';
import { EXEMPLES_SDK, VERSION_SDK } from '../web/lib/exemples-code';
import { CATALOGUE_MCP } from '../web/lib/partage/catalogue-mcp';
import { SITE, lire, pagesHtml, parAttribut, texte } from './vitrine-lecture';

/**
 * LA SECTION DÉVELOPPEURS DE LA VITRINE DIT CE QUE LE PRODUIT FAIT (lot 18). La vitrine est du HTML statique, publiée par
 * Vercel sans build : rien ne la relie au code, sauf ce test. Il tient les chiffres de la Free et le prix du Pro, la
 * commande qui branche Claude Code, les outils que montre le terminal, la balise de la bulle et l'exemple du SDK ; puis
 * les liens entre les pages, et ce que lisent les moteurs (plan du site, `llms.txt`, langues).
 *
 * ⚠️ C'est parce qu'il lit `site/` que `ci.yml` ne l'ignore plus : un push de la vitrine seule lance la CI.
 */

const FR = 'developpeurs/index.html';
const EN = 'en/developers/index.html';
const ADRESSE_FR = 'https://app.messagingme.fr/developpeurs/';
const ADRESSE_EN = 'https://app.messagingme.fr/en/developers/';

const PAGES = { fr: lire(FR), en: lire(EN) };

describe('les chiffres de l’offre sont ceux du code', () => {
  const ATTENDU: Record<string, number> = {
    'base.envois-modeles-mois': DROITS.base.limites.envoisModelesMois ?? NaN,
    'base.contacts': DROITS.base.limites.contacts ?? NaN,
    'base.utilisateurs': DROITS.base.limites.utilisateurs ?? NaN,
    'pro.prix-mois': PRIX_PRO_HT_CENTIMES.mois / 100,
    'pro.utilisateurs': DROITS.pro.limites.utilisateurs ?? NaN,
    // Le Pro resserré (spec offres v2, livraison 5) : ses contacts ont une limite, la page la dit.
    'pro.contacts': DROITS.pro.limites.contacts ?? NaN,
    // « 3,50 » et « 3.50 » se lisent 350 : les centimes, comme la constante que la route compare au prix de Stripe.
    'numero.prix-mois': PRIX_NUMERO_HT_CENTIMES,
    // Le crédit IA offert au premier numéro, en euros : le défaut du code.
    'credit.offert-euros': schema.shape.CREDIT_OFFERT_MICRO_EUR.parse(undefined) / 1_000_000,
  };

  for (const [langue, html] of Object.entries(PAGES)) {
    it(`page ${langue} : chaque chiffre marqué vaut ce que dit le code, et tous y sont`, () => {
      const marques = parAttribut(html, 'data-offre');
      for (const { valeur, contenu } of marques) {
        expect(Object.keys(ATTENDU), `clé inconnue ${valeur}`).toContain(valeur);
        expect(Number(texte(contenu).replace(/\D/g, '')), `${valeur} sur la page ${langue}`).toBe(ATTENDU[valeur]);
      }
      expect(new Set(marques.map((m) => m.valeur))).toEqual(new Set(Object.keys(ATTENDU)));
    });
  }
});

describe('les commandes qui branchent Claude Code sont celles du plugin (lot 10, B)', () => {
  for (const [langue, html] of Object.entries(PAGES)) {
    it(`page ${langue} : les deux commandes, puis le lancement, une par bloc (collées ensemble, Claude Code n’en lancerait qu’une)`, () => {
      const blocs = Object.fromEntries(parAttribut(html, 'data-commande').map((b) => [b.valeur, texte(b.contenu).trim()]));
      expect(blocs).toEqual({ 'plugin-1': COMMANDES_PLUGIN[0], 'plugin-2': COMMANDES_PLUGIN[1], demarrage: COMMANDE_DEMARRAGE });
      expect(texte(parAttribut(html, 'data-commande-terminal')[0]?.contenu ?? '')).toBe(COMMANDE_DEMARRAGE);
      // Le nom que /mcp affiche pour le serveur du plugin.
      expect(parAttribut(html, 'data-serveur').map((b) => texte(b.contenu))).toEqual([SERVEUR_PLUGIN_MCP]);
    });
  }

  it('toute ligne `/plugin` de la vitrine est une commande du plugin, et plus aucun bloc de code ne montre `claude mcp add`', () => {
    let vues = 0;
    for (const page of pagesHtml()) {
      const html = lire(page);
      for (const m of texte(html).matchAll(/^\s*(\/plugin [^\n]*?)\s*$/gm)) {
        expect([...COMMANDES_PLUGIN] as string[], page).toContain(m[1]!);
        vues++;
      }
      for (const bloc of html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)) expect(texte(bloc[1]!), page).not.toContain('claude mcp add');
    }
    // Deux par page développeurs, deux à l'accueil : une commande disparue ne doit pas rendre ce test vide.
    expect(vues).toBeGreaterThanOrEqual(6);
  });

  it('aucun lien vers `/mcp` sur le domaine de la console, où il rend 404', () => {
    for (const page of pagesHtml()) expect(lire(page), page).not.toMatch(/console\.messagingme\.app\/mcp/);
  });
});

describe('le terminal montre de vrais outils et la vraie balise', () => {
  for (const [langue, html] of Object.entries(PAGES)) {
    it(`page ${langue} : chaque outil existe, sous son nom, dans un ordre que le produit accepte`, () => {
      const marques = parAttribut(html, 'data-outil');
      for (const { valeur, contenu } of marques) {
        expect(Object.keys(CATALOGUE_MCP), valeur).toContain(valeur);
        expect(texte(contenu), `le nom affiché de ${valeur}`).toBe(valeur);
      }
      const outils = marques.map((o) => o.valeur);
      const rang = (o: string) => {
        expect(outils, `${o} manque à la séance`).toContain(o);
        return outils.indexOf(o);
      };
      // La mise en service du plugin lit d'abord où en est l'espace.
      expect(rang('get_setup_state')).toBe(0);
      expect(rang('create_agent')).toBeGreaterThan(rang('get_setup_state'));
      // L'import du site range ses fiches dans l'agent : après sa création.
      expect(rang('import_site')).toBeGreaterThan(rang('create_agent'));
      // L'activation refuse un agent sans fiche complète ni outil actif (`activate_agent`, src/mcp/outils-agent.ts).
      expect(rang('activate_agent')).toBeGreaterThan(Math.max(rang('import_site'), rang('update_agent'), rang('set_agent_tools')));
      // Seul un agent actif répond.
      expect(rang('set_default_responder')).toBeGreaterThan(rang('activate_agent'));
      expect(outils.at(-1)).toBe('create_widget');
    });

    it(`page ${langue} : la balise de la bulle a la forme que rend le produit`, () => {
      const [balise] = parAttribut(html, 'data-balise');
      expect(balise).toBeDefined();
      const vue = texte(balise!.contenu).trim();
      const code = /\/widget\/([^.]+)\.js/.exec(vue)?.[1] ?? '';
      // Le format d'un code de widget, celui que la route publique accepte.
      expect(code).toMatch(CODE_RE);
      expect(vue).toBe(baliseDuScript(adresseDuScript(API_PUBLIQUE, code)));
    });

    it(`page ${langue} : l’exemple de code est celui du SDK, compilé par la CI`, () => {
      const [exemple] = parAttribut(html, 'data-exemple');
      expect(exemple?.valeur).toBe('sdk.premierAppel');
      expect(texte(exemple!.contenu).trim()).toBe(EXEMPLES_SDK.premierAppel.code);
      // Le paquet n'est pas sur npm : la page dit comment l'installer, à la version que la doc fait installer.
      const [installation] = parAttribut(html, 'data-installation');
      expect(texte(installation?.contenu ?? '').trim()).toBe(`npm install github:julienmessagingme/messagingme-sdk#v${VERSION_SDK}`);
    });

    it(`page ${langue} : l’adresse donnée aux autres clients MCP est celle de l’API publique`, () => {
      const autres = /<p class="dev-autres">[\s\S]*?<code>([^<]+)<\/code>/.exec(html)?.[1];
      expect(autres).toBe(`${API_PUBLIQUE}/mcp`);
    });
  }
});

describe('les liens entre les pages', () => {
  it('plus aucun lien vers l’ancien bloc `/#developpeurs`', () => {
    for (const page of pagesHtml()) expect(lire(page), page).not.toContain('/#developpeurs');
  });

  it('chaque page française qui porte le menu mène à `/developpeurs/`, sur ordinateur et sur téléphone', () => {
    const avecMenu = pagesHtml().filter((p) => lire(p).includes('aria-label="Principale"'));
    expect(avecMenu.length).toBeGreaterThanOrEqual(12);
    for (const page of avecMenu) {
      const html = lire(page);
      expect(html.match(/href="\/developpeurs\/"/g)?.length ?? 0, page).toBeGreaterThanOrEqual(2);
    }
  });

  for (const page of ['index.html', FR, EN]) {
    it(`${page} : chaque lien interne mène à une page qui existe`, () => {
      for (const m of lire(page).matchAll(/href="(\/[^"#?]*)/g)) {
        const chemin = m[1]!;
        const fichier = chemin.endsWith('/') ? join(SITE, chemin, 'index.html') : join(SITE, chemin);
        expect(existsSync(fichier), `${page} -> ${chemin}`).toBe(true);
      }
    });
  }

  it('la page anglaise ouvre la console en anglais', () => {
    const liens = [...PAGES.en.matchAll(/href="(https:\/\/console\.messagingme\.app[^"]*)"/g)].map((m) => m[1]!);
    expect(liens.length).toBeGreaterThanOrEqual(2);
    for (const l of liens) expect(new URL(l.replace(/&amp;/g, '&')).searchParams.get('lang'), l).toBe('en');
  });

  it('les deux pages se déclarent l’une l’autre, le français par défaut', () => {
    for (const html of Object.values(PAGES)) {
      expect(html).toContain(`<link rel="alternate" hreflang="fr" href="${ADRESSE_FR}">`);
      expect(html).toContain(`<link rel="alternate" hreflang="en" href="${ADRESSE_EN}">`);
      expect(html).toContain(`<link rel="alternate" hreflang="x-default" href="${ADRESSE_FR}">`);
    }
    expect(PAGES.fr).toContain(`<link rel="canonical" href="${ADRESSE_FR}">`);
    expect(PAGES.en).toContain(`<link rel="canonical" href="${ADRESSE_EN}">`);
  });
});

describe('ce que lisent les moteurs et les modèles', () => {
  it('les deux pages portent la FAQ générée (son contenu est tenu par tests/plugin-faq.test.ts)', () => {
    for (const html of Object.values(PAGES)) expect(html).toContain(MARQUE_DEBUT);
    expect(lire('llms.txt')).toContain('https://app.messagingme.fr/developpeurs/#faq');
    expect(lire('llms.txt')).toContain('https://github.com/julienmessagingme/messagingme-plugin');
  });

  it('le plan du site et `llms.txt` citent les deux pages', () => {
    for (const fichier of ['sitemap.xml', 'llms.txt']) {
      expect(lire(fichier), fichier).toContain(ADRESSE_FR);
      expect(lire(fichier), fichier).toContain(ADRESSE_EN);
    }
  });
});

describe('le démarrage passe par le plugin, sans créer d’espace avant (Julien, 2026-10-19)', () => {
  // L'espace naît à l'autorisation : « Continuer avec Google » sur une adresse inconnue le crée, avec son admin
  // (`creerEspaceParGoogle`, tenu par tests/http-oauth.test.ts). Envoyer d'abord vers l'inscription de la console était
  // un détour, et le portefeuille Meta n'est demandé qu'au numéro, dans /messagingme:demarrer.
  for (const [langue, html] of Object.entries(PAGES)) {
    it(`page ${langue} : aucun lien vers l’inscription, les appels mènent au plugin et à son dépôt`, () => {
      expect(html).not.toContain('console.messagingme.app/signup');
      // Les étapes portent la bande claire de la page (2026-10-20)
      expect(html).toContain('<section class="f-bloc dev-etapes bande-claire" id="demarrer">');
      expect(html.split('href="#demarrer"').length - 1, 'le haut et le bas de la page').toBe(2);
      expect(html).toContain('href="https://github.com/julienmessagingme/messagingme-plugin"');
      // Sous les boutons du haut : aucun compte, un numéro fourni, un compte Meta Business seulement (Julien, 2026-10-19).
      const promesses = html.split('<ul class="dev-sans">')[1]?.split('</ul>')[0] ?? '';
      expect(promesses.split('<li>').length - 1).toBe(3);
    });
  }
  for (const page of ['tarifs/index.html', 'en/pricing/index.html']) {
    it(`${page} : la Free se démarre par le plugin`, () => {
      const html = lire(page);
      const free = html.slice(html.indexOf('<h2 class="tarif-nom">Free</h2>'), html.indexOf('<h2 class="tarif-nom">Pro</h2>'));
      expect(free.length).toBeGreaterThan(0);
      expect(free).toMatch(/href="\/(en\/developers|developpeurs)\/#demarrer"/);
      expect(free).not.toContain('signup');
    });
  }
});
