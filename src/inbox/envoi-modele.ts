import { buildTemplateComponents } from '../meta/template-components';
import type { TemplateSpec } from '../meta/types';
import type { InboxRouteDeps } from '../http/inbox';
import type { PgTrackedLinkStore } from '../links/tracked-links.pg';
import { suffixesPourUnEnvoi } from '../links/suffixes-envoi';
import { messageDe } from '../lib/erreur';

/**
 * L'envoi manuel d'un template depuis l'Inbox (`POST .../send-template`), construit une fois par le câblage.
 *
 * 🔴 IL PORTE LES SUFFIXES DES BOUTONS TRACÉS, comme la campagne et le bloc de scénario. Un template créé ici depuis
 * le 2026-09-02 soumet ses boutons « Lien » sous la forme `/r/<code>/{{1}}` : sans le composant `url` qui remplit ce
 * `{{1}}`, Meta refuse le message entier (131008). L'Inbox l'omettait, donc aucun template à lien tracé ne partait
 * à la main. Le jeton est celui du contact de la conversation : son clic lui est rattaché, et une adresse à champs
 * (`{numero_commande}`) se remplit avec SA fiche.
 */
export interface DepsEnvoiModeleInbox {
  /** Le client Meta du numéro de l'espace (jeton de l'espace, repli global). */
  client(tenantId: string, phoneNumberId: string): Promise<{ sendTemplate(to: string, spec: TemplateSpec): Promise<{ messageId: string }> }>;
  /** Les liens tracés du template, et le jeton public du contact. */
  trackedLinks: Pick<PgTrackedLinkStore, 'listByTemplates' | 'jetonPourE164'>;
}

export function creerEnvoiModeleInbox(deps: DepsEnvoiModeleInbox): InboxRouteDeps['sendTemplateMessage'] {
  return async (tenant, phoneNumberId, to, tpl) => {
    const client = await deps.client(tenant, phoneNumberId);
    let suffixes: { suffixesBoutons?: Record<number, string> } = {};
    try {
      suffixes = await suffixesPourUnEnvoi(deps.trackedLinks, tenant, tpl.name, to);
    } catch (err) {
      // Illisibles : on ne sait pas si ce template attend un jeton. On part sans, et on le dit, sinon un 131008
      // resterait inexpliqué.
      // eslint-disable-next-line no-console
      console.error(`inbox sendTemplate: liens tracés de « ${tpl.name} » illisibles:`, messageDe(err));
    }
    const components = buildTemplateComponents({
      bodyParams: tpl.bodyParams,
      ...(tpl.headerMediaUrl ? { headerMediaUrl: tpl.headerMediaUrl } : {}),
      ...(tpl.headerFormat ? { headerFormat: tpl.headerFormat } : {}),
      ...(tpl.carousel ? { carousel: tpl.carousel } : {}),
      ...suffixes,
    });
    const spec = { name: tpl.name, language: tpl.language, ...(components.length > 0 ? { components } : {}) };
    return (await client.sendTemplate(to, spec)).messageId;
  };
}
