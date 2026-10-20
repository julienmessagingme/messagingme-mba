// scripts/vitrine/anglais.ts
// La vitrine anglaise, GÉNÉRÉE depuis la française (2026-10-16, plan docs/superpowers/plans/2026-10-16-vitrine-en-anglais.md).
//
// Chaque page anglaise est sa jumelle française passée aux dictionnaires de `anglais/` : une entrée `{ fr, en }`
// remplace un fragment ENTIER (nœud de texte, attribut lisible, chaîne du JSON-LD), du plus long au plus court ; une
// entrée `{ contexte, en }` remplace un extrait exact, tel quel. Puis la langue, les adresses internes vers leur jumelle,
// la console en `lang=en`, les films et la bulle anglais, le bloc hreflang ; l'en-tête et le pied de page ne sont pas
// traduits, `pageAvecEntete` (entete.ts) les écrit. `npm run vitrine:anglais` réécrit les pages de `GENEREES` et dit ce
// qui reste de français ; `tests/vitrine-anglais.test.ts` exige que chaque page soit égale à sa génération.
//
// 🔴 Une page française retouchée se traduit ICI : le texte neuf entre dans un dictionnaire, puis on régénère. Retoucher
// la page anglaise à la main serait défait à la génération suivante, et le test le refuse.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pageAvecEntete } from './entete';

const ORIGINE = 'https://app.messagingme.fr';
const SITE = fileURLToPath(new URL('../../site/', import.meta.url));

/** Chaque page française et sa jumelle anglaise : les liens internes d'une page anglaise y passent. */
export const JUMELLES: Readonly<Record<string, string>> = {
  '/': '/en/',
  '/fonctionnalites/whatsapp-et-rcs/': '/en/features/whatsapp-and-rcs/',
  '/fonctionnalites/campagnes-et-scenarios/': '/en/features/campaigns-and-scenarios/',
  '/fonctionnalites/chaines-whatsapp/': '/en/features/whatsapp-channels/',
  '/fonctionnalites/conversations-en-actions/': '/en/features/conversations-into-actions/',
  '/fonctionnalites/publicites-click-to-whatsapp/': '/en/features/click-to-whatsapp-ads/',
  '/fonctionnalites/pilotage-des-couts/': '/en/features/cost-control/',
  '/industries/': '/en/industries/',
  '/tarifs/': '/en/pricing/',
  '/developpeurs/': '/en/developers/',
  '/developpeurs/compte-meta-business/': '/en/developers/meta-business-account/',
  '/solutions/saas-et-app-builders/': '/en/solutions/saas-and-app-builders/',
  '/solutions/transport-et-mobilites/': '/en/solutions/transport-and-mobility/',
  '/cas-d-usage/rappels-rendez-vous/': '/en/use-cases/appointment-reminders/',
  '/cas-d-usage/notifications-de-commande/': '/en/use-cases/order-notifications/',
  '/cas-d-usage/prise-de-rendez-vous/': '/en/use-cases/appointment-booking/',
  '/cas-d-usage/accueil-activation-saas/': '/en/use-cases/saas-onboarding-activation/',
  '/cas-d-usage/relance-paiement-echoue/': '/en/use-cases/failed-payment-recovery/',
  '/cas-d-usage/bulle-whatsapp-site-lovable/': '/en/use-cases/whatsapp-bubble-lovable-site/',
  '/contact/': '/en/contact/',
  '/contact/merci/': '/en/contact/thanks/',
};

/**
 * Les pages françaises que l'outil traduit. Les pages développeurs n'y sont pas : la jumelle de `/developpeurs/` est
 * écrite à la main (lot 18), et le guide Meta reçoit ses étapes dans les deux langues de `etapes-meta.ts`.
 */
const ECRITES_A_LA_MAIN = new Set(['/developpeurs/', '/developpeurs/compte-meta-business/']);
/** Les pages de cas et leur carrefour ont leurs deux langues dans `scripts/vitrine/cas-textes.ts` (npm run vitrine:cas). */
const hors = (p: string): boolean => ECRITES_A_LA_MAIN.has(p) || p.startsWith('/cas-d-usage/') || p.startsWith('/solutions/');
export const GENEREES: readonly string[] = Object.keys(JUMELLES).filter((p) => !hors(p));

/** Les noms qu'une page anglaise garde exprès (un prénom, un client) : le détecteur de français ne les lit pas. */
export const FRANCAIS_VOULU: readonly string[] = ['Léa', 'Mieux Assuré'];

export type Entree = { fr: string; en: string } | { contexte: string; en: string };

