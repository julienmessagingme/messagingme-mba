'use client';

import { useEffect, useState } from 'react';
import { chargerChampsFiltrables, type ChampFiltrable } from './champs-fiche';

/**
 * Les champs filtrables de l'espace ; vide tant qu'ils ne sont pas lus, et si la route ne répond pas. À part de
 * `./champs-fiche`, qui reste sans React pour que la suite racine le teste.
 */
export function useChampsFiltrables(tenantId: string | null | undefined): ChampFiltrable[] {
  const [champs, setChamps] = useState<ChampFiltrable[]>([]);
  useEffect(() => {
    if (!tenantId) return;
    let vivant = true;
    void chargerChampsFiltrables(tenantId).then((c) => { if (vivant) setChamps(c); });
    return () => { vivant = false; };
  }, [tenantId]);
  return champs;
}
