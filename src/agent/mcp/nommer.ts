/**
 * Comment un identifiant venu d'un serveur MCP devient un nom que nous pouvons porter.
 *
 * Source unique pour l'aplatisseur (noms des feuilles d'un outil) et l'import (nom de l'outil dans l'espace) :
 * même contrainte de forme, même piège de troncature. La contrainte vient de la base (`agent_tools.name`
 * impose `^[a-z0-9_]{1,64}$`) ; la spec MCP n'impose rien (`github.create_issue` est valide en face).
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
 * La base se recalcule à chaque tour sur la longueur réelle du suffixe : figée à `NOM_MAX - 2`, elle
 * déborderait à la dixième collision (62 + « _10 » = 65). Ne modifie pas `pris` : seul l'appelant sait si sa
 * ligne a fini par être écrite.
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
