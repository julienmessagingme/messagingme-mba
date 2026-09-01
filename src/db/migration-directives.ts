/**
 * Les DIRECTIVES qu'un fichier de migration peut adresser au runner, lues dans son en-tête.
 *
 * Une seule pour l'instant, et elle existe pour une raison précise : `CREATE INDEX CONCURRENTLY` est
 * INTERDIT dans un bloc de transaction par Postgres, or le runner enveloppe chaque migration dans un
 * `begin`/`commit`. Sans échappatoire, tout index de ce dépôt se construit donc en bloquant les écritures de
 * la table pendant sa construction, au milieu d'un déploiement. C'est sans conséquence sur douze lignes et
 * c'est une panne sur cinq millions : la sortie de secours se pose AVANT d'en avoir besoin.
 */

/** Combien de lignes d'en-tête sont lues. Une directive se déclare en tête de fichier, pas au milieu. */
const LIGNES_ENTETE = 40;

/**
 * Ce fichier demande-t-il à être joué HORS transaction ?
 *
 * La forme exacte est `-- migrate: no-transaction`, seule sur sa ligne, dans les 40 premières lignes. Deux
 * choix volontaires : une ligne ENTIÈRE (une occurrence au milieu d'une chaîne SQL ne déclenche rien) et une
 * limite d'en-tête (on ne découvre pas en ligne 800 que la migration ne sera pas transactionnelle).
 */
export function veutHorsTransaction(sql: string): boolean {
  return sql
    .split('\n', LIGNES_ENTETE)
    .some((ligne) => /^\s*--\s*migrate:\s*no-transaction\s*$/.test(ligne));
}

/**
 * Découpe un fichier en instructions, pour les envoyer UNE PAR UNE.
 *
 * 🔴 SANS CE DÉCOUPAGE, LA DIRECTIVE NE SERT À RIEN, et c'est le piège qui a failli passer. Postgres exécute
 * une requête simple contenant PLUSIEURS instructions dans une transaction IMPLICITE : envoyer le fichier
 * entier en un seul `client.query()` rend donc `CREATE INDEX CONCURRENTLY` illégal, alors même qu'on a retiré
 * le `begin`/`commit`. Vérifié le 2026-09-01 dans un Postgres 16 jetable : deux `CREATE INDEX CONCURRENTLY`
 * dans un seul `psql -c` échouent avec « cannot run inside a transaction block », les mêmes en deux `-c`
 * passent.
 *
 * Le découpage est conscient des CHAÎNES et des commentaires : un point-virgule dans une chaîne SQL ou dans un
 * commentaire ne coupe rien. Sans ça, une migration parfaitement valide se retrouverait tronçonnée en
 * fragments de syntaxe, et l'erreur serait incompréhensible.
 */
export function decouperInstructions(sql: string): string[] {
  const morceaux: string[] = [];
  let debut = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    // Commentaire de ligne.
    if (c === '-' && sql[i + 1] === '-') {
      const fin = sql.indexOf('\n', i);
      i = fin === -1 ? sql.length : fin + 1;
      continue;
    }
    // Commentaire de bloc.
    if (c === '/' && sql[i + 1] === '*') {
      const fin = sql.indexOf('*/', i + 2);
      i = fin === -1 ? sql.length : fin + 2;
      continue;
    }
    // Chaîne simple, avec l'échappement `''`.
    if (c === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    // Chaîne à dollars (`$$ ... $$`, `$corps$ ... $corps$`), qui porte les corps de fonction.
    if (c === '$') {
      const marque = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(i));
      if (marque) {
        const tag = marque[0];
        const fin = sql.indexOf(tag, i + tag.length);
        i = fin === -1 ? sql.length : fin + tag.length;
        continue;
      }
    }
    if (c === ';') {
      morceaux.push(sql.slice(debut, i));
      debut = i + 1;
    }
    i += 1;
  }
  morceaux.push(sql.slice(debut));
  return morceaux.map((m) => m.trim()).filter(porteDuCode);
}

/** Ce morceau contient-il autre chose que des commentaires et du blanc ? */
function porteDuCode(morceau: string): boolean {
  return morceau
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('')
    .trim() !== '';
}
