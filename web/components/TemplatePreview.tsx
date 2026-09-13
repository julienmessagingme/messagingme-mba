'use client';

import { CarouselPreview } from '@/components/CarouselPreview';
import { WhatsAppPreview } from '@/components/WhatsAppPreview';
import type { TemplateSummary } from '@/lib/api';

/**
 * Aperçu d'un template DÉJÀ CRÉÉ : carousel ou classique. Le choix se fait sur le CONTENU du template, pas
 * sur l'écran qui l'affiche, donc les trois endroits qui montrent un template approuvé (envoi depuis l'inbox,
 * campagne directe, campagne par scénario) montrent la même chose.
 *
 * ⚠️ Les URL des visuels de carte viennent du CDN de Meta et EXPIRENT : elles se lisent au moment de
 * l'affichage (via `listTemplates`), jamais depuis un stockage local.
 */
export function TemplatePreview({
  template,
  examples,
  senderName,
}: {
  /**
   * ⚠️ L'EN-TÊTE ET LE PIED SONT DANS LA LISTE DEPUIS LE 2026-09-13, et ils étaient le seul morceau du
   * modèle que cet aperçu-ci jetait. L'écran Templates les affiche depuis toujours (il appelle
   * `WhatsAppPreview` directement) : les campagnes montraient donc une bulle SANS le visuel d'en-tête
   * que le destinataire recevra, ce qui est exactement l'inverse de ce qu'un aperçu promet.
   *
   * ⚠️ TOUS OPTIONNELS, donc aucun appelant existant ne change : l'Inbox passe un littéral sans en-tête
   * et rend la même chose qu'avant.
   */
  template: Pick<TemplateSummary, 'body' | 'buttons' | 'carousel'>
    & Partial<Pick<TemplateSummary, 'headerFormat' | 'headerText' | 'headerMediaUrl' | 'footer'>>;
  /** Valeurs des variables `{{n}}` du corps (le corps d'un carousel est son message d'introduction). */
  examples: string[];
  /**
   * Nom vérifié du numéro ÉMETTEUR, quand l'écran sait lequel c'est. Absent, `PhoneFrame` le résout seul.
   * N'a d'intérêt que sur un espace multi-numéros : y montrer le nom d'un AUTRE numéro que celui qui va
   * envoyer serait exactement le défaut qu'on corrige.
   */
  senderName?: string;
}) {
  if (template.carousel) {
    return (
      <CarouselPreview
        body={template.body ?? ''}
        examples={examples}
        {...(senderName ? { senderName } : {})}
        cards={template.carousel.cards.map((c) => ({
          ...(c.mediaUrl ? { imageUrl: c.mediaUrl } : {}),
          ...(c.mediaFormat ? { mediaFormat: c.mediaFormat } : {}),
          ...(c.body ? { body: c.body } : {}),
          ...(c.buttons ? { buttons: c.buttons } : {}),
        }))}
        // Les boutons d'un carousel sont PAR CARTE : aucun bouton commun à afficher sous les cartes.
        buttons={[]}
      />
    );
  }
  /**
   * ⚠️ `headerMediaUrl` VIENT DU CDN DE META ET EXPIRE : elle est lue à l'affichage (`listTemplates`) et
   * jamais mise en cache, exactement comme les visuels de carte d'un carousel juste au-dessus. Absente,
   * `WhatsAppPreview` retombe sur son pictogramme de format, qui dit déjà « il y aura une image ici ».
   */
  const header = template.headerFormat
    ? {
      format: template.headerFormat,
      ...(template.headerText ? { text: template.headerText } : {}),
      ...(template.headerMediaUrl ? { mediaUrl: template.headerMediaUrl } : {}),
    }
    : null;
  return (
    <WhatsAppPreview
      body={template.body ?? ''}
      examples={examples}
      buttons={template.buttons ?? []}
      header={header}
      {...(template.footer ? { footer: template.footer } : {})}
      {...(senderName ? { senderName } : {})}
      hideNote
    />
  );
}
