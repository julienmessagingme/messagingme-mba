/**
 * Charge `.env` quand il existe (poste de développement). À importer en premier : `./config` lit
 * l'environnement dès son propre import.
 *
 * En production il n'y a pas de fichier (variables de l'`env_file` de compose) : seule son absence est tolérée,
 * toute autre erreur remonte. Une variable déjà posée dans l'environnement n'est jamais écrasée.
 */
try {
  process.loadEnvFile();
} catch (err) {
  if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
}
