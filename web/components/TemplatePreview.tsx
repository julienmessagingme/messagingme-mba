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
}: {
  template: Pick<TemplateSummary, 'body' | 'buttons' | 'carousel'>;
  /** Valeurs des variables `{{n}}` du corps (le corps d'un carousel est son message d'introduction). */
  examples: string[];
}) {
  if (template.carousel) {
    return (
      <CarouselPreview
        body={template.body ?? ''}
        examples={examples}
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
  return <WhatsAppPreview body={template.body ?? ''} examples={examples} buttons={template.buttons ?? []} hideNote />;
}
