'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';

/**
 * « n/d » : UNE VALEUR QU'ON N'A PAS. Le tiret cadratin servait de valeur absente à une vingtaine d'endroits :
 * il se confond avec un zéro ou un séparateur, et c'est un marqueur de texte généré. « n/d » (non disponible)
 * se lit, en gris : il dit qu'on ne sait pas, sans l'affirmer en rouge.
 *
 * ⚠️ Ce n'est PAS un zéro. Une valeur absente (période sans mesure, tarif inconnu, lecture ratée) et une
 * valeur nulle sont deux affirmations différentes : l'appelant choisit, ce composant ne remplace rien.
 */
export function Nd({ testId, titre, className = '' }: {
  testId?: string;
  /** La RAISON de l'absence, quand on la connaît : une case vide sans raison se relit comme un oubli. */
  titre?: string;
  className?: string;
}) {
  const t = useT();
  return (
    <span
      className={`font-normal text-ink-400${className ? ` ${className}` : ''}`}
      title={titre ?? t('Non disponible', 'Not available')}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {t('n/d', 'n/a')}
    </span>
  );
}

/**
 * UNE SEULE ERREUR PAR ÉCRAN. Sur la synthèse du Performance Lab, un backend indisponible faisait afficher la
 * même phrase rouge cinq fois (trois lignes de coût, les intentions, le nuage) : l'écran criait là où une
 * ligne suffisait. Les cartes posées DANS ce regroupement signalent leur panne ici et n'affichent plus que
 * « n/d » à la place de leur chiffre ; l'écran porte la phrase, une fois.
 *
 * ⚠️ Hors regroupement, une carte garde son propre message : posée seule ailleurs, elle doit rester lisible.
 * Et chaque carte continue de se charger SEULE : une panne d'un tiers du contenu ne fait disparaître ni
 * les deux autres tiers, ni leur chiffre.
 */
const Regroupement = createContext<((cle: string, enErreur: boolean) => void) | null>(null);

export function ErreursRegroupees({ message, children }: { message: string; children: React.ReactNode }) {
  const [enPanne, setEnPanne] = useState<ReadonlySet<string>>(new Set());
  const signaler = useCallback((cle: string, enErreur: boolean) => {
    setEnPanne((avant) => {
      if (avant.has(cle) === enErreur) return avant;
      const apres = new Set(avant);
      if (enErreur) apres.add(cle); else apres.delete(cle);
      return apres;
    });
  }, []);
  return (
    <Regroupement.Provider value={signaler}>
      {enPanne.size > 0 && (
        <p role="alert" className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700" data-testid="ecran-erreur">{message}</p>
      )}
      {children}
    </Regroupement.Provider>
  );
}

/** Signale l'état d'erreur d'une partie de l'écran. Rend `true` quand l'écran porte déjà le message. */
export function useErreurRegroupee(cle: string, enErreur: boolean): boolean {
  const signaler = useContext(Regroupement);
  useEffect(() => {
    if (!signaler) return undefined;
    signaler(cle, enErreur);
    return () => signaler(cle, false);
  }, [signaler, cle, enErreur]);
  return signaler !== null;
}
