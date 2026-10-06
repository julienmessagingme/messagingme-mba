import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PlafondPartage } from '../auth/plafond-partage';
import { creerEspaceParGoogle, freine, rateKey, type ComptesAuthDep } from '../auth/routes';
import type { GoogleIdentity } from '../auth/google';
import { signChoixOauth, signDemandeOauth, verifyChoixOauth, verifyDemandeOauth } from '../auth/token';
import type { CompteurDebit } from '../db/debit';
import { sha256Hex } from '../lib/signature';
import { adresseDeRetourAcceptee, clientConnu } from '../oauth/clients';
import { formeDeDefi, verifierPkce } from '../oauth/pkce';
import {
  DUREE_ACCES_S, DUREE_RENOUVELLEMENT_INACTIF_S, DUREE_RENOUVELLEMENT_MAX_S, formeDeJeton, nouveauJeton,
  PREFIXE_ACCES, PREFIXE_CODE, PREFIXE_RENOUVELLEMENT,
} from '../oauth/jetons';
import { DROITS_OAUTH, metadonneesRessource, metadonneesServeur, ressourceMcp } from '../oauth/metadonnees';
import { autoriser, DEMANDE_EXPIREE, type DepsAutoriser } from '../oauth/autoriser';
import type { PgOauthStore } from '../oauth/store.pg';

/**
 * LE SERVEUR D'AUTORISATION OAUTH 2.1 DEVANT `/mcp` (spec `2026-10-03-oauth-mcp-design.md`, section 1), classe
 * `anonyme` : par construction, personne n'a encore de jeton quand il appelle ces routes.
 *
 * 🔴 RIEN NE SE MONTE SANS `PUBLIC_API_URL` (`base`) : vide, les adresses retombent sur la console, et l'émetteur
 * annoncé serait faux. Toutes ces adresses rendent alors 404. L'émetteur, la ressource et chaque adresse annoncée
 * se dérivent de `base`, jamais de l'en-tête `Host`.
 *
 * Ce que chaque route accepte comme autorité, puisqu'aucune n'a de session :
 * - les métadonnées : rien, elles sont publiques ;
 * - `/oauth/authorize` : rien non plus, elle vérifie la demande et la signe pour la page de consentement (aucune
 *   table de demandes en attente) ;
 * - `/oauth/token` : un code (PKCE) ou un jeton de renouvellement, à usage unique ;
 * - `/oauth/revoke` : le jeton à révoquer lui-même (client public : le détenir est la preuve) ;
 * - le consentement : la demande signée, puis un jeton Google frais, puis la preuve signée qu'il a rendue.
 *
 * 🔴 Les erreurs de `/oauth/token` sont au format OAuth et en 400, jamais en 5xx : Cloudflare remplace le corps
 * d'un 5xx, et Claude ne lirait plus `invalid_grant`. Aucun jeton, code, vérificateur ni empreinte n'entre dans un
 * journal ou une réponse d'erreur.
 */
export interface OauthRouteDeps extends DepsAutoriser {
  store: Pick<PgOauthStore, 'creerAutorisation' | 'consommerCode' | 'poserJetons' | 'renouveler' | 'revoquerParJeton'>;
  /** `getByEmail` pour autoriser, `createTenantWithAdmin` pour l'adresse Google inconnue (`creerEspaceParGoogle`). */
  comptes: Required<Pick<ComptesAuthDep, 'getByEmail' | 'createTenantWithAdmin'>> & Pick<ComptesAuthDep, 'touchLastLogin'>;
  /** Le même vérificateur que `/auth/google` : signature Google, émetteur, audience. L'appelant exige `emailVerified`. */
  verifyGoogle(idToken: string): Promise<GoogleIdentity | null>;
  /** `AUTH_SECRET` : il signe la demande et la preuve, dont le `kind` les écarte de toute session. */
  secret: string;
  /** La console (`APP_URL`), où vit la page de consentement `/autoriser`. */
  appUrl: string;
}

