import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isSendableButtonUrl } from '../meta/button-url';
import { estClicAutomatique } from '../links/clic-automatique';
import { estJeton } from '../links/jeton-contact';
import type { DestinationLien } from '../links/tracked-links.pg';
import { journaliser } from '../lib/journal';

/**
 * Redirection publique des liens tracés : `GET /r/:code` -> 302 vers la destination d'origine, après avoir
 * compté le clic.
 *
 * ⚠️ Route PUBLIQUE et non authentifiée : c'est un destinataire WhatsApp qui l'ouvre, il n'a pas de session.
 * Trois conséquences qui commandent tout ce fichier :
 *
 *  1. `scopeTenant` est INUTILISABLE ici. Sans `req.auth`, elle rend le tenant de l'URL sans le vérifier. Le
 *     tenant vient donc du CODE lui-même, retrouvé en base : c'est la seule preuve disponible.
 *  2. C'est une surface d'OPEN REDIRECT. La destination a été validée à l'écriture, mais on la REVALIDE à la
 *     lecture : une ligne modifiée hors console, ou une règle durcie depuis, ne doit pas transformer notre
 *     domaine en tremplin. Précédent maison : `src/http/mba.ts` revalide chaque saut.
 *  3. Jamais de 5xx pour un humain : Cloudflare remplace le corps de toute réponse 5xx par sa propre page
 *     d'erreur, et le destinataire verrait une erreur de plateforme au lieu d'un message compréhensible.
 */

export interface LinksRouteDeps {
  /** Destination d'un code, ou null si le code n'existe pas. */
  getByCode(code: string): Promise<DestinationLien | null>;
  /**
   * Enregistre le clic. Best-effort : son échec ne doit JAMAIS empêcher la redirection.
   *
   * `contactId` = QUI a cliqué, quand l'URL portait un jeton. `null` quand elle n'en portait pas : c'est le
   * cas de tous les templates approuvés avant le 2026-09-02, dont l'adresse est figée chez Meta et ne pourra
   * jamais en porter. Compter ces clics-là sans savoir qui vaut mieux que ne pas les compter.
   */
  recordClick(code: string, tenantId: string, contactId?: string | null): Promise<void>;
  /**
   * Résout un jeton public en identifiant de contact, dans l'espace du lien. `null` = jeton inconnu.
   *
   * ⚠️ `tenantId` vient du LIEN, pas de l'URL : un jeton qui désignerait un contact d'un autre espace ne doit
   * pas se voir attribuer ce clic-ci. Optionnelle : absente, les clics restent anonymes, ce qui est
   * exactement le comportement d'avant.
   */
  contactParJeton?(tenantId: string, jeton: string): Promise<string | null>;
}

/** Un code est 12 caractères base32 minuscules. Tout le reste est refusé sans toucher la base. */
const CODE_RE = /^[0-9a-hjkmnp-tv-z]{12}$/;

/** Page d'erreur minimale : lisible par un humain qui vient de cliquer, sans rien révéler de l'espace. */
function pageErreur(titre: string, message: string): string {
  const echappe = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
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
   * 🔴 DEUX FORMES, ET LA PREMIÈRE NE DISPARAÎTRA JAMAIS.
   *
   * `/r/:code` circule dans des messages DÉJÀ LIVRÉS, portés par des templates approuvés dont Meta a figé
   * l'URL. La retirer casserait tous ces liens, sans recours (cf. la porte à sens unique du CLAUDE.md). Elle
   * reste donc, et ses clics restent anonymes : c'est physique, pas un choix.
   *
   * `/r/:code/:jeton` est la forme ATTRIBUÉE, celle des templates soumis après le 2026-09-02 et de tous les
   * messages RCS, qui n'ont eux rien à resoumettre puisqu'ils sont composés à l'envoi.
   *
   * Un seul traitement pour les deux : le jeton n'ajoute qu'une résolution, tout le reste (garde de forme,
   * revalidation de la destination, filtre des clics automatiques, 302) est identique. Deux gestionnaires
   * séparés finiraient par ne plus rediriger pareil.
   */
  const traiter = async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const { code, jeton } = req.params as { code: string; jeton?: string };
    const normalise = typeof code === 'string' ? code.trim().toLowerCase() : '';

    // Forme du code vérifiée AVANT la base : un lien public reçoit aussi des robots et des scans, et il n'y a
    // aucune raison de leur offrir une requête SQL par essai.
    if (!CODE_RE.test(normalise)) {
      return reply.code(404).type('text/html; charset=utf-8').send(pageErreur('Lien introuvable', "Ce lien n'existe pas ou n'est plus actif."));
    }

    const lien = await deps.getByCode(normalise);
    if (!lien) {
      return reply.code(404).type('text/html; charset=utf-8').send(pageErreur('Lien introuvable', "Ce lien n'existe pas ou n'est plus actif."));
    }

    // Revalidation À LA LECTURE : c'est elle qui empêche notre domaine de servir de tremplin si une
    // destination a été écrite avant un durcissement de la règle, ou modifiée hors de la console.
    if (!isSendableButtonUrl(lien.destination)) {
      return reply.code(422).type('text/html; charset=utf-8').send(pageErreur('Lien invalide', "La destination de ce lien n'est pas une adresse valide."));
    }

    // Le clic est compté AVANT la redirection mais son échec ne la bloque pas : mieux vaut un clic non
    // compté qu'un destinataire bloqué sur une erreur.
    //
    // ⚠️ On ne COMPTE que les clics crédibles, mais on REDIRIGE toujours. Meta explore puis fait cliquer
    // chaque bouton URL pendant la revue du template, donc avant le moindre envoi : 70 faux clics mesurés
    // sur le premier lien de la production le 2026-08-21. Voir `estClicAutomatique`.
    if (!estClicAutomatique({
      userAgent: req.headers['user-agent'],
      referer: req.headers.referer,
      parametres: req.query as Record<string, unknown> | null,
    })) {
      // QUI a cliqué. Résolu seulement si l'URL portait un jeton BIEN FORMÉ : un jeton mal formé ne vaut pas
      // un aller-retour en base, cette route recevant aussi des robots et des scans.
      let contactId: string | null = null;
      if (estJeton(jeton) && deps.contactParJeton) {
        // ⚠️ L'espace vient du LIEN, jamais de l'URL : un jeton d'un autre client ne doit pas s'attribuer ce
        // clic-ci. Et l'échec de la résolution ne bloque rien : on compte le clic sans savoir qui.
        contactId = await deps.contactParJeton(lien.tenantId, jeton).catch(() => null);
      }
      try {
        await deps.recordClick(normalise, lien.tenantId, contactId);
      } catch (err) {
        journaliser('error', 'clic_non_enregistre', { err, code: normalise });
      }
    }

    // 302 et non 301 : un 301 est mis en cache par le navigateur, qui n'appellerait plus jamais notre route.
    // On perdrait tous les clics suivants de la même personne, et on ne pourrait plus changer la destination.
    return reply.code(302).header('location', lien.destination).header('cache-control', 'no-store').send();
  };

  app.get('/r/:code', traiter);
  app.get('/r/:code/:jeton', traiter);
}
