import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgDepotAide } from '../../src/aide/fiches.pg';

/**
 * LA RECHERCHE DANS LE MODE D'EMPLOI DE LA CONSOLE (migration 0131).
 *
 * 🔴 CE QUI EST VÉRIFIÉ N'EST PAS « la requête SQL s'exécute ». C'est qu'une question posée avec les mots
 * d'un CLIENT trouve la fiche écrite avec les mots du PRODUIT, et surtout qu'une question hors sujet n'en
 * trouve AUCUNE. Le second cas est celui qui compte : un rappel qui remonte toujours quelque chose
 * transforme le seuil de pertinence en décoration, et le bot répond alors à côté avec aplomb.
 *
 * ⚠️ NE PAS LANCER EN LOCAL : le `DATABASE_URL` du `.env` local pointe sur la PRODUCTION. La CI monte un
 * Postgres jetable et applique les migrations avant (job `integration`).
 *
 * ⚠️ `aide_fiches` n'a AUCUN `tenant_id` : le mode d'emploi est le même pour tous les espaces. Les lignes
 * posées ici sont donc globales à la base de test, d'où les clés préfixées et le ménage en fin de fichier.
 */
const url = process.env.DATABASE_URL ?? '';

/** Un vecteur de la dimension de la colonne (0110 et 0131), avec un seul axe à 1. */
const axe = (i: number): number[] => Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : 0));

