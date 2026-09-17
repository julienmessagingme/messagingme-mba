'use client';

import { AppShell } from '@/components/AppShell';
import { McpServeurs } from '@/components/McpServeurs';

/**
 * Menu Tools > Connecteurs MCP : les serveurs d'outils TIERS sur lesquels on branche un agent.
 *
 * 🔴 À NE PAS CONFONDRE AVEC `Developers > Serveur MCP`, QUI VA DANS L'AUTRE SENS. Celui-là décrit NOTRE
 * serveur, que les clients branchent sur Claude ou ChatGPT pour lire leurs conversations. Ici, c'est nous
 * qui allons chercher des outils chez quelqu'un d'autre. Deux menus, deux sens, et aucun mot partagé à part
 * MCP : c'est ce qui les distingue à la lecture.
 */
export default function ConnecteursMcpPage() {
  return (
    <AppShell active="connecteurs-mcp">
      {(session) => <McpServeurs tenantId={session.tenantId} isAdmin={session.role === 'admin'} />}
    </AppShell>
  );
}
