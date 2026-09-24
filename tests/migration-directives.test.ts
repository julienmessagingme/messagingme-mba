import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { veutHorsTransaction, decouperInstructions } from '../src/db/migration-directives';

const MIGRATIONS = new URL('../db/migrations/', import.meta.url);

/**
 * Le SQL sans ses commentaires de ligne.
 *
 * Indispensable pour la garde ci-dessous : la migration 0032 PARLE de `CREATE INDEX CONCURRENTLY` dans une
 * note d'en-tête sans en exécuter un. Chercher dans le fichier brut faisait donc échouer une migration
 * parfaitement correcte, appliquée depuis des mois.
 */
function sansCommentaires(sql: string): string {
  // ⚠️ `\r?\n` et pas `\n` : un fichier extrait en CRLF (poste Windows) garde son `\r` en fin de ligne, que
  // `.` ne traverse pas, donc `--.*$` ne retirait RIEN. Mesuré sur 0115, dont le commentaire nomme
  // `CREATE INDEX CONCURRENTLY` : la garde lisait le commentaire comme du SQL.
  return sql.split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');
}

/**
 * Le SQL porte-t-il une instruction CONCURRENTLY, donc interdite dans une transaction ?
 *
 * 🔴 LA RÈGLE NE VOYAIT PAS `create unique index concurrently` : son motif exigeait `index` juste après
 * `create`. Une migration d'index unique sans la directive aurait échoué au déploiement, migration à moitié
 * passée, sans que ce test ne dise rien. Même chose pour `drop index concurrently` et `reindex ... concurrently`,
 * tout aussi interdits en transaction (le commentaire de 0172 prescrit justement un `drop index concurrently`
 * de reprise).
 */
const construitConcurrently = (corps: string): boolean =>
  /(create\s+(unique\s+)?index|drop\s+index|reindex\s+\w+)\s+concurrently/i.test(corps);
/**
 * ⚠️ Le `if not exists` se cherche DANS le regard en avant, pas après un `\s+` consommé : sinon, devant plusieurs
 * blancs ou un saut de ligne, `\s+` recule d'un caractère, le regard voit « ␣if » et la garde crie « non
 * rejouable » sur une migration correcte.
 */
const concurrentlySansGarde = (corps: string): boolean =>
  /create\s+(unique\s+)?index\s+concurrently(?!\s+if\s+not\s+exists)/i.test(corps);

/**
 * La directive `-- migrate: no-transaction` décide si une migration est jouée SANS filet. Une reconnaissance
 * trop large enlèverait la transaction à une migration qui compte dessus ; trop étroite ferait échouer un
 * `CREATE INDEX CONCURRENTLY` avec un message obscur de Postgres. Les deux sens sont donc testés.
 */
describe('directive de migration hors transaction', () => {
  it('reconnaît la forme exacte, seule sur sa ligne', () => {
    expect(veutHorsTransaction('-- migrate: no-transaction\ncreate index ...')).toBe(true);
    expect(veutHorsTransaction('--migrate:no-transaction\n')).toBe(true);
    expect(veutHorsTransaction('--   migrate:   no-transaction   \n')).toBe(true);
    // Après quelques lignes de commentaire d'en-tête : toujours reconnue.
    expect(veutHorsTransaction(`-- 0096_x.sql\n--\n-- migrate: no-transaction\ncreate index ...`)).toBe(true);
  });

  it('🔴 ne reconnaît PAS une occurrence qui n’est pas une ligne de directive', () => {
    // Dans une chaîne SQL : ce n'est pas une directive, et la migration doit garder sa transaction.
    expect(veutHorsTransaction(`insert into notes(t) values ('migrate: no-transaction');`)).toBe(false);
    // En fin de ligne, derrière du SQL : la ligne n'est pas ENTIÈREMENT la directive.
    expect(veutHorsTransaction('create index x; -- migrate: no-transaction')).toBe(false);
    // Faute de frappe : on préfère l'échec bruyant de Postgres à une transaction retirée par erreur.
    expect(veutHorsTransaction('-- migrate: notransaction\n')).toBe(false);
    expect(veutHorsTransaction('-- no-transaction\n')).toBe(false);
    expect(veutHorsTransaction('alter table t add column c int;')).toBe(false);
  });

  it('🔴 ignore une directive enfouie au-delà de l’en-tête', () => {
    const tardif = `${'-- ligne\n'.repeat(60)}-- migrate: no-transaction\n`;
    expect(veutHorsTransaction(tardif)).toBe(false);
  });

  it('🔴 un index UNIQUE construit CONCURRENTLY est soumis à la même règle', () => {
    expect(construitConcurrently('create unique index concurrently if not exists x on t (a)')).toBe(true);
    expect(concurrentlySansGarde('create unique index concurrently x on t (a)')).toBe(true);
    expect(concurrentlySansGarde('create unique index concurrently if not exists x on t (a)')).toBe(false);
  });

  it('⚠️ plusieurs blancs ou un saut de ligne avant `if not exists` : la garde est bien là', () => {
    expect(concurrentlySansGarde('create index concurrently\n  if not exists x on t (a)')).toBe(false);
    expect(concurrentlySansGarde('create unique index concurrently   if not exists x on t (a)')).toBe(false);
    expect(concurrentlySansGarde('create index concurrently\n  x on t (a)')).toBe(true);
  });

  it('🔴 `drop index` et `reindex` CONCURRENTLY exigent eux aussi la directive', () => {
    expect(construitConcurrently('drop index concurrently x')).toBe(true);
    expect(construitConcurrently('drop index concurrently if exists x')).toBe(true);
    expect(construitConcurrently('reindex index concurrently x')).toBe(true);
    expect(construitConcurrently('drop index x')).toBe(false);
  });

  it('🔴 les migrations RÉELLES du dépôt respectent les deux sens de la règle', () => {
    // Garde de non-régression sur les fichiers eux-mêmes, dans les deux sens :
    //  - un `CREATE INDEX CONCURRENTLY` SANS la directive échouerait au déploiement (Postgres l'interdit
    //    dans un bloc de transaction), et on ne le découvrirait que sur le VPS, migration à moitié passée ;
    //  - une migration hors transaction n'a AUCUN filet : elle sera rejouée depuis le début après un échec,
    //    donc chacune de ses créations d'index doit porter `if not exists`.
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql'))) {
      const sql = readFileSync(new URL(f, MIGRATIONS), 'utf8');
      const hors = veutHorsTransaction(sql);
      const corps = sansCommentaires(sql);
      const concurrently = construitConcurrently(corps);
      if (concurrently) {
        expect(hors, `${f} : CONCURRENTLY sans la directive -> échec au déploiement`).toBe(true);
      }
      if (hors) {
        const nonIdempotent = concurrentlySansGarde(corps);
        expect(nonIdempotent, `${f} : hors transaction, un CONCURRENTLY sans \`if not exists\` -> non rejouable`).toBe(false);
      }
    }
  });
});