const ENTETE = /<header class="cadre entete">[\s\S]*?<\/header>/;
const PIED = /<footer class="pied">[\s\S]*?<\/footer>/;
const echapper = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FRANCAIS = /[éèêàçùôîûœ]|\b(le|la|les|des|une|vous|votre|vos|pour|avec|sans|dans|chaque|qui|est|sont|et)\b/i;

/** Les dictionnaires de `anglais/`, dans l'ordre de leurs noms. */
export function dictionnaires(): Entree[] {
  const dossier = fileURLToPath(new URL('anglais/', import.meta.url));
  return readdirSync(dossier).filter((f) => f.endsWith('.json')).sort()
    .flatMap((f) => JSON.parse(readFileSync(dossier + f, 'utf8')) as Entree[]);
}

export interface Traduction {
  html: string;
  /** Les entrées qui ont servi sur cette page (un dictionnaire n'en garde aucune morte). */
  servies: Set<Entree>;
  /** Le texte du corps qui a encore l'air français, les noms de `FRANCAIS_VOULU` mis à part. */
  restes: string[];
}

/** La page anglaise de la page française `fr` (son adresse, `/contact/`), depuis son HTML. */
export function pageAnglaise(html: string, fr: string, entrees: readonly Entree[]): Traduction {
  const en = JUMELLES[fr];
  if (!en) throw new Error(`page sans jumelle : ${fr}`);
  const servies = new Set<Entree>();
  // L'en-tête et le pied ne se traduisent pas : `pageAvecEntete` les réécrit à la fin.
  const entete = html.match(ENTETE)?.[0], pied = html.match(PIED)?.[0];
  if (!entete || !pied) throw new Error(`${fr} : en-tête ou pied de page introuvable`);
  let h = html.replace(ENTETE, '\u0002E\u0002').replace(PIED, '\u0002P\u0002');

  // 1. Les contextes exacts, d'abord
  for (const e of entrees) {
    if (!('contexte' in e) || !h.includes(e.contexte)) continue;
    servies.add(e);
    h = h.split(e.contexte).join(e.en);
  }
  // 2. Les fragments entiers, du plus long au plus court, hors <script> (sauf le JSON-LD), <style> et commentaires
  const morceaux: string[] = [];
  h = h.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, (m) => {
    morceaux.push(m);
    return `\u0001${morceaux.length - 1}\u0001`;
  });
  const fragments = entrees.filter((e): e is { fr: string; en: string } => 'fr' in e).sort((a, b) => b.fr.length - a.fr.length);
  for (const e of fragments) {
    const avant = h;
    h = h.replace(new RegExp(`(>\\s*)${echapper(e.fr).replace(/ /g, '\\s+')}(\\s*<)`, 'g'), (_, a: string, b: string) => a + e.en + b);
    h = h.replace(new RegExp(`(\\s(?:alt|title|aria-label|placeholder|data-copie|data-echec|content)=")${echapper(e.fr)}(")`, 'g'), (_, a: string, b: string) => a + e.en + b);
    if (h !== avant) servies.add(e);
  }
  h = h.replace(/\u0001(\d+)\u0001/g, (_, i: string) => {
    let m = morceaux[Number(i)]!;
    if (!/type="application\/ld\+json"/.test(m)) return m;
    for (const e of fragments) {
      if (!m.includes(`"${e.fr}"`)) continue;
      servies.add(e);
      m = m.split(`"${e.fr}"`).join(`"${e.en}"`);
    }
    return m;
  });

  // 3. La langue et les adresses
  h = h.replace('<html lang="fr">', '<html lang="en">');
  h = h.replace('<meta property="og:locale" content="fr_FR">', '<meta property="og:locale" content="en_US">\n<meta property="og:locale:alternate" content="fr_FR">');
  const versEn = (chemin: string): string | null => {
    const [, page, suite] = /^([^?#]*)([?#].*)?$/.exec(chemin)!;
    return JUMELLES[page!] ? JUMELLES[page!] + (suite ?? '') : null;
  };
  h = h.replace(/href="(\/[^"]*)"/g, (tout, c: string) => { const v = versEn(c); return v ? `href="${v}"` : tout; });
  h = h.replace(new RegExp(`${echapper(ORIGINE)}(\\/[^"\\s<]*)`, 'g'), (tout, c: string) => { const v = versEn(c); return v ? ORIGINE + v : tout; });
  h = h.replace(/https:\/\/console\.messagingme\.app\/[^"\s<]*/g, (u) => (/[?&]lang=/.test(u) ? u
    : u.replace(/^([^#]*)(#.*)?$/, (_, a: string, b?: string) => `${a}${a.includes('?') ? '&' : '?'}lang=en${b ?? ''}`)));
  // Un chemin relatif se lit depuis la page : sous /en/, il viserait un fichier qui n'existe pas. On le rend absolu.
  const absolu = (c: string): string => {
    if (!c || /^([a-z][a-z0-9+.-]*:|\/|#|\{)/i.test(c)) return c;
    const u = new URL(c, ORIGINE + fr);
    return u.pathname + u.search + u.hash;
  };
  h = h.replace(/\s(src|href|poster|data-vertical|data-affiche-verticale)="([^"]*)"/g, (_, a: string, c: string) => ` ${a}="${absolu(c)}"`);
  h = h.replace(/\ssrcset="([^"]*)"/g, (_, v: string) => ` srcset="${v.split(',').map((p) => p.trim().replace(/^\S+/, absolu)).join(', ')}"`);
  h = h.replace(/url\((['"]?)([^)'"]+)\1\)/g, (_, q: string, c: string) => `url(${q}${absolu(c)}${q})`);
  // La bulle : le widget anglais (« Got a question? ») remplace le français.
  h = h.split('https://api.messagingme.app/widget/ndabjvs20vc4.js').join('https://api.messagingme.app/widget/dyzfezy33kcx.js');
  // Une image ou un film qui a sa version anglaise (`<nom>-en.<ext>`, `<nom>-en-9x16.<ext>`, à côté de la française) la
  // prend, sans le `?v=` de la française ; les autres restent français.
  h = h.replace(/\/(films|img)\/([\w-]+?)(-9x16)?\.(mp4|webp|png|jpg)(\?v=\d+)?(?=["')\s,])/g,
    (tout, dossier: string, nom: string, vertical: string | undefined, ext: string) => {
      const anglais = `${dossier}/${nom}-en${vertical ?? ''}.${ext}`;
      return existsSync(SITE + anglais) ? `/${anglais}` : tout;
    });
  // La langue que le JSON-LD déclare, pour la page comme pour ses films.
  h = h.replace(/"inLanguage": "fr-FR"/g, '"inLanguage": "en-US"');

  // 4. hreflang, réciproque dans les deux langues : `pageAvecEntete` y lit la jumelle du drapeau
  const bloc = [`fr" href="${ORIGINE}${fr}`, `en" href="${ORIGINE}${en}`, `x-default" href="${ORIGINE}${fr}`]
    .map((l) => `<link rel="alternate" hreflang="${l}">`).join('\n');
  h = h.replace(/<link rel="alternate" hreflang="[^"]*" href="[^"]*">\n?/g, '');
  h = h.replace(/(<link rel="canonical" href="[^"]*">)/, `$1\n${bloc}`);

  // Ce qui a encore l'air français dans le corps, avant d'y remettre l'en-tête et le pied
  const nu = h.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '');
  const francais = (s: string): boolean => FRANCAIS.test(FRANCAIS_VOULU.reduce((t, nom) => t.split(nom).join(' '), s.replace(/&[a-z]+;/g, ' ')));
  const restes = new Set<string>();
  for (const [, t] of nu.matchAll(/>([^<>]+)</g)) {
    const texte = t!.replace(/\s+/g, ' ').trim();
    if (texte && francais(texte)) restes.add(texte);
  }
  for (const [, v] of nu.matchAll(/\s(?:alt|title|aria-label|placeholder|content)="([^"]*)"/g)) {
    if (/\s/.test(v!) && francais(v!)) restes.add(v!);
  }

  h = h.replace('\u0002E\u0002', () => entete).replace('\u0002P\u0002', () => pied);
  return {
    html: pageAvecEntete(h, `${en.slice(1)}index.html`),
    servies,
    restes: [...restes],
  };
}

function main(): void {
  const site = SITE;
  const entrees = dictionnaires();
  const servies = new Set<Entree>();
  let reecrites = 0;
  for (const fr of GENEREES) {
    const t = pageAnglaise(readFileSync(`${site}${fr.slice(1)}index.html`, 'utf8'), fr, entrees);
    const sortie = `${site}${JUMELLES[fr]!.slice(1)}index.html`;
    let avant = '';
    try { avant = readFileSync(sortie, 'utf8'); } catch { /* page neuve */ }
    if (t.html !== avant) { mkdirSync(dirname(sortie), { recursive: true }); writeFileSync(sortie, t.html); reecrites++; }
    t.servies.forEach((e) => servies.add(e));
    for (const r of t.restes) console.log(`${fr} : reste en français : ${r}`);
  }
  const mortes = entrees.filter((e) => !servies.has(e));
  for (const e of mortes) console.log(`entrée qui ne sert plus : ${'fr' in e ? e.fr : e.contexte}`);
  console.log(`${GENEREES.length} pages générées, ${reecrites} réécrites`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
