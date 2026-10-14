/**
 * L'AUDIT BLOQUANT DES DÉPENDANCES DE PRODUCTION (lot 6 du bilan des audits, livraison B2).
 *
 * 🔴 POURQUOI IL BLOQUE. `npm audit` a tourné un mois en `continue-on-error` pendant que fastify et nodemailer, servis à
 * chaque requête et à chaque e-mail, portaient des failles hautes : un contrôle que personne ne lit ne contrôle rien.
 * Il ne bloque que sur ce qu'on sait tenir : les dépendances de PRODUCTION (`--omit=dev`), aux gravités haute et
 * critique. Le développement et les gravités moindres restent visibles dans l'étape informative de la CI.
 *
 * ⚠️ UNE FAILLE SANS CORRECTIF ACCESSIBLE SE MET EN EXCEPTION, DATÉE : `scripts/audit-exceptions.json`, une entrée par
 * avis (son identifiant GHSA), avec la raison et une échéance. Passée l'échéance, l'avis BLOQUE de nouveau : l'exception
 * se revoit, elle ne s'oublie pas. La procédure : `documentation.md` § les contrôles de sécurité de la CI.
 *
 * Un rapport illisible (registre injoignable) BLOQUE aussi : un contrôle qui passe quand il n'a rien lu ment. Relancer.
 *
 * Usage : npx tsx scripts/audit-production.ts <dossier>   (l'API : `.`, la console : `web`)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ExceptionAudit {
  /** L'identifiant de l'avis, `GHSA-xxxx-xxxx-xxxx`. */
  avis: string;
  /** Le dossier audité où l'avis se trouve, tel que passé au script : `.` (l'API) ou `web` (la console). */
  dossier: string;
  paquet: string;
  raison: string;
  /** Dernier jour de validité, `AAAA-MM-JJ`. */
  jusquau: string;
}

interface AvisAudit { name: string; title: string; url: string; severity: string; range: string }
export interface RapportAudit { vulnerabilities?: Record<string, { via: Array<AvisAudit | string> }> }

export interface VerdictAudit {
  /** Les avis graves sans exception, ou dont l'exception est échue : chacun bloque. */
  bloquants: string[];
  excuses: string[];
  /** Les exceptions qui ne servent plus : à retirer du fichier (n'échouent pas). */
  inutiles: string[];
}

const GRAVES = new Set(['high', 'critical']);
const idAvis = (url: string): string => url.slice(url.lastIndexOf('/') + 1);

export function jugerAudit(rapport: RapportAudit, exceptions: ExceptionAudit[], aujourdhui: string): VerdictAudit {
  if (!rapport.vulnerabilities) throw new Error('rapport de npm audit illisible (registre injoignable ?) : relancer');
  const graves = new Map<string, AvisAudit>();
  for (const v of Object.values(rapport.vulnerabilities)) {
    // Une entrée `string` renvoie à un autre paquet du même rapport, jugé pour lui-même.
    for (const avis of v.via) if (typeof avis === 'object' && GRAVES.has(avis.severity)) graves.set(idAvis(avis.url), avis);
  }
  const verdict: VerdictAudit = { bloquants: [], excuses: [], inutiles: [] };
  for (const [id, a] of graves) {
    const ligne = `${id} (${a.severity}) ${a.name} ${a.range} : ${a.title}`;
    const exception = exceptions.find((e) => e.avis === id);
    if (!exception) verdict.bloquants.push(ligne);
    else if (exception.jusquau < aujourdhui) verdict.bloquants.push(`${ligne} [exception échue le ${exception.jusquau}]`);
    else verdict.excuses.push(`${ligne} [exception jusqu'au ${exception.jusquau} : ${exception.raison}]`);
  }
  for (const e of exceptions) if (!graves.has(e.avis)) verdict.inutiles.push(`${e.avis} (${e.paquet})`);
  return verdict;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dossier = resolve(process.argv[2] ?? '.');
  let brut = '';
  try {
    brut = execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: dossier, encoding: 'utf8', shell: process.platform === 'win32' });
  } catch (err) {
    // `npm audit` rend 1 dès qu'il trouve quelque chose : le rapport est quand même sur la sortie standard.
    brut = (err as { stdout?: string }).stdout ?? '';
  }
  const toutes = JSON.parse(readFileSync(new URL('./audit-exceptions.json', import.meta.url), 'utf8')) as ExceptionAudit[];
  const exceptions = toutes.filter((e) => e.dossier === (process.argv[2] ?? '.'));
  let verdict: VerdictAudit;
  try {
    verdict = jugerAudit(JSON.parse(brut) as RapportAudit, exceptions, new Date().toISOString().slice(0, 10));
  } catch (err) {
    console.error(`ÉCHEC (${dossier}) : ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  for (const l of verdict.excuses) console.log(`exception : ${l}`);
  for (const l of verdict.inutiles) console.log(`⚠️ exception inutile, à retirer de scripts/audit-exceptions.json : ${l}`);
  if (verdict.bloquants.length > 0) {
    for (const l of verdict.bloquants) console.error(`BLOQUANT : ${l}`);
    console.error(`${verdict.bloquants.length} avis grave(s) dans les dépendances de production de ${dossier} : mettre à jour, ou`
      + ' poser une exception datée et motivée dans scripts/audit-exceptions.json.');
    process.exit(1);
  }
  console.log(`OK : aucune faille haute ou critique sans exception dans les dépendances de production de ${dossier}.`);
}
