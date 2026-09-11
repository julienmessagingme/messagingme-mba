import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { arbresNav, type NavEntree } from '../web/lib/nav';

/**
 * LA BARRE DE NAVIGATION EST LA CARTE DE LA CONSOLE, et ce test est ce qui l'empêche de mentir.
 *
 * 🔴 Le bot d'aide (spec du 2026-09-11) emmène la personne sur un écran en choisissant une CLÉ de cette
 * barre. Une clé qui ne mène nulle part produirait un lien mort dans une réponse d'aide, c'est-à-dire
 * exactement la faute que toute cette conception cherche à rendre impossible : un bot qui annonce un bouton
 * qui n'existe pas fait perdre confiance dans le PRODUIT, pas dans le bot.
 *
 * ⚠️ Ce test vaut AUSSI sans le bot d'aide, et il aurait dû exister avant lui : une entrée de barre qui
 * pointe vers une page supprimée rend un 404 à un client qui clique dans le menu, et rien aujourd'hui ne le
 * signalerait.
 */
const t = (fr: string) => fr;

/** Toutes les entrées de toutes les listes, à plat, groupes compris. */
function aPlat(entrees: NavEntree[]): NavEntree[] {
  return entrees.flatMap((e) => [e, ...(e.children ? aPlat(e.children) : [])]);
}

/** Toutes les entrées des quatre listes de la barre. */
function toutesLesEntrees(): NavEntree[] {
  return Object.values(arbresNav(t)).flatMap((liste) => aPlat(liste));
}

/**
 * Les adresses servies par une page réelle de `web/app`, sous la forme `/campaigns`.
 *
 * ⚠️ Les segments entre parenthèses sont des GROUPES Next : ils organisent les fichiers sans apparaître
 * dans l'URL. Les compter produirait des adresses qui n'existent pas, donc un test qui passe sur une barre
 * fausse.
 */
function routesReelles(): Set<string> {
  const racine = fileURLToPath(new URL('../web/app', import.meta.url));
  const vues = new Set<string>();
  const descendre = (dossier: string, prefixe: string): void => {
    for (const nom of readdirSync(dossier)) {
      const chemin = join(dossier, nom);
      if (statSync(chemin).isDirectory()) {
        descendre(chemin, nom.startsWith('(') ? prefixe : `${prefixe}/${nom}`);
      } else if (nom === 'page.tsx') {
        vues.add(prefixe === '' ? '/' : prefixe);
      }
    }
  };
  descendre(racine, '');
  return vues;
}

describe('la carte de la console', () => {
  it('🔴 chaque adresse de la barre est servie par une page réelle', () => {
    const routes = routesReelles();
    for (const e of toutesLesEntrees()) {
      if (!e.href) continue;
      expect(routes.has(e.href), `la barre pointe vers ${e.href}, qui n’a aucune page`).toBe(true);
    }
  });

  it('une entrée porte SOIT une adresse SOIT des enfants, jamais ni l’un ni l’autre', () => {
    // Une entrée sans les deux est invisible de l'utilisateur comme du bot : elle n'est ni une destination
    // ni un groupe. C'est une faute de saisie, pas un cas à tolérer.
    for (const e of toutesLesEntrees()) {
      expect(Boolean(e.href) || Boolean(e.children?.length), `entrée « ${e.key} » vide`).toBe(true);
    }
  });

  it('🔴 aucune clé n’apparaît deux fois, toutes listes confondues', () => {
    // Deux entrées de même clé rendraient la résolution d'une clé AMBIGUË, et le bot d'aide enverrait au
    // hasard. C'est aussi ce qui casse `cheminDeNav`, qui rend la première trouvée.
    const cles = toutesLesEntrees().map((e) => e.key);
    const doublons = cles.filter((c, i) => cles.indexOf(c) !== i);
    expect(doublons, `clés en double : ${doublons.join(', ')}`).toEqual([]);
  });

  it('la barre couvre les quatre listes, pas seulement celle de la Console', () => {
    // Garde-fou de ce test lui-même : s'il ne lisait qu'une liste, les trois autres pourraient pointer
    // n'importe où sans que rien ne tombe. Le bloc bas (Developers) est le plus facile à oublier, parce
    // qu'il est rendu à part.
    const listes = arbresNav(t);
    expect(Object.keys(listes).sort()).toEqual(['adminBas', 'console', 'inbox', 'perf']);
    for (const [nom, liste] of Object.entries(listes)) {
      expect(liste.length, `la liste « ${nom} » est vide`).toBeGreaterThan(0);
    }
  });
});
