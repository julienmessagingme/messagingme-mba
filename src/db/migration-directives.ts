/**
 * Les directives qu'un fichier de migration peut adresser au runner, lues dans son en-tête.
 * `CREATE INDEX CONCURRENTLY` est interdit par Postgres dans une transaction, or le runner enveloppe chaque
 * migration dans `begin`/`commit` : sans échappatoire, tout index bloquerait les écritures de sa table pendant sa
 * construction.
 */

/** Combien de lignes d'en-tête sont lues. Une directive se déclare en tête de fichier, pas au milieu. */
const LIGNES_ENTETE = 40;

/**
 * Ce fichier demande-t-il à être joué hors transaction ? Forme exacte : `-- migrate: no-transaction`, seule sur sa
 * ligne (une occurrence dans une chaîne SQL ne déclenche rien), dans les 40 premières lignes.
 */
export function veutHorsTransaction(sql: string): boolean {
  return sql
    .split('\n', LIGNES_ENTETE)
    .some((ligne) => /^\s*--\s*migrate:\s*no-transaction\s*$/.test(ligne));
}

/**
 * Découpe un fichier en instructions, pour les envoyer une par une.
 *
 * Sans ce découpage, la directive ne sert à rien : Postgres exécute une requête simple à plusieurs instructions
 * dans une transaction implicite, et `CREATE INDEX CONCURRENTLY` y échoue (« cannot run inside a transaction
 * block ») même sans `begin`/`commit`.
 * Le découpage connaît les chaînes et les commentaires : un point-virgule dedans ne coupe rien.
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

/**
 * Clé du verrou d'avis qui sérialise les exécutions de migrations. Elles s'appliquent depuis deux endroits (le
 * conteneur du VPS et un poste qui pointe la même base) : deux exécutions simultanées joueraient deux fois la même
 * migration, ce qui compte pour une migration de données.
 * Valeur arbitraire mais fixe : deux exécutions doivent demander le même verrou. Ne jamais la changer.
 */
export const VERROU_MIGRATIONS = 8_142_026_090_1;
