'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useT } from '@/lib/i18n';
import { Bouton } from '@/components/Bouton';
import { Modale } from '@/components/Modale';

/**
 * DEMANDER CONFIRMATION SANS LA BOÎTE DU NAVIGATEUR. La console en ouvrait trente-quatre par `window.confirm` :
 * une fenêtre grise du système, au milieu de l'écran, sans rapport avec la page, et qu'on ne peut ni styler ni
 * lire à un lecteur d'écran de façon fiable. Deux formes la remplacent, et le geste qu'elles protègent ne
 * change pas : même effet, même moment.
 *
 * - `BoutonConfirme` : le bouton devient « question ? Confirmer / Annuler » SUR PLACE. Pour un geste courant
 *   sur une ligne (retirer un fichier, supprimer un brouillon), là où l'œil est déjà.
 * - `useConfirmation` : une `Modale` pour un geste LOURD, dont la question porte des conséquences à lire
 *   (suppression définitive chez Meta, révocation d'une clé, retrait d'outils en cascade). Il rend une
 *   promesse, donc il se glisse à la place exacte de l'ancien `window.confirm`, sans réordonner le code.
 *
 * Les deux portent les mêmes repères de test : `confirmation-oui` et `confirmation-non`.
 */

/**
 * Le bouton qui demande confirmation sur place. Son premier clic ARME, le second (sur « Confirmer ») agit.
 * Le bouton de départ garde l'apparence qu'il avait sur sa ligne (`className`) : seule la question, une fois
 * armée, prend la forme commune.
 */
export function BoutonConfirme({
  question, onConfirme, children, className, libelleConfirmer, disabled, testId, titre,
}: {
  /** La question, courte : elle tient sur la ligne, à côté des deux boutons. */
  question: string;
  onConfirme: () => void;
  children: React.ReactNode;
  className: string;
  libelleConfirmer?: string;
  disabled?: boolean;
  /** Le `data-testid` du bouton de départ, celui qu'il avait avant de demander confirmation. */
  testId?: string;
  titre?: string;
}) {
  const t = useT();
  const [arme, setArme] = useState(false);
  const oui = useRef<HTMLButtonElement>(null);

  // Le focus passe sur « Confirmer » : au clavier, on n'a pas à chercher le second geste. Échap désarme.
  useEffect(() => {
    if (!arme) return;
    oui.current?.focus();
    const auClavier = (e: KeyboardEvent): void => { if (e.key === 'Escape') setArme(false); };
    window.addEventListener('keydown', auClavier);
    return () => window.removeEventListener('keydown', auClavier);
  }, [arme]);

  if (!arme) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setArme(true)}
        className={className}
        {...(testId ? { 'data-testid': testId } : {})}
        {...(titre ? { title: titre } : {})}
      >
        {children}
      </button>
    );
  }
  return (
    <span role="group" aria-label={question} data-testid="confirmation-en-ligne" className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-ink-900">{question}</span>
      <Bouton ref={oui} type="button" taille="petite" data-testid="confirmation-oui" onClick={() => { setArme(false); onConfirme(); }}>
        {libelleConfirmer ?? t('Confirmer', 'Confirm')}
      </Bouton>
      <Bouton type="button" variante="secondaire" taille="petite" data-testid="confirmation-non" onClick={() => setArme(false)}>
        {t('Annuler', 'Cancel')}
      </Bouton>
    </span>
  );
}

export interface DemandeConfirmation {
  titre: string;
  /** Le texte à lire avant de décider. Les retours à la ligne sont gardés. */
  message: string;
  /** Le libellé du bouton qui agit (« Supprimer », « Révoquer »…). Défaut : « Confirmer ». */
  confirmer?: string;
}

type Demander = (d: DemandeConfirmation) => Promise<boolean>;

/**
 * ⚠️ SANS FOURNISSEUR, LA RÉPONSE EST « NON ». Le fournisseur est posé une fois pour toute la console, dans
 * `app/layout.tsx` ; un rendu hors de lui (un test qui monterait un composant seul) n'agit donc jamais sans
 * confirmation, ce qui est le seul défaut sûr pour un geste qu'on a jugé assez lourd pour le demander.
 */
const ContexteConfirmation = createContext<Demander>(() => Promise.resolve(false));

/**
 * La fenêtre de confirmation, UNE pour toute la console. 🔴 POSÉE À LA RACINE ET NON DANS CHAQUE ÉCRAN : un
 * écran qui la rendrait lui-même devrait la placer dans CHACUN de ses retours ; un seul oublié, et la
 * promesse ne se résoudrait jamais, donc le bouton ne ferait plus rien, sans un mot.
 */
export function ConfirmationProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  const [enCours, setEnCours] = useState<(DemandeConfirmation & { repondre: (ok: boolean) => void }) | null>(null);
  // La question en attente : une seconde demande (double clic) répond « non » à la première au lieu de la
  // laisser pendre, sans quoi son geste resterait suspendu pour toujours.
  const enAttente = useRef<((ok: boolean) => void) | null>(null);

  const demander = useCallback<Demander>((d) => new Promise<boolean>((resolve) => {
    enAttente.current?.(false);
    const repondre = (ok: boolean): void => {
      if (enAttente.current === repondre) enAttente.current = null;
      setEnCours((courant) => (courant?.repondre === repondre ? null : courant));
      resolve(ok);
    };
    enAttente.current = repondre;
    setEnCours({ ...d, repondre });
  }), []);

  /**
   * 🔴 UNE QUESTION NE SURVIT PAS À UN CHANGEMENT D'ADRESSE. Le fournisseur vit à la racine, donc la fenêtre
   * restait ouverte après un retour arrière du navigateur, et « oui » exécutait alors le geste de la page
   * QUITTÉE (supprimer un agent qu'on ne voit plus). Changer d'adresse répond « non ».
   */
  const chemin = usePathname();
  useEffect(() => { enAttente.current?.(false); }, [chemin]);

  return (
    <ContexteConfirmation.Provider value={demander}>
      {children}
      {enCours && (
        <Modale
          titre={enCours.titre}
          taille="petite"
          testId="confirmation"
          onClose={() => enCours.repondre(false)}
          pied={(
            <>
              <Bouton type="button" variante="secondaire" data-testid="confirmation-non" onClick={() => enCours.repondre(false)}>
                {t('Annuler', 'Cancel')}
              </Bouton>
              <Bouton type="button" data-testid="confirmation-oui" onClick={() => enCours.repondre(true)} autoFocus>
                {enCours.confirmer ?? t('Confirmer', 'Confirm')}
              </Bouton>
            </>
          )}
        >
          <p className="whitespace-pre-line text-sm text-ink-900" data-testid="confirmation-message">{enCours.message}</p>
        </Modale>
      )}
    </ContexteConfirmation.Provider>
  );
}

/**
 * La confirmation en fenêtre, pour un geste lourd. La fonction rendue répond `true` si l'on confirme, `false`
 * si l'on annule ou ferme : exactement ce que rendait `window.confirm`, en promesse.
 */
export function useConfirmation(): Demander {
  return useContext(ContexteConfirmation);
}
