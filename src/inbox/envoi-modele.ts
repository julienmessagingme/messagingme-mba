import { buildTemplateComponents } from '../meta/template-components';
import { messagingTarget, type MarketingParams, type TemplateSpec } from '../meta/types';
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
  /**
   * Le client Meta du numéro de l'espace (jeton de l'espace, repli global). `sendMarketing` porte un modèle déclaré
   * marketing : c'est lui qui prend la Marketing Messages API quand `META_MM_LITE` est allumé (plan du 2026-10-14).
   */
  client(tenantId: string, phoneNumberId: string): Promise<{
    sendTemplate(to: string, spec: TemplateSpec): Promise<{ messageId: string }>;
    sendMarketing(params: MarketingParams): Promise<{ messageId: string }>;
  }>;
  /** Les liens tracés du template, et le jeton public du contact. */
  trackedLinks: Pick<PgTrackedLinkStore, 'listByTemplates' | 'jetonPourE164'>;
  /**
   * 🔴 Le `media id` du visuel d'en-tête du MODÈLE, re-téléversé sur le numéro d'envoi (`prepareHeaderMedia`), ou `null`
   * si le modèle n'a pas de visuel à lui. L'URL que l'écran passe est celle du CDN de Meta, lue dans la liste : acceptée
   * puis refusée deux secondes plus tard en 131053 (invariant 9 du manuel, relecture du sous-lot « relancer »). Le bloc
   * de scénario et la campagne envoyaient déjà le `media id` ; l'Inbox, non.
   */
  mediaDuModele(tenantId: string, name: string, language: string): Promise<string | null>;
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
    // L'en-tête du modèle part en `media id` ; une préparation impossible retombe sur l'adresse de l'écran, comme avant.
    let headerMediaId = tpl.headerMediaId;
    if (!headerMediaId && tpl.headerMediaUrl && !tpl.carousel) {
      try {
        headerMediaId = (await deps.mediaDuModele(tenant, tpl.name, tpl.language)) ?? undefined;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`inbox sendTemplate: visuel d'en-tête de « ${tpl.name} » non préparé, envoi par l'adresse :`, messageDe(err));
      }
    }
    const components = buildTemplateComponents({
      bodyParams: tpl.bodyParams,
      ...(headerMediaId ? { headerMediaId } : {}),
      ...(tpl.headerMediaUrl ? { headerMediaUrl: tpl.headerMediaUrl } : {}),
      ...(tpl.headerFormat ? { headerFormat: tpl.headerFormat } : {}),
      ...(tpl.carousel ? { carousel: tpl.carousel } : {}),
      ...suffixes,
    });
    const spec = { name: tpl.name, language: tpl.language, ...(components.length > 0 ? { components } : {}) };
    const res = tpl.templateCategory === 'marketing'
      ? await client.sendMarketing({ ...messagingTarget(to), template: spec })
      : await client.sendTemplate(to, spec);
    return res.messageId;
  };
}
