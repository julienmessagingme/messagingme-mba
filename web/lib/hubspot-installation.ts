'use client';

import { useCallback, useState } from 'react';
import { getHubspotInstallLink } from '@/lib/api';
import { useT } from '@/lib/i18n';

/**
 * « CONNECTER HUBSPOT » : ouvre le lien d'installation (ou de re-consentement) du portail.
 *
 * Le lien est demandé au backend (route admin-only), qui y met un jeton SIGNÉ : le tenant n'est plus passé en
 * clair dans l'URL (elle était forgeable). On ouvre ensuite l'URL renvoyée.
 *
 * ⚠️ UN SEUL EXEMPLAIRE, partagé par l'Accueil et Paramètres > Intégrations (2026-09-25) : il vivait dans la
 * page d'Accueil, et la carte de l'interrupteur HubSpot en avait besoin. Deux copies du même geste finiraient
 * par ouvrir deux liens différents.
 */
export function useInstallationHubspot(tenantId: string, isAdmin: boolean): { ouvrir: (grant?: 'lists') => Promise<void>; enCours: boolean } {
  const t = useT();
  const [enCours, setEnCours] = useState(false);
  const ouvrir = useCallback(async (grant?: 'lists') => {
    if (!isAdmin || enCours) return;
    setEnCours(true);
    try {
      const { installUrl } = await getHubspotInstallLink(tenantId, grant);
      window.open(installUrl, '_blank', 'noopener,noreferrer');
    } catch {
      alert(t("Impossible de générer le lien HubSpot pour le moment.", 'Could not generate the HubSpot link right now.'));
    } finally {
      setEnCours(false);
    }
  }, [isAdmin, enCours, tenantId, t]);
  return { ouvrir, enCours };
}