/**
 * Le DÉCOUPAGE en instructions. Il n'existe que parce que Postgres exécute une requête simple
 * multi-instructions dans une transaction IMPLICITE : envoyer le fichier entier annulerait l'effet de la
 * directive (mesuré le 2026-09-01 : « cannot run inside a transaction block »).
 */
describe('découpage d’une migration en instructions', () => {
  it('coupe sur les points-virgules, et jette le blanc et les commentaires', () => {
    expect(decouperInstructions('create index a on t(x);\ncreate index b on t(y);\n'))
      .toEqual(['create index a on t(x)', 'create index b on t(y)']);
    expect(decouperInstructions('-- rien que du commentaire\n\n')).toEqual([]);
    expect(decouperInstructions('select 1')).toEqual(['select 1']); // dernier point-virgule facultatif
  });

  it('🔴 ne coupe PAS sur un point-virgule de chaîne ou de commentaire', () => {
    const sql = "create index i on c (regexp_replace(p, '[^0-9;]', '', 'g')); -- note ; ici\nselect 2;";
    // Deux instructions, PAS quatre : ni le `;` de la classe de caractères, ni celui du commentaire ne
    // coupent. Le commentaire de fin de ligne voyage avec l'instruction SUIVANTE, ce qui est sans effet
    // (Postgres accepte un commentaire en tête) et évite de perdre le texte au passage.
    expect(decouperInstructions(sql)).toEqual([
      "create index i on c (regexp_replace(p, '[^0-9;]', '', 'g'))",
      '-- note ; ici\nselect 2',
    ]);
    expect(decouperInstructions("select 'a;b';")).toEqual(["select 'a;b'"]);
    expect(decouperInstructions("select 'il''a dit ; bonjour';")).toEqual(["select 'il''a dit ; bonjour'"]);
    expect(decouperInstructions('/* bloc ; ici */ select 3;')).toEqual(['/* bloc ; ici */ select 3']);
  });

  it('🔴 ne coupe pas dans un corps de fonction à dollars', () => {
    const sql = 'create function f() returns int as $corps$ begin return 1; end $corps$ language plpgsql;\nselect 4;';
    expect(decouperInstructions(sql)).toHaveLength(2);
    expect(decouperInstructions(sql)[0]).toContain('return 1; end');
  });

  it('la migration 0096 se découpe en TROIS créations d’index, pas une de plus', () => {
    const sql = readFileSync(new URL('0096_index_chemins_chauds.sql', MIGRATIONS), 'utf8');
    const instructions = decouperInstructions(sql);
    expect(instructions).toHaveLength(3);
    for (const i of instructions) expect(i.toLowerCase()).toContain('create index concurrently if not exists');
  });

  it('la migration de `contacts.external_id` se découpe en DEUX instructions : la colonne, puis l’index unique', () => {
    const f = readdirSync(MIGRATIONS).find((x) => x.endsWith('_contacts_external_id.sql'));
    expect(f, 'la migration existe').toBeDefined();
    const instructions = decouperInstructions(readFileSync(new URL(f!, MIGRATIONS), 'utf8'));
    expect(instructions).toHaveLength(2);
    expect(instructions[0]!.toLowerCase()).toContain('alter table contacts add column if not exists external_id text');
    expect(instructions[1]!.toLowerCase()).toContain('create unique index concurrently if not exists contacts_tenant_external_id_uidx');
    // Parmi les fiches ACTIVES : une fiche supprimée ne retient plus son identifiant (revue finale du 2026-09-24).
    expect(instructions[1]!.toLowerCase()).toContain('where external_id is not null and deleted_at is null');
  });
});
