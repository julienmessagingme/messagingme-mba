'use client';

import { AppShell } from '@/components/AppShell';
import { ConnecteursBibliotheque } from '@/components/ConnecteursBibliotheque';
import { useT } from '@/lib/i18n';
import type { Session } from '@/lib/session';

/**
 * Menu Tools > Connecteurs API : la BIBLIOTHÈQUE de systèmes du workspace.
 *
 * 🔴 POURQUOI DANS TOOLS, ET PAS DANS UN AGENT. Le menu Tools regroupe ce qui branche la console sur
 * l'extérieur : les webhooks entrants, et maintenant les systèmes que les agents interrogent (MCP viendra
 * s'ajouter ici). Un système appartient au CLIENT : plusieurs agents tapent dans la même bibliothèque, et le
 * déclarer dans un agent aurait fait croire qu'il lui appartient. En base, `agent_tool_sources` porte déjà
 * `tenant_id` et pas `agent_id` : cet écran ne fait que le rendre visible au bon endroit.
 */
export default function ConnecteursPage() {
  return <AppShell active="connecteurs">{(session) => <Inner session={session} />}</AppShell>;
}

function Inner({ session }: { session: Session }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-900">{t('Connecteurs API', 'API connectors')}</h1>
        <p className="mt-1 text-sm text-ink-600">
          {t(
            'Les systèmes que vos agents IA peuvent interroger. Déclarés une fois ici, utilisés par tous vos agents : chacun choisit ensuite, dans son onglet Outils, les appels qu’il a le droit d’y faire.',
            'The systems your AI agents can query. Declared once here, used by all your agents: each one then picks, in its Tools tab, the calls it is allowed to make.',
          )}
        </p>
      </div>
      <ConnecteursBibliotheque tenantId={session.tenantId} />
    </div>
  );
}
