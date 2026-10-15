import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * LES LECTEURS DE LA VITRINE, partagés par les tests qui la lisent (`tests/vitrine-developpeurs.test.ts`,
 * `tests/vitrine-pages.test.ts`). La vitrine est du HTML statique publié sans build : ces fonctions lisent ce que le
 * visiteur et les robots reçoivent, sans navigateur.
 */

export const SITE = resolve(__dirname, '..', 'site');

/** L'adresse publique de la vitrine, celle des balises canoniques et du plan du site. */
export const ORIGINE_VITRINE = 'https://app.messagingme.fr';

export const lire = (chemin: string): string => readFileSync(join(SITE, chemin), 'utf8');

/** Les fichiers `.html` de la vitrine, en chemins relatifs à `site/`. */
export function pagesHtml(dossier = SITE, prefixe = ''): string[] {
  return readdirSync(dossier).flatMap((nom) => {
    const complet = join(dossier, nom);
    const relatif = prefixe ? `${prefixe}/${nom}` : nom;
    if (statSync(complet).isDirectory()) return pagesHtml(complet, relatif);
    return nom.endsWith('.html') ? [relatif] : [];
  });
}

/** Le texte tel que le visiteur le lit : balises retirées, entités décodées. */
export function texte(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Le contenu de chaque élément qui porte l'attribut `attr`, par valeur d'attribut. */
export function parAttribut(html: string, attr: string): Array<{ valeur: string; contenu: string }> {
  const re = new RegExp(`<(\\w+)[^>]*\\s${attr}="([^"]+)"[^>]*>([\\s\\S]*?)</\\1>`, 'g');
  return [...html.matchAll(re)].map((m) => ({ valeur: m[2]!, contenu: m[3]! }));
}

/** L'adresse publique d'une page : `index.html` -> `/`, `tarifs/index.html` -> `/tarifs/`. */
export function adresseDe(page: string): string {
  return `${ORIGINE_VITRINE}/${page.replace(/index\.html$/, '')}`;
}
