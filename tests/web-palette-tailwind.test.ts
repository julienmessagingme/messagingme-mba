import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * UNE CLASSE TAILWIND QUI N'EXISTE PAS NE FAIT RIEN, ET NE LE DIT PAS.
 *
 * 🔴 CE N'EST PAS UNE PRÉCAUTION, C'EST UN CONSTAT. Le design system REMPLAÇAIT `sky` et `violet` par des
 * couleurs SIMPLES (`sky: '#3A8BD8'`), pas des échelles. `bg-violet-50` et `text-violet-700` ne sont donc
 * générés nulle part : la pastille « agent Meta » de l'Inbox et le statut « planifiée » des campagnes
 * s'affichaient SANS fond et en couleur par défaut, depuis toujours, sur quatre fichiers et huit endroits.
 * Personne ne l'avait vu, parce qu'une classe absente ne produit ni erreur de compilation, ni avertissement
 * de build, ni message de console : la page reste belle, elle est juste fausse.
 *
 * ⚠️ TROUVÉ EN MESURANT, PAS EN RELISANT. Le 2026-09-11, une ligne d'Inbox refusait de prendre son dégradé ;
 * lire `getComputedStyle` dans le navigateur a rendu `backgroundImage: "none"` alors que la classe était bien
 * sur l'élément. C'est la seule façon dont ce défaut peut se manifester.
 *
 * ⚠️ CE TEST NE REGARDE QUE LES COULEURS REDÉFINIES EN SIMPLE PAR LE PROJET. Les familles Tailwind d'origine
 * (`emerald`, `amber`, `red`…) gardent leurs échelles et ne sont pas concernées : une liste écrite à la main
 * dériverait, donc elle est LUE dans `tailwind.config.ts`.
 */

const RACINE = join(__dirname, '..', 'web');

/** Les clés de `theme.extend.colors` déclarées comme une CHAÎNE : elles n'ont aucune nuance numérotée. */
function couleursSansEchelle(): string[] {
  const config = readFileSync(join(RACINE, 'tailwind.config.ts'), 'utf8');
  const bloc = config.slice(config.indexOf('colors: {'));
  return [...bloc.matchAll(/^\s{8}([a-z]+): '#[0-9A-Fa-f]{3,8}',$/gm)].map((m) => m[1]!);
}

function fichiers(dossier: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dossier)) {
    const p = join(dossier, e);
    if (statSync(p).isDirectory()) out.push(...fichiers(p));
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

describe('La palette Tailwind du projet', () => {
  it('🔴 aucune couleur SIMPLE n’est utilisée avec une nuance numérotée', () => {
    const simples = couleursSansEchelle();
    // Si l'extraction rate, le test passerait en ne vérifiant rien : on exige donc d'en trouver.
    // ⚠️ Une seule depuis le 2026-09-25 : `sky`, `coral` et `gold` ont laissé la place aux échelles d'état
    // (`danger`, `alerte`, `succes`, déclarées dans `web/lib/couleurs.ts`), il ne reste que la couleur de
    // série `violet`.
    expect(simples.length, 'aucune couleur simple lue dans tailwind.config.ts').toBeGreaterThanOrEqual(1);
    expect(simples).toContain('violet');

    /**
     * ⚠️ AUCUN ANTISLASH DANS CE MOTIF, ET CE N'EST PAS UN CHOIX DE STYLE. La première version utilisait
     * `\b` et `\d` ; écrite depuis un heredoc, elle est arrivée sur le disque avec UN seul antislash,
     * donc `` (un caractère d'effacement) et `\d` (la lettre d) dans un littéral gabarit. Le test passait
     * en ne vérifiant rien, ce qui est le pire état possible pour une garde. `[0-9]` et une liste de
     * préfixes en toutes lettres n'ont aucune façon de se faire manger.
     */
    const PREFIXES = ['bg', 'text', 'border', 'ring', 'from', 'via', 'to', 'fill', 'stroke', 'decoration', 'shadow', 'outline', 'divide', 'accent', 'caret', 'placeholder'];
    const motif = new RegExp('(' + PREFIXES.join('|') + ')-(' + simples.join('|') + ')-[0-9]+', 'g');
    // 🔴 LA GARDE SE GARDE ELLE-MÊME : un motif qui n'attrape pas un cas connu rendrait toujours une liste
    // vide, donc un test vert qui ne vérifie rien. C'est exactement ce qui vient d'arriver.
    expect('bg-violet-50 text-violet-700'.match(motif)).toEqual(['bg-violet-50', 'text-violet-700']);

    const fautifs: string[] = [];
    for (const dossier of ['app', 'components']) {
      for (const f of fichiers(join(RACINE, dossier))) {
        for (const m of readFileSync(f, 'utf8').matchAll(motif)) {
          fautifs.push(`${f.slice(RACINE.length + 1)} : ${m[0]}`);
        }
      }
    }
    expect(fautifs, 'ces classes ne sont générées nulle part, donc elles ne font rien').toEqual([]);
  });
});