/** Les paramètres de `/oauth/authorize` sans lesquels on ne sait pas vers qui rediriger : refusés sans redirection. */
const Destinataire = z.object({ client_id: z.string(), redirect_uri: z.string() });
/** Le reste de la demande. Un paramètre répété arrive en tableau, et refusé ici (OAuth 2.1 : jamais deux fois). */
const Autorisation = z.object({
  response_type: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  state: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
});

const Echange = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string(),
  redirect_uri: z.string(),
  client_id: z.string(),
  code_verifier: z.string(),
  resource: z.string().optional(),
});
const Renouvellement = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string(),
  client_id: z.string(),
  resource: z.string().optional(),
});

const DemandeSeule = z.object({ demande: z.string().min(1) });
const ParGoogle = z.object({ demande: z.string().min(1), idToken: z.string().min(1) });
const ParPreuve = z.object({ demande: z.string().min(1), choix: z.string().min(1), tenantId: z.string().min(1) });

const DROITS: readonly string[] = DROITS_OAUTH;

export function registerOauth(app: FastifyInstance, deps: OauthRouteDeps, base: string | null, compteur: CompteurDebit): void {
  if (base === null) return;
  const ressource = ressourceMcp(base);
  const pageConsentement = `${deps.appUrl.trim().replace(/\/+$/, '')}/autoriser`;
  /**
   * Deux plafonds, dans le compteur PARTAGÉ, fermés sur panne comme ceux de la connexion (`src/auth/routes.ts`).
   * `jeton` : dix présentations par minute d'un MÊME code ou jeton de renouvellement. Les deux ne servent qu'une
   * fois (code brûlé, jeton tourné), donc tout ce qu'il freine est un échec : un client qui rejoue en boucle un
   * jeton mort. Une clé par jeton, jamais une clé commune : sans l'adresse du client (`rateKey`), une clé commune
   * laisserait n'importe qui couper les renouvellements de tous les Claude connectés.
   * `consentement` : vingt par minute et par jeton Google ou par preuve, comme `/auth/google` (la création d'un
   * espace pour une adresse inconnue passe par ici).
   */
  const plafond = (nom: string, max: number): PlafondPartage =>
    new PlafondPartage(compteur, { nom: `oauth.${nom}`, max, dureeMs: 60_000, siLaBaseEchoue: 'refuser' });
  const plafondJetons = plafond('jeton', 10);
  const plafondConsentement = plafond('consentement', 20);

  // Les métadonnées de la ressource, aux deux adresses : Claude Code lit la racine, la spécification MCP fait
  // essayer la forme à chemin d'abord.
  app.get('/.well-known/oauth-protected-resource', async () => metadonneesRessource(base));
  app.get('/.well-known/oauth-protected-resource/mcp', async () => metadonneesRessource(base));
  app.get('/.well-known/oauth-authorization-server', async () => metadonneesServeur(base));

  void app.register(async (portee) => {
    // Le lecteur de formulaire n'existe que dans cette portée, comme celui de la vitrine : ailleurs, un corps
    // urlencoded reste refusé (415).
    portee.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8_000 }, (_req, corps, fait) => {
      fait(null, Object.fromEntries(new URLSearchParams(String(corps))));
    });
    // Rien de ce que rendent ces routes ne doit rester dans un cache : jetons, preuves, adresses de retour avec code.
    portee.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });

    /**
     * La demande d'autorisation, ouverte dans le navigateur par Claude. Vérifiée ici, puis signée et portée jusqu'à
     * la page de consentement de la console.
     * 🔴 Client ou adresse de retour invalide : AUCUNE redirection (OAuth 2.1, 7.12.2), une page en texte. Rediriger
     * vers une adresse qu'on n'a pas validée ferait de cette route une redirection ouverte, et livrerait l'erreur à
     * qui l'a choisie.
     */
    portee.get('/oauth/authorize', async (req, reply) => {
      const pageErreur = (raison: string) => reply.code(400).type('text/plain; charset=utf-8')
        .send(`Demande d’autorisation refusée : ${raison}.\nRelancez la connexion depuis Claude.\n`);
      const dest = Destinataire.safeParse(req.query);
      if (!dest.success) return pageErreur('client_id et redirect_uri requis');
      const client = clientConnu(dest.data.client_id);
      if (!client) return pageErreur('client inconnu');
      if (!adresseDeRetourAcceptee(client, dest.data.redirect_uri)) return pageErreur('adresse de retour non autorisée pour ce client');
      const redirectUri = dest.data.redirect_uri;

      const lu = Autorisation.safeParse(req.query);
      const state = lu.success ? lu.data.state : undefined;
      // `error_description` en anglais et en ASCII : la RFC 6749 (4.1.2.1 et 5.2) le borne à l'ASCII imprimable.
      const erreur = (code: string, description: string) => {
        const u = new URL(redirectUri);
        u.searchParams.set('error', code);
        u.searchParams.set('error_description', description);
        if (state !== undefined) u.searchParams.set('state', state);
        u.searchParams.set('iss', base);
        return reply.redirect(u.toString(), 302);
      };
      if (!lu.success) return erreur('invalid_request', 'repeated or unreadable parameter');
      const q = lu.data;
      if (q.response_type !== 'code') return erreur('unsupported_response_type', 'only response_type=code is supported');
      if (q.code_challenge_method !== 'S256' || q.code_challenge === undefined || !formeDeDefi(q.code_challenge)) {
        return erreur('invalid_request', 'PKCE required: S256 code_challenge');
      }
      if (q.state === undefined || q.state === '') return erreur('invalid_request', 'state required');
      // Absent ou vide : les deux droits. Un droit inconnu est refusé, jamais ignoré.
      const demandes = (q.scope ?? '').split(' ').filter((s) => s !== '');
      const scopes = demandes.length === 0 ? [...DROITS] : [...new Set(demandes)];
      if (scopes.some((s) => !DROITS.includes(s))) return erreur('invalid_scope', `supported scopes: ${DROITS.join(' ')}`);
      // RFC 8707 : la ressource demandée, si elle l'est, doit être la nôtre au caractère près.
      if (q.resource !== undefined && q.resource !== ressource) return erreur('invalid_target', `supported resource: ${ressource}`);

      const demande = await signDemandeOauth({
        clientId: client.id, redirectUri, codeChallenge: q.code_challenge, scopes, state: q.state, resource: ressource,
      }, deps.secret);
      return reply.redirect(`${pageConsentement}?demande=${encodeURIComponent(demande)}`, 302);
    });

    /**
     * L'échange : un code contre la première paire de jetons, ou un jeton de renouvellement contre la suivante.
     * Le contrôle de FORME précède le plafond et la base : une rafale de `mbc_x` ne coûte rien.
     */
    portee.post('/oauth/token', async (req, reply) => {
      const refus = (error: string, description: string) => reply.code(400).send({ error, error_description: description });
      const grant = z.object({ grant_type: z.string() }).safeParse(req.body);
      if (!grant.success) return refus('invalid_request', 'grant_type required');
      const paire = () => {
        const maintenant = Date.now();
        const acces = nouveauJeton(PREFIXE_ACCES);
        const refresh = nouveauJeton(PREFIXE_RENOUVELLEMENT);
        return {
          acces, refresh, maintenant,
          empreintes: {
            acces: acces.empreinte, refresh: refresh.empreinte,
            accesExpireLe: new Date(maintenant + DUREE_ACCES_S * 1000),
            refreshExpireLe: new Date(maintenant + DUREE_RENOUVELLEMENT_INACTIF_S * 1000),
          },
        };
      };
      const corpsJetons = (acces: string, refresh: string) => ({
        access_token: acces, token_type: 'Bearer', expires_in: DUREE_ACCES_S, refresh_token: refresh,
      });

      if (grant.data.grant_type === 'authorization_code') {
        const lu = Echange.safeParse(req.body);
        if (!lu.success) return refus('invalid_request', 'code, redirect_uri, client_id and code_verifier required');
        const e = lu.data;
        if (!clientConnu(e.client_id)) return refus('invalid_client', 'unknown client');
        if (!formeDeJeton(e.code, PREFIXE_CODE)) return refus('invalid_grant', 'invalid, expired or already used code');
        if (await freine(plafondJetons, rateKey(req, e.code), reply)) return reply;
        // 🔴 Le code est consommé AVANT les comparaisons : un vérificateur faux le brûle aussi, un vérificateur ne
        // se devine donc pas en plusieurs essais. Même réponse pour toutes les causes.
        const c = await deps.store.consommerCode(sha256Hex(e.code));
        if (!c || c.clientId !== e.client_id || c.redirectUri !== e.redirect_uri || !verifierPkce(e.code_verifier, c.challenge)) {
          return refus('invalid_grant', 'invalid, expired or already used code');
        }
        if (e.resource !== undefined && e.resource !== c.resource) return refus('invalid_target', `supported resource: ${c.resource}`);
        const p = paire();
        const pose = await deps.store.poserJetons(c.autorisationId, {
          ...p.empreintes, refreshMaxLe: new Date(p.maintenant + DUREE_RENOUVELLEMENT_MAX_S * 1000),
        });
        if (!pose) return refus('invalid_grant', 'authorization revoked');
        return reply.code(200).send({ ...corpsJetons(p.acces.brut, p.refresh.brut), scope: c.scopes.join(' ') });
      }

      if (grant.data.grant_type === 'refresh_token') {
        const lu = Renouvellement.safeParse(req.body);
        if (!lu.success) return refus('invalid_request', 'refresh_token and client_id required');
        const r = lu.data;
        if (!clientConnu(r.client_id)) return refus('invalid_client', 'unknown client');
        if (r.resource !== undefined && r.resource !== ressource) return refus('invalid_target', `supported resource: ${ressource}`);
        if (!formeDeJeton(r.refresh_token, PREFIXE_RENOUVELLEMENT)) return refus('invalid_grant', 'invalid refresh token');
        if (await freine(plafondJetons, rateKey(req, r.refresh_token), reply)) return reply;
        const p = paire();
        // 🔴 Un ANCIEN jeton présenté révoque toute l'autorisation (`PgOauthStore.renouveler`, RFC 9700 4.14) :
        // Claude reçoit `invalid_grant` et redemande une connexion. `scope` absent de la réponse : il est celui
        // accordé (RFC 6749, 5.1), le `scope` d'une demande de renouvellement n'étant pas lu.
        const issue = await deps.store.renouveler(sha256Hex(r.refresh_token), r.client_id, p.empreintes);
        if (issue !== 'ok') return refus('invalid_grant', 'invalid, expired or revoked refresh token');
        return reply.code(200).send(corpsJetons(p.acces.brut, p.refresh.brut));
      }

      return refus('unsupported_grant_type', 'supported grant types: authorization_code, refresh_token');
    });

    /**
     * La révocation par le client (RFC 7009) : toujours 200, qu'il soit connu ou non, pour ne rien apprendre à qui
     * essaie. Son jeton d'accès ou de renouvellement révoque toute l'autorisation. Seule une forme valide atteint
     * la base.
     */
    portee.post('/oauth/revoke', async (req, reply) => {
      const lu = z.object({ token: z.string() }).safeParse(req.body);
      if (lu.success && (formeDeJeton(lu.data.token, PREFIXE_ACCES) || formeDeJeton(lu.data.token, PREFIXE_RENOUVELLEMENT))) {
        await deps.store.revoquerParJeton(sha256Hex(lu.data.token));
      }
      return reply.code(200).send();
    });

    /**
     * Ce que la page de consentement affiche AVANT tout bouton : le client, l'hôte de retour (exigé par la
     * spécification MCP) et les droits. Rien d'autre ne sort de la demande.
     */
    portee.post('/oauth/consentement/demande', async (req, reply) => {
      const lu = DemandeSeule.safeParse(req.body);
      if (!lu.success) return reply.code(400).send({ error: 'demande requise' });
      const demande = await verifyDemandeOauth(lu.data.demande, deps.secret);
      if (!demande) return reply.code(400).send(DEMANDE_EXPIREE);
      return reply.code(200).send({
        client: clientConnu(demande.clientId)?.nom ?? demande.clientId,
        hoteDeRetour: new URL(demande.redirectUri).hostname,
        droits: demande.scopes,
      });
    });

    /**
     * « Continuer avec Google » sur la page de consentement. Adresse inconnue : son espace et son admin naissent par
     * le MÊME chemin que `/auth/google` (`creerEspaceParGoogle`). Rend la preuve signée, liée à CETTE demande, et
     * les espaces de la personne : `admin` dit sur lesquels elle peut autoriser, le rôle sera relu au clic.
     */
    portee.post('/oauth/consentement/google', async (req, reply) => {
      const lu = ParGoogle.safeParse(req.body);
      if (!lu.success) return reply.code(400).send({ error: 'demande et idToken requis' });
      if (!(await verifyDemandeOauth(lu.data.demande, deps.secret))) return reply.code(400).send(DEMANDE_EXPIREE);
      // Avant la vérification Google, comme `/auth/google` : la clé est le jeton présenté.
      if (await freine(plafondConsentement, rateKey(req, lu.data.idToken), reply)) return reply;
      const identite = await deps.verifyGoogle(lu.data.idToken);
      if (!identite?.emailVerified) return reply.code(401).send({ error: 'jeton Google invalide' });
      const tous = await deps.comptes.getByEmail(identite.email);
      let actifs = tous.filter((c) => !c.disabled);
      if (tous.length > 0 && actifs.length === 0) return reply.code(403).send({ error: 'compte révoqué' });
      const nouveau = tous.length === 0;
      if (nouveau) {
        // L'espace naît ici par la connexion de Claude Code : son origine fixe le crédit offert à 1 € (0212).
        const cree = await creerEspaceParGoogle(deps.comptes, identite, 'claude_code');
        actifs = [{ id: cree.userId, tenantId: cree.tenantId, tenantName: cree.tenantName, role: 'admin', disabled: false }];
      }
      const choix = await signChoixOauth({ email: identite.email, demande: sha256Hex(lu.data.demande) }, deps.secret);
      return reply.code(200).send({
        choix,
        nouveau,
        espaces: actifs.map((c) => ({ tenantId: c.tenantId, nom: c.tenantName, admin: c.role === 'admin' })),
      });
    });

    /** Le clic « Autoriser dans <espace> » après Google : la preuve, la demande à laquelle elle répond, l'espace. */
    portee.post('/oauth/consentement/autoriser', async (req, reply) => {
      const lu = ParPreuve.safeParse(req.body);
      if (!lu.success) return reply.code(400).send({ error: 'demande, choix et tenantId requis' });
      const demande = await verifyDemandeOauth(lu.data.demande, deps.secret);
      if (!demande) return reply.code(400).send(DEMANDE_EXPIREE);
      const choix = await verifyChoixOauth(lu.data.choix, deps.secret);
      // 🔴 La preuve répond à CETTE demande : obtenue pour une autre (un autre client, une autre adresse de retour),
      // elle n'autorise rien ici.
      if (!choix || choix.demande !== sha256Hex(lu.data.demande)) {
        return reply.code(401).send({ error: 'connexion Google expirée : reconnectez-vous' });
      }
      if (await freine(plafondConsentement, rateKey(req, lu.data.choix), reply)) return reply;
      const r = await autoriser(deps, base, { email: choix.email }, lu.data.tenantId, demande);
      return r.ok ? reply.code(200).send({ adresse: r.adresse }) : reply.code(403).send({ error: r.erreur });
    });
  });
}
