// web/lib/doc-md.ts
import type { Bilingue } from './api-exemples';

/**
 * LA DOC EN MARKDOWN, POUR LES MODÈLES (lot 17) : chaque page de la doc rendue en `.md` (français) et `.en.md` (anglais),
 * plus `llms.txt` et ses deux versions complètes. Les fichiers sont versionnés dans `web/public/` ; `doc-md.test.ts` les
 * refait depuis les pages et les compare au caractère près (`npm run doc:md` les réécrit).
 *
 * 🔴 POURQUOI : le HTML de la doc est VIDE côté serveur (le cadre attend la session, lue dans le navigateur), donc un
 * modèle qui lit une page sans exécuter de JavaScript n'y trouve rien. Le `.md` est sa porte d'entrée.
 *
 * Ce module est PUR : il reçoit le HTML statique d'une page (React côté serveur) et rend du Markdown. Le convertisseur
 * ne connaît que les balises de nos composants de doc : une balise inconnue le fait ÉCHOUER au lieu d'être perdue en
 * silence. `data-md="ignorer"` retire un sous-arbre (boutons Copier, doublons pour mobile), `data-md="legende"` est la
 * légende d'un bloc de code, `data-encadre` un encadré.
 *
 * ⚠️ AUCUN IMPORT DE VALEUR : lu par la suite de la console ET par la suite racine.
 */

export type Langue = 'fr' | 'en';
export const CONSOLE = 'https://console.messagingme.app';

type Noeud = string | Element;
interface Element { tag: string; attrs: Record<string, string>; enfants: Noeud[] }

const VIDES = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr']);
const BLOCS = new Set(['section', 'div', 'header', 'nav', 'aside', 'main', 'article', 'details', 'summary', 'footer']);
const INLINES = new Set(['span', 'code', 'a', 'strong', 'b', 'em', 'i', 'br', 'small', 'abbr', 'kbd']);
const IGNORES = new Set(['button', 'svg', 'script', 'style']);

const ENTITES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decoder(t: string): string {
  return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITES[e.toLowerCase()] ?? m;
  });
}

/** Le HTML statique de React (bien formé, attributs entre guillemets doubles) en arbre. */
export function analyserHtml(html: string): Element {
  const racine: Element = { tag: '#racine', attrs: {}, enfants: [] };
  const pile: Element[] = [racine];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    const courant = pile[pile.length - 1]!;
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {
      const ferme = m[1].toLowerCase();
      if (courant.tag !== ferme) throw new Error(`HTML mal formé : </${ferme}> ferme <${courant.tag}>`);
      pile.pop();
    } else if (m[2]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[3] ?? '').matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) attrs[a[1]!] = decoder(a[2] ?? '');
      const el: Element = { tag: m[2].toLowerCase(), attrs, enfants: [] };
      courant.enfants.push(el);
      if (!m[4] && !VIDES.has(el.tag)) pile.push(el);
    } else if (m[5]) {
      courant.enfants.push(decoder(m[5]));
    }
  }
  if (pile.length !== 1) throw new Error(`HTML mal formé : <${pile[pile.length - 1]!.tag}> jamais fermé`);
  return racine;
}

/** Le chemin du `.md` d'une page de la doc (`/developers/api/contacts` vers `developers/api/contacts.md`). */
export function cheminMd(href: string, langue: Langue): string {
  return `${href.replace(/^\//, '')}${langue === 'fr' ? '.md' : '.en.md'}`;
}

interface Contexte { langue: Langue; pagesDoc: ReadonlySet<string> }

function ignore(el: Element): boolean {
  return IGNORES.has(el.tag) || el.attrs['data-md'] === 'ignorer' || /(^|\s)sr-only(\s|$)/.test(el.attrs.class ?? '') || el.attrs['aria-hidden'] === 'true';
}

