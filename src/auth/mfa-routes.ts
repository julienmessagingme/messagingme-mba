import type { FastifyInstance, FastifyReply } from 'fastify';
import { MESSAGE_CODE_INVALIDE } from '../../web/lib/partage/textes-serveur';
import type { Guard } from './middleware';
import {
  creerMachineMfa,
  type CommandeMfa,
  type MfaDeps,
  type ResultatMfa,
  type SuiteDeConnexion,
} from './mfa';

const MESSAGE_ETAPE_EXPIREE = 'Cette étape a expiré, reconnectez-vous.';
const MESSAGE_TROP = 'Trop de tentatives, réessayez dans une minute.';
const MESSAGE_INDISPONIBLE = 'Double authentification indisponible.';
const MESSAGE_DEJA_ACTIVE = 'La double authentification est déjà active.';

const texte = (valeur: unknown): string => (typeof valeur === 'string' ? valeur : '');

/** Le refus d'un code pendant un blocage : durée lisible et rappel que le secours reste une porte. */
function messageBloque(fin: Date): string {
  const minutes = Math.max(1, Math.ceil((fin.getTime() - Date.now()) / 60_000));
  return `Trop de codes faux : le code de l’application est bloqué pendant ${minutes} min. Un code de secours reste accepté.`;
}

/** Traduit un résultat nommé du module MFA vers le contrat HTTP existant. */
function repondre(reply: FastifyReply, resultat: ResultatMfa): FastifyReply {
  switch (resultat.kind) {
    case 'succes':
      return reply.code(200).send(resultat.corps);
    case 'etape_expiree':
      return reply.code(401).send({ error: MESSAGE_ETAPE_EXPIREE });
    case 'indisponible':
      return reply.code(503).send({ error: MESSAGE_INDISPONIBLE });
    case 'trop_de_tentatives':
      return reply.code(429).send({ error: MESSAGE_TROP });
    case 'code_invalide':
      return reply.code(401).send({ error: MESSAGE_CODE_INVALIDE });
    case 'bloque':
      return reply.code(429).send({ error: messageBloque(resultat.jusqua) });
    case 'deja_active':
      return reply.code(409).send({
        error: resultat.reconnecter ? `${MESSAGE_DEJA_ACTIVE} Reconnectez-vous.` : MESSAGE_DEJA_ACTIVE,
      });
    case 'compte_inconnu':
      return reply.code(404).send({ error: 'Compte inconnu.' });
    case 'mot_de_passe_absent':
      return reply.code(409).send({ error: 'Posez d’abord un mot de passe sur ce compte.' });
    case 'mot_de_passe_incorrect':
      // 403 : un 401 ferait perdre la session à la console.
      return reply.code(403).send({ error: 'Mot de passe incorrect.' });
    case 'facteur_inactif':
      return reply.code(409).send({ error: 'La double authentification n’est pas active.' });
    case 'facteur_obligatoire':
      return reply.code(403).send({
        error: resultat.raison === 'exploitation'
          ? 'La double authentification est obligatoire pour l’exploitation.'
          : 'Un espace dont vous êtes administrateur exige la double authentification : elle ne peut pas être désactivée.',
      });
  }
}

async function executer(
  reply: FastifyReply,
  machine: (commande: CommandeMfa) => Promise<ResultatMfa>,
  commande: CommandeMfa,
): Promise<FastifyReply> {
  return repondre(reply, await machine(commande));
}

/**
 * Adapter Fastify du second facteur. Il ne possède aucune transition : il normalise les corps et la session,
 * délègue une commande au module MFA, puis traduit son résultat nommé en statut et corps HTTP.
 */
export function registerMfa(
  app: FastifyInstance,
  deps: MfaDeps,
  garde: Guard,
  suite: SuiteDeConnexion,
): void {
  const machine = creerMachineMfa(deps, suite);

  app.post('/auth/mfa/verifier', async (req, reply) => {
    const corps = (req.body ?? {}) as { mfaToken?: unknown; code?: unknown };
    return executer(reply, machine, {
      type: 'verifier_connexion',
      jeton: texte(corps.mfaToken),
      code: texte(corps.code),
    });
  });

  app.post('/auth/mfa/enroler', async (req, reply) => {
    const corps = (req.body ?? {}) as { enrolToken?: unknown };
    return executer(reply, machine, {
      type: 'commencer_enrolement_connexion',
      jeton: texte(corps.enrolToken),
    });
  });

  app.post('/auth/mfa/activer', async (req, reply) => {
    const corps = (req.body ?? {}) as { enrolToken?: unknown; code?: unknown };
    return executer(reply, machine, {
      type: 'activer_connexion',
      jeton: texte(corps.enrolToken),
      code: texte(corps.code),
    });
  });

  const opts = { preHandler: garde };

  app.get('/auth/mfa/moi', opts, async (req, reply) =>
    executer(reply, machine, {
      type: 'lire_compte',
      userId: req.auth?.userId ?? '',
    }));

  app.post('/auth/mfa/moi/enroler', opts, async (req, reply) =>
    executer(reply, machine, {
      type: 'commencer_enrolement_compte',
      userId: req.auth?.userId ?? '',
      motDePasse: texte((req.body as { motDePasse?: unknown } | undefined)?.motDePasse),
    }));

  app.post('/auth/mfa/moi/activer', opts, async (req, reply) =>
    executer(reply, machine, {
      type: 'activer_compte',
      userId: req.auth?.userId ?? '',
      code: texte((req.body as { code?: unknown } | undefined)?.code),
    }));

  app.post('/auth/mfa/moi/codes', opts, async (req, reply) =>
    executer(reply, machine, {
      type: 'regenerer_codes',
      userId: req.auth?.userId ?? '',
      code: texte((req.body as { code?: unknown } | undefined)?.code),
    }));

  app.post('/auth/mfa/moi/desactiver', opts, async (req, reply) =>
    executer(reply, machine, {
      type: 'desactiver_compte',
      userId: req.auth?.userId ?? '',
      code: texte((req.body as { code?: unknown } | undefined)?.code),
    }));
}
