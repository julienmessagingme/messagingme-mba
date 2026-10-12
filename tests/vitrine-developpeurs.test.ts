import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DROITS, PRIX_PRO_HT_CENTIMES } from '../src/offres/offres';
import { CODE_RE } from '../src/http/widget-public';
import { PRIX_NUMERO_HT_CENTIMES } from '../src/stripe/abonnement';
import { adresseDuScript, baliseDuScript } from '../src/widgets/adresses';
import { API_PUBLIQUE, commandeMcp } from '../web/lib/demarrer';
import { EXEMPLES_SDK, VERSION_SDK } from '../web/lib/exemples-code';
import { CATALOGUE_MCP } from '../web/lib/partage/catalogue-mcp';

/**
 * LA SECTION DÉVELOPPEURS DE LA VITRINE DIT CE QUE LE PRODUIT FAIT (lot 18). La vitrine est du HTML statique, publiée par
 * Vercel sans build : rien ne la relie au code, sauf ce test. Il tient les chiffres de la Free et le prix du Pro, la
 * commande qui branche Claude Code, les outils que montre le terminal, la balise de la bulle et l'exemple du SDK ; puis
 * les liens entre les pages, et ce que lisent les moteurs (plan du site, `llms.txt`, langues).
 *
 * ⚠️ C'est parce qu'il lit `site/` que `ci.yml` ne l'ignore plus : un push de la vitrine seule lance la CI.
 */

const SITE = resolve(__dirname, '..', 'site');
const FR = 'developpeurs/index.html';
const EN = 'en/developers/index.html';
const ADRESSE_FR = 'https://app.messagingme.fr/developpeurs/';
const ADRESSE_EN = 'https://app.messagingme.fr/en/developers/';

const lire = (chemin: string): string => readFileSync(join(SITE, chemin), 'utf8');

function pagesHtml(dossier = SITE, prefixe = ''): string[] {
  return readdirSync(dossier).flatMap((nom) => {
    const complet = join(dossier, nom);
    const relatif = prefixe ? `${prefixe}/${nom}` : nom;
    if (statSync(complet).isDirectory()) return pagesHtml(complet, relatif);
    return nom.endsWith('.html') ? [relatif] : [];
  });
}

/** Le texte tel que le visiteur le lit : balises retirées, entités décodées. */
function texte(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Le contenu de chaque élément qui porte l'attribut `attr`, par valeur d'attribut. */
function parAttribut(html: string, attr: string): Array<{ valeur: string; contenu: string }> {
  const re = new RegExp(`<(\\w+)[^>]*\\s${attr}="([^"]+)"[^>]*>([\\s\\S]*?)</\\1>`, 'g');
  return [...html.matchAll(re)].map((m) => ({ valeur: m[2]!, contenu: m[3]! }));
}

const PAGES = { fr: lire(FR), en: lire(EN) };

describe('les chiffres de l’offre sont ceux du code', () => {
  const ATTENDU: Record<string, number> = {
    'base.envois-modeles-mois': DROITS.base.limites.envoisModelesMois ?? NaN,
    'base.contacts': DROITS.base.limites.contacts ?? NaN,
    'base.utilisateurs': DROITS.base.limites.utilisateurs ?? NaN,
    'pro.prix-mois': PRIX_PRO_HT_CENTIMES.mois / 100,
    'pro.utilisateurs': DROITS.pro.limites.utilisateurs ?? NaN,
    // « 3,50 » et « 3.50 » se lisent 350 : les centimes, comme la constante que la route compare au prix de Stripe.
    'numero.prix-mois': PRIX_NUMERO_HT_CENTIMES,
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

describe('la commande qui branche Claude Code est celle du tunnel', () => {
  it('toute commande `claude mcp add` publiée sur la vitrine est `commandeMcp` sur l’API publique', () => {
    const attendue = commandeMcp(API_PUBLIQUE);
    let vues = 0;
    for (const page of pagesHtml()) {
      for (const m of texte(lire(page)).matchAll(/claude mcp add[^\n]*/g)) {
        expect(m[0].trim(), page).toBe(attendue);
        vues++;
      }
    }
    // Les deux pages et le bloc de l'accueil : une commande disparue ne doit pas rendre ce test vide.
    expect(vues).toBeGreaterThanOrEqual(3);
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
      expect(rang('create_agent')).toBe(0);
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
  it('le plan du site et `llms.txt` citent les deux pages', () => {
    for (const fichier of ['sitemap.xml', 'llms.txt']) {
      expect(lire(fichier), fichier).toContain(ADRESSE_FR);
      expect(lire(fichier), fichier).toContain(ADRESSE_EN);
    }
  });
});
