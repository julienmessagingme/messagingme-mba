import '../charger-env';
import Fastify from 'fastify';
import { config } from '../config';
import { pool } from '../db/pool';
import { journaliser } from '../lib/journal';
import { PgBossQueue } from '../queue/pgboss';
import { PgComptesApplication } from './comptes.pg';
import { enregistrerRoutesApplication } from './routes-internes';
import { creerGestionnaireSessions } from './sessions';
import { cleDepuisHex } from './transport/chiffrement';
import { effacerEtatAuth } from './transport/etat-auth';
import { ouvrirSession } from './transport/session';

/**
 * LE SERVICE DE CONNEXIONS `mba-application` (plan 2026-10-22, tâche 3) : `npm run application`. Il tient une
 * session par compte relié de la filière « application WhatsApp Business », verse chaque message reçu dans la file
 * `application-entrant` (traitée par le worker, par la même ingestion que les webhooks de Meta), et sert ses routes
 * internes signées à l'API et au worker. Un seul exemplaire : deux copies ouvriraient deux fois la même session.
 *
 * Comme l'API, il PRÊTE son pool à pg-boss pour empiler : la migration, la supervision et l'écoute des files restent
 * au worker.
 */
async function demarrer(): Promise<void> {
  const app = Fastify({ logger: false });
  app.get('/sante', async () => ({ ok: true }));
  if (!config.APPLICATION_SERVICE_SECRET) {
    // Filière fermée : le processus reste debout sans rien tenir (son serveur le garde en vie). Sorti, `restart:
    // unless-stopped` le relancerait en boucle, et le déploiement Scaleway refuse un service qui redémarre.
    await app.listen({ host: '0.0.0.0', port: config.APPLICATION_SERVICE_PORT });
    journaliser('warn', 'application_fermee', { raison: 'APPLICATION_SERVICE_SECRET vide' });
    return;
  }
  const cle = cleDepuisHex(config.ENCRYPTION_KEY);
  const comptes = new PgComptesApplication(pool);
  const queue = new PgBossQueue(pool, config.PGBOSS_SCHEMA);
  queue.onError((err) => journaliser('error', 'application_pgboss', { erreur: String(err) }));
  await queue.start();

  const sessions = creerGestionnaireSessions({
    comptes,
    ouvrir: (compte, rappels) => ouvrirSession(compte, { pool, cle }, rappels),
    enfiler: (job) => queue.enqueue('application-entrant', job, { groupId: job.tenantId }),
    prevenir: async (compte, quoi) => {
      journaliser('warn', quoi === 'banni' ? 'application_numero_banni' : 'application_appareil_retire', { compte: compte.id, espace: compte.tenantId });
    },
    effacer: (id) => effacerEtatAuth(pool, id),
  });

  enregistrerRoutesApplication(app, { sessions, secret: config.APPLICATION_SERVICE_SECRET });
  await app.listen({ host: '0.0.0.0', port: config.APPLICATION_SERVICE_PORT });
  await sessions.reprendre();
  journaliser('info', 'application_demarre', { port: config.APPLICATION_SERVICE_PORT });

  const arreter = async () => {
    // fermer() ferme les sockets sans détruire les sessions côté WhatsApp : elles reprennent au démarrage suivant.
    sessions.arreter();
    await app.close();
    await queue.stop();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void arreter());
  process.once('SIGINT', () => void arreter());
}

demarrer().catch((err) => {
  console.error(err);
  process.exit(1);
});
