// Imprime le livre blanc en PDF A4 avec le Chromium de Playwright, installé dans web/.
//
//   node scripts/livre-blanc/imprimer.mjs docs/livre-blanc/whatsapp-education/livre-blanc.html sortie.pdf [dossier-images]
//
// La typographie française (espace fine insécable avant ; : ? ! % » et après «) se pose ici, sur le texte de la page
// seulement, et seulement si la page est en français (`lang`) : la source reste lisible et l'éditer n'oblige pas à taper
// des espaces invisibles. Avec un dossier d'images,
// chaque page y est aussi rendue en PNG, pour relire la mise en page sans ouvrir le PDF.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const racine = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(join(racine, 'web/package.json'))('playwright');

const [source, sortie, images] = process.argv.slice(2);
if (!source || !sortie) {
  console.error('usage : node scripts/livre-blanc/imprimer.mjs <source.html> <sortie.pdf> [dossier-images]');
  process.exit(1);
}

const navigateur = await chromium.launch();
const page = await navigateur.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1.5 });
await page.goto(pathToFileURL(resolve(source)).href, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  if (!document.documentElement.lang.startsWith('fr')) return document.fonts.ready;
  const textes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = textes.nextNode(); n; n = textes.nextNode()) {
    n.nodeValue = n.nodeValue.replace(/ ([;:?!%»])/g, ' $1').replace(/« /g, '« ');
  }
  return document.fonts.ready;
});
// Un bloc qui sort de sa page se signale ici plutôt qu'à l'œil.
const debords = await page.evaluate(() => [...document.querySelectorAll('section.page')].flatMap((s, i) => {
  const cadre = s.getBoundingClientRect();
  return [...s.querySelectorAll('*')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.height > 0 && (r.bottom > cadre.bottom + 1 || r.right > cadre.right + 1);
  }).slice(0, 3).map((e) => `page ${i + 1} : ${e.tagName.toLowerCase()}.${e.className}`);
}));
if (debords.length) console.log('Débordements :\n' + debords.join('\n'));
await page.pdf({ path: sortie, printBackground: true, preferCSSPageSize: true });
const pages = await page.locator('section.page').all();
if (images) for (const [i, p] of pages.entries()) await p.screenshot({ path: join(images, `page-${i + 1}.png`) });
await navigateur.close();
console.log(`${pages.length} pages imprimées dans ${sortie}`);
