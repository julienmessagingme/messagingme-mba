'use client';

import { AppShell } from '@/components/AppShell';
import { ConnecteursBibliotheque } from '@/components/ConnecteursBibliotheque';
import { useT } from '@/lib/i18n';
import type { Session } from '@/lib/session';
import { IntroPage, TitrePage } from '@/components/TitrePage';

/**
 * Menu Tools > Connecteurs API : la BIBLIOTHÈQUE de systèmes du workspace.
 *
 * 🔴 POURQUOI DANS TOOLS, ET PAS DANS UN AGENT. Le menu Tools regroupe ce qui branche la console sur
 * l'extérieur : les webhooks entrants, et les systèmes que les agents interrogent, en HTTP ici et en MCP
 * dans l'écran voisin. Un système appartient au CLIENT : plusieurs agents tapent dans la même bibliothèque, et le
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
        <TitrePage>{t('Connecteurs API', 'API connectors')}</TitrePage>
        <IntroPage>
          {t('Les systèmes que vos agents IA peuvent interroger.', 'The systems your AI agents can query.')}
        </IntroPage>
      </div>
      <ConnecteursBibliotheque tenantId={session.tenantId} />
    </div>
  );
}