describe.skipIf(!url)('recherche dans les fiches d’aide', () => {
  let pool: Pool;
  let depot: PgDepotAide;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 2 });
    depot = new PgDepotAide(pool);
    await pool.query(`delete from aide_fiches where cle like 'itest-%'`);
    await pool.query(
      `insert into aide_fiches (cle, titre, corps, ecran) values
         ($1, $2, $3, $4),
         ($5, $6, $7, $8),
         ($9, $10, $11, null)`,
      [
        'itest-campagne', 'Lancer une campagne',
        'Une campagne envoie un modèle de message approuvé à une liste de contacts. Ouvrez Campagnes, '
        + 'choisissez votre modèle, puis votre audience, et vérifiez l’aperçu avant d’envoyer.', 'campagnes',
        'itest-scenario', 'Créer un scénario',
        'Un scénario enchaîne des messages et des actions selon ce que répond le contact.', 'workflows',
        'itest-sans-ecran', 'À quoi sert un modèle approuvé',
        'Meta doit approuver un modèle avant qu’il parte à quelqu’un qui ne vous a pas écrit récemment.',
      ],
    );
  });

  afterAll(async () => {
    await pool.query(`delete from aide_fiches where cle like 'itest-%'`);
    await pool.end();
  });

  it('une question dans les mots du CLIENT trouve la fiche du produit', async () => {
    // Le client ne dit pas « campagne », il dit « envoyer un message à toute ma liste ». C'est exactement
    // l'écart que la recherche doit franchir.
    const r = await depot.chercher('comment envoyer un message à toute ma liste de contacts', 12);
    expect(r.map((f) => f.cle)).toContain('itest-campagne');
  });

  it('🔴 une question HORS SUJET ne remonte RIEN', async () => {
    const r = await depot.chercher('quelle est la capitale de la Bolivie', 12);
    expect(r.filter((f) => f.cle.startsWith('itest-'))).toEqual([]);
  });

  it('la fiche porte son ÉCRAN, pour que la réponse sache où emmener', async () => {
    const r = await depot.chercher('lancer une campagne', 12);
    expect(r.find((f) => f.cle === 'itest-campagne')?.ecran).toBe('campagnes');
  });

  it('⚠️ une fiche SANS écran reste trouvable, avec `ecran` à null', async () => {
    // Toutes les questions ne mènent pas à un écran. « À quoi sert un modèle approuvé » s'explique sans
    // emmener nulle part, et refuser ces fiches priverait le bot de la moitié de ce qu'il a à dire.
    const r = await depot.chercher('modèle approuvé par Meta', 12);
    expect(r.find((f) => f.cle === 'itest-sans-ecran')?.ecran).toBeNull();
  });

  it('⚠️ une question VIDE ne lance aucune requête et rend une liste vide', async () => {
    // `to_tsquery` sur une chaîne vide lèverait, et une exception ici ferait tomber la route entière.
    expect(await depot.chercher('   ', 12)).toEqual([]);
    expect(await depot.chercher('!?,.', 12)).toEqual([]);
  });

  it('la COUVERTURE dit combien de termes de la question ont été trouvés', async () => {
    // C'est la mesure sur laquelle le verdict s'appuiera. Si elle était toujours à 1, ou toujours à 0, le
    // reste du mécanisme serait aveugle sans que rien ne le signale.
    const r = await depot.chercher('campagne modèle audience', 12);
    const f = r.find((x) => x.cle === 'itest-campagne');
    expect(f).toBeDefined();
    expect(f!.couverture).toBeGreaterThan(0);
    expect(f!.couverture).toBeLessThanOrEqual(1);
    expect(f!.termesTrouves).toBeGreaterThan(0);
  });

  it('🔴 le rappel VECTORIEL classe par proximité et ignore les fiches sans vecteur', async () => {
    // Les trois fiches sont posées sans vecteur : le rappel vectoriel ne doit donc rien rendre, plutôt que
    // de les traiter comme des vecteurs nuls, ce qui les rendrait toutes également « proches ».
    expect(await depot.chercherParVecteur(axe(0), 12)).toEqual([]);

    const modele = 'itest-modele';
    const aVectoriser = await depot.fichesAVectoriser(modele, 50);
    const ids = new Map(aVectoriser.map((f) => [f.titre, f.id]));
    const campagne = ids.get('Lancer une campagne')!;
    const scenario = ids.get('Créer un scénario')!;
    expect(campagne && scenario).toBeTruthy();

    await depot.ecrireVecteurs(modele, [
      { id: campagne, vecteur: axe(0) },
      { id: scenario, vecteur: axe(1) },
    ]);

    const proches = await depot.chercherParVecteur(axe(0), 12);
    expect(proches[0]?.cle).toBe('itest-campagne');
    expect(proches[0]?.similarite).toBeGreaterThan(0.9);
    // La fiche orthogonale remonte quand même, et c'est LE POINT : il y a toujours une fiche « la moins
    // loin ». Sa similarité basse est ce qui rend le reclassement nécessaire plutôt que facultatif.
    expect(proches.find((f) => f.cle === 'itest-scenario')?.similarite).toBeLessThan(0.5);
  });

  it('🔴 une fiche VECTORISÉE sort de la liste à vectoriser, mais pas pour un AUTRE modèle', async () => {
    // C'est ce qui rend un changement de modèle progressif : on ne vide pas la colonne d'un coup, le
    // balayage remplace les vecteurs périmés au fil de l'eau pendant que les anciens continuent de servir.
    const restants = await depot.fichesAVectoriser('itest-modele', 50);
    expect(restants.map((f) => f.titre)).not.toContain('Lancer une campagne');
    const autre = await depot.fichesAVectoriser('itest-autre-modele', 50);
    expect(autre.map((f) => f.titre)).toContain('Lancer une campagne');
  });

  it('⚠️ la clé est UNIQUE : recharger une fiche la met à jour, il ne la duplique pas', async () => {
    // C'est ce qui rend `npm run aide:charger` idempotent. Sans la contrainte, chaque chargement doublerait
    // la base et la recherche remonterait deux fois la même réponse.
    await pool.query(
      `insert into aide_fiches (cle, titre, corps, ecran) values ($1, $2, $3, $4)
       on conflict (cle) do update set titre = excluded.titre, corps = excluded.corps, ecran = excluded.ecran`,
      ['itest-campagne', 'Lancer une campagne', 'Texte remplacé.', 'campagnes'],
    );
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from aide_fiches where cle = 'itest-campagne'`,
    );
    expect(rows[0]?.n).toBe('1');
  });
});
