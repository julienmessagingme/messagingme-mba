import type { FastifyInstance } from 'fastify';
import { escapeHtml } from '../crm/render';
import { journaliser } from '../lib/journal';
import type { CategorieCoupable } from '../emails-produit/catalogue';

/**
 * LE LIEN DE DÉSINSCRIPTION DES E-MAILS DU PRODUIT (lot 7), classe `code-url` : le jeton signé de l'adresse autorise, et
 * il ne permet que de couper UNE catégorie pour UNE personne (`src/emails-produit/desinscription.ts`).
 *
 * 🔴 LE GET N'ÉCRIT RIEN. Les messageries et les antivirus d'entreprise ouvrent les liens d'un e-mail pour les analyser :
 * un GET qui désinscrirait couperait les e-mails de quelqu'un qui n'a rien demandé. Il montre une page avec un bouton ;
 * c'est le POST qui désinscrit, celui du bouton comme celui de l'envoi en un clic des messageries (`List-Unsubscribe-Post`,
 * RFC 8058), qui POSTe sur l'adresse de `List-Unsubscribe`. La page est la même dans les deux langues : la personne n'est
 * pas connue avant le POST, et la lire en base sur un GET servirait d'oracle.
 */

export interface DesinscriptionRouteDeps {
  /**
   * Ce qu'un jeton désigne, `null` s'il est mal formé ou mal signé : `lireJetonDesinscription` avec `AUTH_SECRET` en
   * production. Une dépendance et pas un secret : c'est elle que la sonde 11 de l'auto-attaque doit atteindre.
   */
  lire(jeton: string): { identityId: string; categorie: CategorieCoupable } | null | Promise<{ identityId: string; categorie: CategorieCoupable } | null>;
  desinscrire(identityId: string, categorie: CategorieCoupable): Promise<void>;
}

const QUOI: Record<CategorieCoupable, { fr: string; en: string }> = {
  commercial: { fr: 'les e-mails d’information de Messaging Me (bienvenue, conseils, récapitulatif)', en: 'Messaging Me news e-mails (welcome, tips, weekly summary)' },
  transfert: { fr: 'les e-mails « une conversation attend votre équipe »', en: '“a conversation is waiting for your team” e-mails' },
};

function page(titre: string, corps: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(titre)}</title>
<style>body{margin:0;background:#f4f6fb;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#2b2f36}
main{max-width:520px;margin:48px auto;padding:28px 24px;background:#fff;border:1px solid #e6e9f0;border-radius:14px}
h1{font-size:20px;color:#181C40;margin:0 0 14px}p{line-height:1.5;margin:0 0 12px}
button{background:#009AFE;color:#fff;border:0;border-radius:10px;padding:12px 22px;font-size:15px;font-weight:700;cursor:pointer}
.en{color:#6b7280;font-size:14px;margin-top:20px;border-top:1px solid #e6e9f0;padding-top:16px}</style></head>
<body><main>${corps}</main></body></html>`;
}

const INVALIDE = page('Lien invalide', '<h1>Ce lien n’est pas valide</h1><p>Il a peut-être été coupé en route. Vos préférences d’e-mails se règlent aussi dans « Mon compte » de la console.</p><p class="en">This link is not valid. You can also manage your e-mail preferences in “My account” in the console.</p>');

export function registerDesinscriptionEmails(app: FastifyInstance, deps: DesinscriptionRouteDeps): void {
  void app.register(async (portee) => {
    // L'envoi en un clic des messageries POSTe un formulaire (`List-Unsubscribe=One-Click`) : le corps ne sert à rien,
    // seul le jeton de l'adresse compte. Accepté sous toute forme, dans cette portée seulement.
    portee.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 4096 }, (_req, _corps, fait) => { fait(null, {}); });

    portee.get('/e/desinscription/:code', async (req, reply) => {
      const lu = await deps.lire(String((req.params as { code?: unknown }).code ?? ''));
      reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex').type('text/html; charset=utf-8');
      if (lu === null) return reply.code(404).send(INVALIDE);
      const quoi = QUOI[lu.categorie];
      // Le formulaire POSTe sur la même adresse (action vide) : rien à recalculer, aucune adresse dans la page.
      return reply.code(200).send(page('Se désinscrire', `<h1>Ne plus recevoir ces e-mails ?</h1>
<p>Vous ne recevrez plus ${escapeHtml(quoi.fr)}. Les alertes de service (crédit, numéro, limites) continuent : elles disent quand un geste est nécessaire.</p>
<form method="post" action=""><button type="submit">Me désinscrire / Unsubscribe</button></form>
<p class="en">You will no longer receive ${escapeHtml(quoi.en)}. Service alerts (credit, number, limits) continue.</p>`));
    });

    portee.post('/e/desinscription/:code', async (req, reply) => {
      const lu = await deps.lire(String((req.params as { code?: unknown }).code ?? ''));
      reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex').type('text/html; charset=utf-8');
      if (lu === null) return reply.code(404).send(INVALIDE);
      await deps.desinscrire(lu.identityId, lu.categorie);
      journaliser('info', 'email_produit_desinscription', { identityId: lu.identityId, categorie: lu.categorie });
      return reply.code(200).send(page('Désinscription faite', `<h1>C’est fait</h1>
<p>Vous ne recevrez plus ${escapeHtml(QUOI[lu.categorie].fr)}. Vous pouvez les rétablir dans « Mon compte » de la console.</p>
<p class="en">Done: you will no longer receive ${escapeHtml(QUOI[lu.categorie].en)}. You can turn them back on in “My account” in the console.</p>`));
    });
  });
}
