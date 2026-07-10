/**
 * Construit le tableau `components` d'un envoi de template (header média + variables du corps),
 * au format attendu par l'API Cloud. Extrait pour être testable (l'ancien inline dans index.ts
 * codait le header en dur en `image`, cassant les headers VIDEO/DOCUMENT).
 */
export interface OutboundTemplateParts {
  bodyParams: string[];
  /** URL publique du média de header, si le template a un header média. */
  headerMediaUrl?: string;
  /** Format du header média (défaut IMAGE si absent mais URL fournie). */
  headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
}

export function buildTemplateComponents(tpl: OutboundTemplateParts): unknown[] {
  const components: unknown[] = [];
  if (tpl.headerMediaUrl) {
    const key = tpl.headerFormat === 'VIDEO' ? 'video' : tpl.headerFormat === 'DOCUMENT' ? 'document' : 'image';
    components.push({ type: 'header', parameters: [{ type: key, [key]: { link: tpl.headerMediaUrl } }] });
  }
  if (tpl.bodyParams.length > 0) {
    components.push({ type: 'body', parameters: tpl.bodyParams.map((v) => ({ type: 'text', text: v })) });
  }
  return components;
}
