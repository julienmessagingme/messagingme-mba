import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * PROPOSE DES BROUILLONS DE FICHES D'AIDE à partir de `features.md`.
 *
 * 🔴 CE SCRIPT N'EST PAS DU CODE DE PRODUCTION. Le serveur ne l'appelle jamais. Il écrit des BROUILLONS dans
 * `docs/aide/fiches/`, qu'on relit dans le diff de la poussée avant de les garder, de les réécrire ou de les
 * jeter. C'est le même motif que l'onglet Construction d'un agent : il propose, un humain corrige, rien ne
 * part sans un accord.
 *
 * 🔴 POURQUOI IL NE RÉGÉNÈRE JAMAIS TOUT SEUL. Une régénération automatique remplacerait un texte RELU par un
 * texte non relu, et le bot se mettrait à parler aux clients avec des phrases que personne n'a validées. Il
 * refuse donc d'écraser une fiche existante sans qu'on le lui demande explicitement.
 *
 * ⚠️ `features.md` EST ÉCRIT POUR L'ÉQUIPE, pas pour les clients : numéros de migration, dates de livraison,
 * noms de fichiers, récits d'incident. C'est toute la raison d'être de cette passe de réécriture, et c'est
 * `tests/aide-fiches-format.test.ts` qui refuse une fiche où il en resterait.
 */

const here = dirname(fileURLToPath(import.meta.url));
const racine = join(here, '..');
const dossierFiches = join(racine, 'docs', 'aide', 'fiches');

/** Une section de `features.md` : son titre, son corps, et l'empreinte de ce corps. */
export interface SectionFeatures {
  section: string;
  corps: string;
  empreinte: string;
}

/**
 * L'empreinte d'un texte : les six premiers caractères de son SHA-256.
 *
 * ⚠️ AUCUNE NORMALISATION, ni des espaces ni de la casse. Une empreinte qui pardonne une reformulation est
 * une empreinte qui ne détecte plus rien, et son seul métier est de dire « ce texte n'est plus celui qui a
 * été relu ». Six caractères suffisent : on cherche un CHANGEMENT, pas une preuve d'intégrité.
 */
export function empreinteDe(texte: string): string {
  return createHash('sha256').update(texte, 'utf8').digest('hex').slice(0, 6);
}

/**
 * Découpe `features.md` sur ses titres de niveau deux.
 *
 * ⚠️ LE CORPS S'ARRÊTE À LA SECTION SUIVANTE. Le laisser courir jusqu'à la fin ferait changer l'empreinte de
 * la première section à chaque modification de n'importe quelle autre : la détection de dérive crierait en
 * permanence, donc plus du tout.
 */
export function decouperFeatures(markdown: string): SectionFeatures[] {
  const out: SectionFeatures[] = [];
  // 🔴 CRLF TOLERE, ET CE N EST PAS DE LA COQUETTERIE. Cette fonction LIT un fichier du disque, et sous
  // Windows (le poste de ce depot) un `.md` porte legitimement des fins de ligne CRLF : git le reecrit
  // ainsi au checkout avec `core.autocrlf=true`, et tout outil qui le reecrit fait pareil. Le retour
  // chariot final defait alors le motif de titre ci-dessous (en JS, le point ne matche pas un terminateur
  // de ligne), et la fonction rend ZERO section SANS la moindre erreur. Vecu le 2026-09-11 : l ecriture
  // d une section dans `features.md` a converti le fichier, et la detection de derive s est mise a
  // annoncer que TOUTES les sections citees par les fiches avaient disparu.
  const lignes = markdown.split(/\r?\n/);
  let titre: string | null = null;
  let corps: string[] = [];
  const pousser = (): void => {
    if (titre !== null && corps.join('\n').trim() !== '') {
      out.push({ section: titre, corps: corps.join('\n').trim(), empreinte: empreinteDe(corps.join('\n').trim()) });
    }
  };
  for (const ligne of lignes) {
    const m = /^## +(.+?) *$/.exec(ligne);
    if (m) {
      pousser();
      titre = m[1]!;
      corps = [];
    } else if (titre !== null) {
      corps.push(ligne);
    }
  }
  pousser();
  return out;
}

/** Le nom de fichier d'une fiche, dérivé de son titre. */
function cleDepuisTitre(titre: string): string {
  return titre
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const CONSIGNE = `Tu réécris une section de la documentation interne d'un produit en une FICHE D'AIDE destinée
à un CLIENT qui utilise la console, et qui ne connaît rien de notre code.

RÈGLES ABSOLUES :
- Écris en français, à la deuxième personne du pluriel, comme un mode d'emploi.
- N'emploie JAMAIS : un numéro de migration, un chemin de fichier, un nom de fonction, une date de
  livraison, un récit d'incident, le mot « commit », ni le nom d'une infrastructure interne.
- N'emploie AUCUN tiret cadratin ni demi-cadratin. Virgule, deux-points, parenthèses ou point.
- N'invente RIEN. Si la section ne dit pas comment faire quelque chose, ne l'explique pas.
- Commence par un titre markdown de niveau un, court, qui est la QUESTION que le client se pose.
- Puis le corps, entre cent et quatre cents mots.

Tu ne rends que le markdown de la fiche, rien d'autre.`;

async function main(): Promise<void> {
  const cle = process.env['AI_GATEWAY_API_KEY'] ?? '';
  const modele = process.env['AGENT_AIDE_MODEL'] ?? '';
  if (cle === '' || modele === '') {
    throw new Error('AI_GATEWAY_API_KEY et AGENT_AIDE_MODEL sont requis pour proposer des fiches');
  }
  // Les sections demandées en argument, ou toutes. Proposer les quarante d'un coup produirait un diff que
  // personne ne relit vraiment, ce qui viderait la relecture de son sens.
  const voulues = new Set(process.argv.slice(2));
  const sections = decouperFeatures(readFileSync(join(racine, 'features.md'), 'utf8'))
    .filter((s) => voulues.size === 0 || voulues.has(s.section));
  if (sections.length === 0) throw new Error('aucune section ne correspond');

  for (const s of sections) {
    const nom = `${cleDepuisTitre(s.section)}.md`;
    const chemin = join(dossierFiches, nom);
    // 🔴 On n'écrase JAMAIS une fiche relue. La réécrire demande de la supprimer d'abord, à la main, ce qui
    // est un geste conscient et visible dans le diff.
    if (existsSync(chemin)) {
      // eslint-disable-next-line no-console
      console.log(`ignorée (existe déjà) : ${nom}`);
      continue;
    }
    const reponse = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${cle}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modele,
        messages: [
          { role: 'system', content: CONSIGNE },
          { role: 'user', content: `Section « ${s.section} » :\n\n${s.corps}` },
        ],
      }),
    });
    if (!reponse.ok) throw new Error(`Gateway ${reponse.status} sur « ${s.section} »`);
    const json = (await reponse.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const texte = json.choices?.[0]?.message?.content?.trim() ?? '';
    if (texte === '') throw new Error(`réponse vide sur « ${s.section} »`);
    const entete = ['---', `source_section: ${s.section}`, `source_empreinte: ${s.empreinte}`, '---', ''].join('\n');
    writeFileSync(chemin, `${entete}${texte}\n`, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`proposée : ${nom} (à RELIRE avant de garder)`);
  }
  // eslint-disable-next-line no-console
  console.log('\nRelisez chaque fiche, puis `npx vitest run tests/aide-fiches-format.test.ts`.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}
