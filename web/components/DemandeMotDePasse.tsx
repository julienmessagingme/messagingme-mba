'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Modale } from '@/components/Modale';
import { Bouton } from '@/components/Bouton';

/**
 * LA FENÊTRE « VOTRE MOT DE PASSE », AVANT UN GESTE QUI AFFAIBLIT LA SÉCURITÉ DE L'ESPACE (décision de Julien du
 * 2026-10-13) : décocher l'exigence du second facteur, réinitialiser celui d'un autre membre. Le serveur la redemande
 * (`motDePasseConfirme`, `src/http/users.ts`) ; cette fenêtre ne fait que la recueillir.
 *
 * `onConfirmer` rend `null` quand le geste est fait (la fenêtre se ferme chez l'appelant), ou le message à afficher :
 * un mot de passe faux laisse la fenêtre ouverte pour réessayer, plutôt que de renvoyer l'admin au début du geste.
 */
export function DemandeMotDePasse({ titre, message, libelleConfirmer, onConfirmer, onAnnuler }: {
  titre: string;
  message: string;
  libelleConfirmer: string;
  onConfirmer: (motDePasse: string) => Promise<string | null>;
  onAnnuler: () => void;
}) {
  const t = useT();
  const [motDePasse, setMotDePasse] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  async function confirmer(e: React.FormEvent) {
    e.preventDefault();
    if (envoi || motDePasse === '') return;
    setEnvoi(true);
    setErreur(null);
    try {
      const refus = await onConfirmer(motDePasse);
      if (refus !== null) setErreur(refus);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <Modale titre={titre} taille="petite" testId="demande-mot-de-passe" onClose={onAnnuler}>
      <form onSubmit={(e) => { void confirmer(e); }} className="grid gap-3">
        <p className="whitespace-pre-line text-sm text-ink-700">{message}</p>
        <label htmlFor="demande-mot-de-passe-champ" className="block text-sm font-medium text-ink-900">{t('Votre mot de passe', 'Your password')}</label>
        <input
          id="demande-mot-de-passe-champ"
          data-testid="demande-mot-de-passe-champ"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={motDePasse}
          onChange={(e) => setMotDePasse(e.target.value)}
          className={inputCls}
        />
        {erreur && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700" data-testid="demande-mot-de-passe-erreur">{erreur}</p>}
        <div className="flex justify-end gap-2">
          <Bouton type="button" variante="secondaire" onClick={onAnnuler} data-testid="demande-mot-de-passe-annuler">{t('Annuler', 'Cancel')}</Bouton>
          <Bouton type="submit" enCours={envoi} disabled={envoi || motDePasse === ''} data-testid="demande-mot-de-passe-confirmer">{libelleConfirmer}</Bouton>
        </div>
      </form>
    </Modale>
  );
}
