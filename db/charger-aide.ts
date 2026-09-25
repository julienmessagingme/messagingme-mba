/**
 * Charge les fiches du mode d'emploi de `docs/aide/fiches/*.md` vers la table `aide_fiches`.
 * Usage : npx tsx db/charger-aide.ts
 *
 * 🔴 LE DÉPÔT EST LA SOURCE, LA TABLE EST L'INDEX. Les fiches sont relues en diff git : versionnées,
 * attribuables, réversibles, et relues là où l'on relit déjà tout le reste. C'est ce qui a permis de
 * supprimer l'écran d'administration que la conception prévoyait d'abord, et c'est pour ça que ce chargeur
 * RETIRE les lignes dont le fichier a disparu : sans ça, le bot continuerait de répondre avec une page
 * effacée du produit, et personne ne saurait d'où sort sa réponse.
 *
 * ⚠️ IDEMPOTENT PAR LA CLÉ (le nom du fichier). Relancer met à jour, il ne duplique pas. Sans ça, chaque
 * chargement doublerait la base et la recherche remonterait deux fois la même réponse.
 *
 * ⚠️ IL NE VECTORISE RIEN, et c'est délibéré : le balayage existant s'en charge (`balayerVectorisation`).
 * Une fiche chargée à l'instant est trouvable par les MOTS tout de suite, par le SENS au passage suivant.
 * Faire l'inverse ferait échouer un chargement entier sur une panne du fournisseur de vecteurs.
 */
import '../src/charger-env';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { pgSsl } from '../src/db/ssl';
import { lireFicheDuDepot, type FicheFichier } from '../src/aide/fiches';

const here = dirname(fileURLToPath(import.meta.url));
const dossier = join(here, '..', 'docs', 'aide', 'fiches');

/** Les fiches du dépôt, lues et triées par clé pour que la sortie soit stable d'une exécution à l'autre. */
export function fichesDuDepot(): FicheFichier[] {
  return readdirSync(dossier)
    .filter((n) => n.endsWith('.md'))
    .sort()
    .map((n) => lireFicheDuDepot(n, readFileSync(join(dossier, n), 'utf8')));
}

/**
 * Écrit ces fiches dans la table, et RETIRE celles qui n'y sont pas.
 *
 * Exportée pour être testée contre une vraie base sans passer par `process.argv` ni par l'environnement.
 *
 * ⚠️ TOUT SE FAIT DANS UNE TRANSACTION. Un chargement à moitié appliqué laisserait la recherche dans un état
 * que personne n'a relu : des fiches neuves à côté de fiches retirées du dépôt.
 */
export async function chargerFiches(
  client: Client,
  fiches: FicheFichier[],
): Promise<{ ecrites: number; retirees: number }> {
  try {
    await client.query('begin');
    for (const f of fiches) {
      await client.query(
        `insert into aide_fiches (cle, titre, corps, ecran, source_section, source_empreinte)
              values ($1, $2, $3, $4, $5, $6)
         on conflict (cle) do update
                set titre = excluded.titre,
                    corps = excluded.corps,
                    ecran = excluded.ecran,
                    source_section = excluded.source_section,
                    source_empreinte = excluded.source_empreinte,
                    updated_at = now(),
                    -- 🔴 LE VECTEUR EST INVALIDÉ QUAND LE TEXTE CHANGE, et jamais autrement. Le garder
                    -- laisserait une fiche réécrite trouvable par son ANCIEN sens, ce qui est la pire des
                    -- deux erreurs : la recherche resterait cohérente avec elle-même tout en servant le
                    -- texte d'avant. Le balayage le recalcule au passage suivant.
                    embedding = case when aide_fiches.titre is distinct from excluded.titre
                                       or aide_fiches.corps is distinct from excluded.corps
                                     then null else aide_fiches.embedding end,
                    embedding_modele = case when aide_fiches.titre is distinct from excluded.titre
                                              or aide_fiches.corps is distinct from excluded.corps
                                            then null else aide_fiches.embedding_modele end`,
        [f.cle, f.titre, f.corps, f.ecran, f.sourceSection, f.sourceEmpreinte],
      );
    }
    const retirees = await client.query(
      `delete from aide_fiches where cle <> all($1::text[])`,
      [fiches.map((f) => f.cle)],
    );
    await client.query('commit');
    return { ecrites: fiches.length, retirees: retirees.rowCount ?? 0 };
  } catch (e) {
    await client.query('rollback');
    throw e;
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant (.env)');

  const fiches = fichesDuDepot();
  // Zéro fiche est presque toujours une erreur de chemin, pas une intention. Vider la table sur cette base
  // rendrait le bot muet sans que personne ne comprenne pourquoi, donc on refuse plutôt que d'obéir.
  if (fiches.length === 0) throw new Error(`aucune fiche trouvée dans ${dossier} : chargement refusé`);

  const client = new Client({ connectionString: url, ssl: pgSsl() });
  await client.connect();
  try {
    const { ecrites, retirees } = await chargerFiches(client, fiches);
    // eslint-disable-next-line no-console
    console.log(`fiches d'aide : ${ecrites} chargées, ${retirees} retirées`);
  } finally {
    await client.end();
  }
}

// Le chargeur s'exécute pour lui-même ; `fichesDuDepot` est importable par les tests sans toucher la base.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}
