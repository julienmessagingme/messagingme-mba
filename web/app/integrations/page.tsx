'use client';

import { AppShell } from '@/components/AppShell';
import { useT } from '@/lib/i18n';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { ReglageIntegrationBatch } from '@/components/ReglageIntegrationBatch';
import { ReglageHubspot } from '@/components/ReglageHubspot';
import { ReglageSalesforce } from '@/components/ReglageSalesforce';
import { ReglageShopify } from '@/components/ReglageShopify';

/**
 * TOOLS > INTÉGRATIONS (2026-10-26, demande de Julien) : les outils du client que la console branche, Batch, HubSpot,
 * Salesforce et Shopify. Ils vivaient dans Paramètres > Général, qui ne règle plus que l'espace (fuseau, heures, équipe) ;
 * ils rejoignent Tools, qui regroupe ce qui BRANCHE la console sur l'extérieur.
 *
 * Réservée aux administrateurs, comme l'étaient ces cartes et comme leurs routes (`g.admin`) : `integrations` n'est pas
 * dans `ECRANS_ENCADREMENT`, la coquille y renvoie un manager à l'Inbox. Chaque carte lit l'offre et se ferme d'elle-même.
 *
 * ⚠️ LES ANCRES NE CHANGENT PAS (`#integration-hubspot`, `#integration-shopify`…) : l'Accueil, les guides et des liens
 * déjà partis les nomment, et `/parametres#integration-…` renvoie ici avec la même ancre.
 */
export default function IntegrationsPage() {
  return (
    <AppShell active="integrations">
      {(session) => <Integrations tenantId={session.tenantId} />}
    </AppShell>
  );
}

function Integrations({ tenantId }: { tenantId: string }) {
  const t = useT();
  return (
    <div className="mx-auto max-w-formulaire space-y-6">
      <header className="space-y-1">
        <span className="text-xs font-medium text-ink-500">{t('Tools', 'Tools')}</span>
        <TitrePage>{t('Intégrations', 'Integrations')}</TitrePage>
        <IntroPage>
          {t(
            'Les outils de votre entreprise que Messaging Me alimente : votre outil marketing, votre CRM et votre boutique.',
            'The business tools Messaging Me feeds: your marketing tool, your CRM and your store.',
          )}
        </IntroPage>
      </header>
      {/* L'outil qui reçoit les signaux (lot 6 de l'API publique). */}
      <ReglageIntegrationBatch tenantId={tenantId} />
      {/* L'interrupteur HubSpot (migration 0179) : c'est lui qui fait apparaître le bloc HubSpot de l'Accueil, numéro ou
          pas. L'Accueil renvoie ici (`#integration-hubspot`) quand il est éteint. */}
      <ReglageHubspot tenantId={tenantId} />
      <ReglageSalesforce tenantId={tenantId} />
      {/* La boutique Shopify (2026-10-21) : brancher, régler les trois messages, importer les clients, couper. */}
      <ReglageShopify tenantId={tenantId} />
    </div>
  );
}
