/**
 * Charge `.env` quand il existe (poste de développement), à importer EN PREMIER par un point d'entrée : un
 * import est évalué dans l'ordre, et `./config` lit l'environnement dès le sien.
 *
 * En production il n'y a pas de fichier (les variables viennent de l'`env_file` de compose, `.dockerignore`
 * exclut `.env`) : seule l'absence du fichier est tolérée, toute autre erreur (fichier illisible, mal formé)
 * remonte. Une variable déjà posée dans l'environnement n'est jamais écrasée, comme avec `dotenv` avant.
 */
try {
  process.loadEnvFile();
} catch (err) {
  if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
}
