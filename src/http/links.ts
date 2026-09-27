import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isSendableButtonUrl } from '../meta/button-url';
import { estClicAutomatique } from '../links/clic-automatique';
import { estJeton } from '../links/jeton-contact';
import type { DestinationLien } from '../links/tracked-links.pg';
import { journaliser } from '../lib/journal';
import { escapeHtml as echappe } from '../crm/render';

/**
 * Redirection publique des liens tracés : `GET /r/:code` -> 302 vers la destination, après avoir compté le clic.
 * Route non authentifiée (un destinataire WhatsApp l'ouvre), d'où trois règles :
 *  1. 🔴 `scopeTenant` est inutilisable (pas de `req.auth`) : l'espace vient du code lui-même, retrouvé en base.
 *  2. Surface d'open redirect : la destination, validée à l'écriture, est revalidée à la lecture.
 *  3. Jamais de 5xx pour un humain : Cloudflare remplacerait le corps par sa page d'erreur.
 */

export interface LinksRouteDeps {
  /** Destination d'un code, ou null si le code n'existe pas. */
  getByCode(code: string): Promise<DestinationLien | null>;
  /**
   * Enregistre le clic, au mieux : son échec ne doit jamais empêcher la redirection. `contactId` = qui a cliqué,
   * quand l'URL portait un jeton ; `null` sinon (les templates anciens ont une adresse figée chez Meta, sans jeton).
   */
  recordClick(code: string, tenantId: string, contactId?: string | null): Promise<void>;
  /**
   * Résout un jeton public en identifiant de contact, dans l'espace du lien. `null` = jeton inconnu.
   * 🔴 `tenantId` vient du lien, pas de l'URL : le contact d'un autre espace ne s'attribue pas ce clic.
   */
  contactParJeton(tenantId: string, jeton: string): Promise<string | null>;
  /**
   * Remonte le clic comme signal, seulement quand on sait qui a cliqué (un clic anonyme n'a pas de fiche). Requise :
   * la redirection est le seul endroit où le clic se sait. Elle n'est pas attendue (contrairement à `recordClick`) :
   * lecture en base et enfilement s'ajouteraient au chemin de chaque lien ; sa panne se journalise.
   */
  signalerClic(tenantId: string, contactId: string, code: string): Promise<void>;
}

/** Un code est 12 caractères base32 minuscules. Tout le reste est refusé sans toucher la base. */
const CODE_RE = /^[0-9a-hjkmnp-tv-z]{12}$/;

/** Page d'erreur minimale : lisible par un humain qui vient de cliquer, sans rien révéler de l'espace. */
function pageErreur(titre: string, message: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${echappe(titre)}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f6f7f9;color:#2b3245">`
    + `<div style="max-width:28rem;padding:2rem;text-align:center">`
    + `<h1 style="font-size:1.1rem;margin:0 0 .5rem">${echappe(titre)}</h1>`
    + `<p style="margin:0;color:#6b7280;font-size:.9rem">${echappe(message)}</p>`
    + `</div></body></html>`;
}

export function registerLinks(app: FastifyInstance, deps: LinksRouteDeps): void {
  /**
   * 🔴 Deux formes, et la première ne disparaîtra jamais : `/r/:code` circule dans des messages déjà livrés (URL
   * figée chez Meta), la retirer casserait ces liens sans recours ; leurs clics restent anonymes. `/r/:code/:jeton`
   * est la forme attribuée (templates récents, messages RCS). Un seul traitement : deux finiraient par diverger.
   */
  const traiter = async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const { code, jeton } = req.params as { code: string; jeton?: string };
    const normalise = typeof code === 'string' ? code.trim().toLowerCase() : '';

    // Forme du code vérifiée avant la base : un lien public reçoit robots et scans, pas de requête SQL par essai.
    if (!CODE_RE.test(normalise)) {
      return reply.code(404).type('text/html; charset=utf-8').send(pageErreur('Lien introuvable', "Ce lien n'existe pas ou n'est plus actif."));
    }

    const lien = await deps.getByCode(normalise);
    if (!lien) {
      return reply.code(404).type('text/html; charset=utf-8').send(pageErreur('Lien introuvable', "Ce lien n'existe pas ou n'est plus actif."));
    }

    // Revalidation à la lecture : notre domaine ne sert pas de tremplin si une destination a été écrite avant un
    // durcissement de la règle, ou modifiée hors de la console.
    if (!isSendableButtonUrl(lien.destination)) {
      return reply.code(422).type('text/html; charset=utf-8').send(pageErreur('Lien invalide', "La destination de ce lien n'est pas une adresse valide."));
    }

    // Le clic est compté avant la redirection, sans la bloquer en cas d'échec. On ne compte que les clics crédibles
    // mais on redirige toujours : Meta clique chaque bouton URL pendant la revue du template (`estClicAutomatique`).
    if (!estClicAutomatique({
      userAgent: req.headers['user-agent'],
      referer: req.headers.referer,
      parametres: req.query as Record<string, unknown> | null,
    })) {
      // Qui a cliqué : résolu seulement si l'URL portait un jeton bien formé (cette route reçoit aussi des robots).
      let contactId: string | null = null;
      if (estJeton(jeton)) {
        // L'espace vient du lien, jamais de l'URL. Un échec de résolution ne bloque rien : le clic compte sans auteur.
        contactId = await deps.contactParJeton(lien.tenantId, jeton).catch(() => null);
      }
      try {
        await deps.recordClick(normalise, lien.tenantId, contactId);
      } catch (err) {
        journaliser('error', 'clic_non_enregistre', { err, code: normalise, tenantId: lien.tenantId });
      }
      if (contactId !== null) {
        const attribue = contactId;
        // Lancé, jamais attendu (voir `signalerClic`). La fonction `async` enveloppe aussi une levée synchrone du
        // câblage : aucune promesse rejetée ne reste sans gestionnaire.
        void (async () => {
          try {
            await deps.signalerClic(lien.tenantId, attribue, normalise);
          } catch (err) {
            journaliser('error', 'signal_clic_non_emis', { err, code: normalise, tenantId: lien.tenantId });
          }
        })();
      }
    }

    // 302 et non 301 : un 301 est mis en cache par le navigateur, qui n'appellerait plus jamais notre route.
    // On perdrait tous les clics suivants de la même personne, et on ne pourrait plus changer la destination.
    return reply.code(302).header('location', lien.destination).header('cache-control', 'no-store').send();
  };

  app.get('/r/:code', traiter);
  app.get('/r/:code/:jeton', traiter);
}