function lien(href: string, ctx: Contexte): string {
  if (/^https?:\/\//.test(href) || href.startsWith('mailto:')) return href;
  if (href.startsWith('#')) return href;
  const [chemin = '', ancre] = href.split('#');
  const absolu = ctx.pagesDoc.has(chemin) ? `${CONSOLE}/${cheminMd(chemin, ctx.langue)}` : `${CONSOLE}${chemin}`;
  return ancre ? `${absolu}#${ancre}` : absolu;
}

function texteBrut(n: Noeud): string {
  if (typeof n === 'string') return n;
  if (ignore(n)) return '';
  return n.enfants.map(texteBrut).join('');
}

/**
 * Une suite d'éléments en ligne. 🔴 Deux éléments qui se touchent (aucun texte entre eux) reçoivent un espace : à l'écran,
 * c'est le CSS qui les sépare (`ml-2`, `gap-1`), et collés, deux codes `a` et `b` deviendraient un seul code
 * qui contient des accents graves.
 */
function enLigne(noeuds: Noeud[], ctx: Contexte): string {
  const morceaux = noeudsEnLigne(noeuds, ctx);
  let sortie = '';
  morceaux.forEach((m, i) => {
    const precedent = i > 0 ? noeuds[i - 1] : undefined;
    const colles = precedent !== undefined && typeof precedent !== 'string' && typeof noeuds[i] !== 'string';
    if (colles && m !== '' && sortie !== '' && !/\s$/.test(sortie) && !/^\s/.test(m)) sortie += ' ';
    sortie += m;
  });
  return sortie;
}

function noeudsEnLigne(noeuds: Noeud[], ctx: Contexte): string[] {
  return noeuds.map((n) => {
    if (typeof n === 'string') return n.replace(/\s+/g, ' ');
    if (ignore(n)) return '';
    switch (n.tag) {
      case 'code': {
        const t = texteBrut(n);
        return t.includes('`') ? `\`\` ${t} \`\`` : `\`${t}\``;
      }
      case 'a': return `[${enLigne(n.enfants, ctx).trim()}](${lien(n.attrs.href ?? '', ctx)})`;
      case 'strong': case 'b': return `**${enLigne(n.enfants, ctx).trim()}**`;
      case 'em': case 'i': return `_${enLigne(n.enfants, ctx).trim()}_`;
      case 'br': return '  \n';
      case 'span': case 'small': case 'abbr': case 'kbd': {
        // La légende d'un bloc de code, en italique ; un `span` affiché en bloc (la phrase sous un lien) se détache.
        if (n.attrs['data-md'] === 'legende') return `_${nettoyer(texteBrut(n))}_`;
        const texte = enLigne(n.enfants, ctx);
        return /(^|\s)block(\s|$)/.test(n.attrs.class ?? '') ? ` : ${texte.trim()}` : texte;
      }
      default:
        // Un bloc dans une ligne (un `div` dans une cellule) se lit comme du texte suivi.
        if (BLOCS.has(n.tag) || n.tag === 'p') return ` ${enLigne(n.enfants, ctx)} `;
        throw new Error(`balise inconnue en ligne : <${n.tag}>`);
    }
  });
}

const nettoyer = (t: string): string => t.replace(/[ \t ]+/g, (m) => (m.includes(' ') ? ' ' : ' ')).replace(/ +\n/g, '\n').trim();

function estEnLigne(n: Noeud): boolean {
  return typeof n === 'string' || ignore(n) || INLINES.has(n.tag);
}

function tableau(el: Element, ctx: Contexte): string {
  const lignes: string[][] = [];
  const parcourir = (n: Noeud): void => {
    if (typeof n === 'string' || ignore(n)) return;
    if (n.tag === 'tr') {
      lignes.push(n.enfants.filter((c): c is Element => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th'))
        .map((c) => nettoyer(enLigne(c.enfants, ctx)).replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
      return;
    }
    n.enfants.forEach(parcourir);
  };
  parcourir(el);
  if (lignes.length === 0) return '';
  const largeur = Math.max(...lignes.map((l) => l.length));
  const ligne = (l: string[]): string => `| ${[...l, ...Array(largeur - l.length).fill('')].join(' | ')} |`;
  // Un tableau sans `th` (l'index des endpoints) : un en-tête vide, que le Markdown exige, plutôt que sa première ligne.
  const [tete, ...corps] = contientTh(el) ? lignes : [Array<string>(largeur).fill(' '), ...lignes];
  return [ligne(tete!), `|${' --- |'.repeat(largeur)}`, ...corps.map(ligne)].join('\n');
}

function contientTh(n: Noeud): boolean {
  return typeof n !== 'string' && (n.tag === 'th' || n.enfants.some(contientTh));
}

function liste(el: Element, ctx: Contexte, ordonnee: boolean): string {
  let i = 0;
  return el.enfants.filter((c): c is Element => typeof c !== 'string' && !ignore(c)).map((li) => {
    if (li.tag !== 'li') throw new Error(`<${li.tag}> dans une liste`);
    i += 1;
    const puce = ordonnee ? `${i}. ` : '- ';
    const corps = blocs(li.enfants, ctx).join('\n\n');
    return puce + corps.split('\n').map((l, k) => (k === 0 || l === '' ? l : `  ${l}`)).join('\n');
  }).join('\n');
}

function blocs(noeuds: Noeud[], ctx: Contexte): string[] {
  const sortie: string[] = [];
  let enCours: Noeud[] = [];
  const vider = (): void => {
    const t = nettoyer(enLigne(enCours, ctx));
    if (t) sortie.push(t);
    enCours = [];
  };
  for (const n of noeuds) {
    if (estEnLigne(n)) { enCours.push(n); continue; }
    vider();
    sortie.push(...bloc(n as Element, ctx));
  }
  vider();
  return sortie;
}

function bloc(el: Element, ctx: Contexte): string[] {
  if (ignore(el)) return [];
  const ancre = el.attrs.id ? [`<a id="${el.attrs.id}"></a>`] : [];
  const titre = /^h([1-6])$/.exec(el.tag);
  if (titre) return [...ancre, `${'#'.repeat(Number(titre[1]))} ${nettoyer(enLigne(el.enfants, ctx))}`];
  switch (el.tag) {
    case 'p': {
      const t = nettoyer(enLigne(el.enfants, ctx));
      return t ? [...ancre, t] : ancre;
    }
    case 'ul': return [...ancre, liste(el, ctx, false)];
    case 'ol': return [...ancre, liste(el, ctx, true)];
    case 'table': return [...ancre, tableau(el, ctx)];
    case 'pre': {
      const code = texteBrut(el).replace(/\n+$/, '');
      const fence = code.includes('```') ? '~~~' : '```';
      return [...ancre, `${fence}\n${code}\n${fence}`];
    }
    case 'hr': return ['---'];
    default:
      if (!BLOCS.has(el.tag)) throw new Error(`balise inconnue : <${el.tag}>`);
      if (el.attrs['data-md'] === 'legende') return [`_${nettoyer(texteBrut(el))}_`];
      if (el.attrs['data-encadre']) {
        const [premier, ...reste] = blocs(el.enfants, ctx);
        const contenu = [premier ? `**${premier}**` : '', ...reste].filter(Boolean).join('\n\n');
        return [contenu.split('\n').map((l) => (l === '' ? '>' : `> ${l}`)).join('\n')];
      }
      return [...ancre, ...blocs(el.enfants, ctx)];
  }
}

/** Le Markdown d'une page, à partir de son HTML statique. */
export function versMarkdown(html: string, o: { langue: Langue; href: string; pagesDoc: ReadonlySet<string> }): string {
  const ctx: Contexte = { langue: o.langue, pagesDoc: o.pagesDoc };
  const autre = o.langue === 'fr' ? 'en' : 'fr';
  const entete = o.langue === 'fr'
    ? `<!-- Version Markdown de ${CONSOLE}${o.href}, générée depuis la page (npm run doc:md). English: ${CONSOLE}/${cheminMd(o.href, autre)} -->`
    : `<!-- Markdown version of ${CONSOLE}${o.href}, generated from the page (npm run doc:md). Français : ${CONSOLE}/${cheminMd(o.href, autre)} -->`;
  const corps = blocs(analyserHtml(html).enfants, ctx).join('\n\n');
  return `${entete}\n\n${corps.replace(/\n{3,}/g, '\n\n')}\n`;
}

export interface PageMd { readonly href: string; readonly groupe: Bilingue; readonly titre: Bilingue; readonly resume: Bilingue }

/** Le `llms.txt` de la console (le format de llmstxt.org) : chaque page, sa phrase, ses deux `.md`, et le contrat. */
export function llmsTxt(pages: readonly PageMd[], contratOpenApi: string): string {
  const groupes: Array<{ titre: Bilingue; pages: PageMd[] }> = [];
  for (const p of pages) {
    const g = groupes.find((x) => x.titre[0] === p.groupe[0]);
    if (g) g.pages.push(p); else groupes.push({ titre: p.groupe, pages: [p] });
  }
  return [
    '# Messaging Me : API et serveur MCP',
    '',
    '> L’API REST et le serveur MCP de Messaging Me (WhatsApp et RCS, sur l’API officielle de Meta) : envoyer, recevoir, gérer les fiches, les modèles et les webhooks sortants. The REST API and MCP server of Messaging Me (WhatsApp and RCS, on Meta’s official API).',
    '',
    'Chaque page existe en français (.md) et en anglais (.en.md). Every page exists in French (.md) and English (.en.md).',
    ...groupes.flatMap((g) => [
      '',
      `## ${g.titre[0]} / ${g.titre[1]}`,
      '',
      ...g.pages.map((p) => `- [${p.titre[0]}](${CONSOLE}/${cheminMd(p.href, 'fr')}): ${p.resume[0]} English: [${p.titre[1]}](${CONSOLE}/${cheminMd(p.href, 'en')})`),
    ]),
    '',
    '## Contrat / Contract',
    '',
    `- [OpenAPI 3.1](${contratOpenApi}): chaque route, ses corps, ses réponses, ses erreurs, et les événements des webhooks sortants. Every route, body, response and error, and the outgoing webhook events.`,
    '',
    '## Optional',
    '',
    `- [Toute la documentation, en français](${CONSOLE}/llms-full.txt)`,
    `- [The whole documentation, in English](${CONSOLE}/llms-full.en.txt)`,
    '',
  ].join('\n');
}
