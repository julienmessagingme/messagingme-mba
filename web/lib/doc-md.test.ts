import { describe, it, expect, vi } from 'vitest';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUPES_DOC, PAGES_DOC, RESUMES_PAGES } from './doc-api-pages';
import { cheminMd, llmsTxt, versMarkdown, type Langue, type PageMd } from './doc-md';

/**
 * 🔴 LA DOC EN MARKDOWN EST CELLE DES PAGES (lot 17). Chaque page de `PAGES_DOC` est rendue ici dans les deux langues
 * (React côté serveur, le cadre remplacé par son contenu), convertie (`./doc-md.ts`), et comparée au caractère près aux
 * fichiers versionnés de `public/` : une page changée sans `npm run doc:md` rend la CI rouge, au lieu de servir aux
 * modèles une doc qui ne dit plus la même chose que l'écran. `npm run doc:md` (`--mode ecrire`) les réécrit.
 *
 * L'adresse de l'API est celle de la production : la doc affiche `NEXT_PUBLIC_API_URL`, figée au build de Vercel.
 */
vi.hoisted(() => { process.env.NEXT_PUBLIC_API_URL = 'https://api.messagingme.app'; });

// Le cadre attend la session du navigateur pour rendre quoi que ce soit : ici, le contenu seul, comme un visiteur.
vi.mock('@/components/doc-api/CadreDoc', () => ({
  CadreDoc: ({ children }: { children: (session: null) => ReactNode }) => children(null),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => createElement('a', { href, className }, children),
}));

const WEB = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(WEB, 'public');
const ECRIRE = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'ecrire';
const CONTRAT = 'https://api.messagingme.app/openapi.json';

const lire = (chemin: string): string | null => (existsSync(chemin) ? readFileSync(chemin, 'utf8').replace(/\r\n/g, '\n') : null);
function ecrireOuComparer(relatif: string, attendu: string): void {
  const chemin = join(PUBLIC, relatif);
  if (ECRIRE) {
    mkdirSync(dirname(chemin), { recursive: true });
    writeFileSync(chemin, attendu);
    return;
  }
  expect(lire(chemin), `${relatif} est périmé : lancer npm run doc:md dans web/`).toBe(attendu);
}

async function rendre(fichier: string, langue: Langue): Promise<string> {
  const { LocaleFixe } = await import('./i18n');
  const mod = (await import(/* @vite-ignore */ join(WEB, fichier.replace(/^web\//, '')))) as { default: ComponentType };
  return renderToStaticMarkup(createElement(LocaleFixe, { locale: langue }, createElement(mod.default)));
}

const PAGES_HREF = new Set<string>(PAGES_DOC.map((p) => p.href));
const enMd: Record<Langue, string[]> = { fr: [], en: [] };

describe('la doc en Markdown (public/**/*.md) est celle des pages', () => {
  for (const p of PAGES_DOC) {
    for (const langue of ['fr', 'en'] as const) {
      it(`${p.href} (${langue})`, async () => {
        const md = versMarkdown(await rendre(p.fichier, langue), { langue, href: p.href, pagesDoc: PAGES_HREF });
        expect(md, 'le h1 de la page').toContain(`# ${langue === 'fr' ? p.titre[0] : p.titre[1]}`);
        enMd[langue].push(md);
        ecrireOuComparer(cheminMd(p.href, langue), md);
      }, 30_000);
    }
  }

  it('llms.txt, et la doc entière dans les deux langues', () => {
    // Les pages sont rendues dans l'ordre de la carte : ces deux fichiers suivent le même ordre.
    expect(enMd.fr).toHaveLength(PAGES_DOC.length);
    expect(enMd.en).toHaveLength(PAGES_DOC.length);
    const pages: PageMd[] = PAGES_DOC.map((p) => ({
      href: p.href, titre: p.titre, resume: RESUMES_PAGES[p.cle], groupe: GROUPES_DOC.find((g) => g.cle === p.groupe)!.titre,
    }));
    ecrireOuComparer('llms.txt', llmsTxt(pages, CONTRAT));
    ecrireOuComparer('llms-full.txt', enMd.fr.join('\n---\n\n'));
    ecrireOuComparer('llms-full.en.txt', enMd.en.join('\n---\n\n'));
  });

  it('🔴 aucun .md orphelin : une page retirée de la carte ne reste pas servie', () => {
    const attendus = new Set(PAGES_DOC.flatMap((p) => (['fr', 'en'] as const).map((l) => cheminMd(p.href, l))));
    const presents = mdSous(join(PUBLIC, 'developers'));
    const orphelins = presents.filter((f) => !attendus.has(f));
    if (ECRIRE) { for (const f of orphelins) rmSync(join(PUBLIC, f)); return; }
    expect(orphelins, 'à retirer (npm run doc:md le fait)').toEqual([]);
    expect([...presents].sort()).toEqual([...attendus].sort());
  });
});

function mdSous(dossier: string): string[] {
  if (!existsSync(dossier)) return [];
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) return mdSous(chemin);
    return nom.endsWith('.md') ? [relative(PUBLIC, chemin).split('\\').join('/')] : [];
  });
}

describe('le convertisseur', () => {
  const md = (html: string): string => versMarkdown(html, { langue: 'fr', href: '/developers/api/x', pagesDoc: new Set(['/developers/api/contacts']) });

  it('un titre porte son ancre, une section la sienne', () => {
    expect(md('<section id="forme"><h2>La forme</h2><p>texte</p></section>')).toContain('<a id="forme"></a>\n\n## La forme\n\ntexte');
  });

  it('🔴 deux éléments en ligne qui se touchent sont séparés : deux codes restent deux codes', () => {
    expect(md('<p><code>a</code><code>b</code></p>')).toContain('`a` `b`');
    expect(md('<h3><code>c</code><span>400</span></h3>')).toContain('### `c` 400');
    expect(md('<p>x <code>a</code>, <code>b</code></p>')).toContain('x `a`, `b`');
  });

  it('un lien vers une page de la doc mène à son .md, ancre comprise ; un autre chemin de la console reste tel quel', () => {
    expect(md('<p><a href="/developers/api/contacts#creer">c</a></p>')).toContain('[c](https://console.messagingme.app/developers/api/contacts.md#creer)');
    expect(md('<p><a href="/signup">s</a></p>')).toContain('[s](https://console.messagingme.app/signup)');
  });

  it('un tableau sans en-tête reçoit un en-tête vide ; un bloc de code garde son texte', () => {
    expect(md('<table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>')).toContain('|   |   |\n| --- | --- |\n| A | B |');
    expect(md('<pre>{\n  &quot;a&quot;: 1\n}</pre>')).toContain('```\n{\n  "a": 1\n}\n```');
  });

  it('les boutons, le texte pour lecteur d’écran et data-md="ignorer" disparaissent ; un encadré devient une citation', () => {
    const sortie = md('<div><span class="sr-only">Copié</span><button>Copier</button><span data-md="ignorer">mobile</span><p>reste</p></div>');
    expect(sortie).not.toMatch(/Copi|mobile/);
    expect(sortie).toContain('reste');
    expect(md('<div data-encadre="note"><p>Note</p><div><p>dedans</p></div></div>')).toContain('> **Note**\n>\n> dedans');
  });

  it('🔴 une balise inconnue fait échouer, au lieu d’être perdue en silence', () => {
    expect(() => md('<p><blink>x</blink></p>')).toThrow(/balise inconnue/);
    expect(() => md('<marquee>x</marquee>')).toThrow(/balise inconnue/);
  });
});
