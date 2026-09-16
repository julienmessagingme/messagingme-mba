/**
 * Comment un identifiant venu d'un serveur MCP devient un nom que NOUS pouvons porter.
 *
 * 🔴 UNE SEULE VÉRITÉ, POUR DEUX USAGES QUI SE RESSEMBLENT SANS ÊTRE LE MÊME. L'aplatisseur nomme les
 * FEUILLES d'un outil (unicité dans l'outil) ; l'import nomme l'OUTIL dans l'espace (unicité dans
 * `agent_tools`, depuis 0127). Deux portées différentes, mais exactement la même contrainte de forme et le
 * même piège de troncature : les écrire deux fois ferait diverger la seconde le jour où l'on corrige la
 * première.
 *
 * La contrainte vient de la base : `agent_tools.name` impose `^[a-z0-9_]{1,64}$` (migration 0086). La spec
 * MCP, elle, n'impose RIEN sur le nom d'un outil : `github.create_issue` et `get-weather` sont des noms
 * parfaitement valides en face.
 */

/** Longueur maximale d'un nom, imposée par `agent_tools.name`. */
export const NOM_MAX = 64;

/** Met un identifiant quelconque dans notre charset. Jamais vide : `param` est le repli. */
export function normaliserNom(brut: string): string {
  const plat = brut
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (plat === '' ? 'param' : plat).slice(0, NOM_MAX);
}

/**
 * Rend un nom qui n'est pas déjà `pris`, en le suffixant si besoin.
 *
 * ⚠️ LA BASE SE RECALCULE À CHAQUE TOUR, sur la longueur RÉELLE du suffixe. Une base figée à `NOM_MAX - 2`
 * tient pour `_2` à `_9`, puis déborde à la dixième collision (62 + « _10 » = 65), c'est-à-dire exactement
 * la borne que ce module existe pour respecter. Le cas paraît théorique ; il ne l'est pas pour des noms
 * longs qui se ressemblent, ce que produisent les schémas générés.
 *
 * ⚠️ Cette fonction NE MODIFIE PAS `pris` : c'est l'appelant qui décide d'y inscrire le nom, parce que lui
 * seul sait si sa ligne a fini par être écrite.
 */
export function nomUnique(souhaite: string, pris: ReadonlySet<string>): string {
  const base = normaliserNom(souhaite);
  if (!pris.has(base)) return base;
  let n = 2;
  for (;;) {
    const suffixe = `_${n}`;
    const candidat = `${base.slice(0, NOM_MAX - suffixe.length)}${suffixe}`;
    if (!pris.has(candidat)) return candidat;
    n += 1;
  }
}
