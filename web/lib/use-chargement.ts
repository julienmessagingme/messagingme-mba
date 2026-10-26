'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { erreurDeChargement } from './http';
import { useT } from './i18n';

/**
 * LE CHARGEMENT D'UN ÉCRAN DE LISTE (audit de simplicité du 2026-10-25, lot D du plan
 * `docs/superpowers/plans/2026-10-26-audits-simplicite-structure.md`) : la mécanique que neuf écrans recopiaient mot
 * pour mot. L'erreur est remise à zéro à chaque chargement, une panne devient la phrase de `erreurDeChargement`,
 * `chargement` reste vrai jusqu'à la fin du PREMIER chargement (un rechargement ne refait pas clignoter l'écran), et le
 * chargement part au montage puis à chaque `charger` neuf.
 *
 * `charger` pose lui-même ses données : souvent plusieurs états, que les gestes de la page modifient aussi (mise à jour
 * optimiste puis retour arrière). ⚠️ Il doit être STABLE (`useCallback` sur ses vraies dépendances), sinon l'écran se
 * rechargerait à chaque rendu. `setErreur` est rendu parce que la page affiche les erreurs de ses gestes dans le même
 * bandeau que celle du chargement.
 */
export function useChargement(charger: () => Promise<void>): {
  chargement: boolean;
  erreur: string | null;
  setErreur: (erreur: string | null) => void;
  recharger: () => Promise<void>;
} {
  const t = useT();
  // La dernière langue, sans recharger l'écran quand elle change : la phrase d'erreur se compose au moment de la panne.
  const tRef = useRef(t);
  tRef.current = t;
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);

  const recharger = useCallback(async () => {
    setErreur(null);
    try {
      await charger();
    } catch (err) {
      setErreur(erreurDeChargement(err, tRef.current));
    } finally {
      setChargement(false);
    }
  }, [charger]);

  useEffect(() => {
    void recharger();
  }, [recharger]);

  return { chargement, erreur, setErreur, recharger };
}
