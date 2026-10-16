'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { Bouton } from '@/components/Bouton';
import { Modale } from '@/components/Modale';
import { connecter360dialog } from '@/lib/api';
import { routeInconnue } from '@/lib/canaux-services';

/**
 * LE BOUTON « ONBOARD WITH 360DIALOG » (lot 3, recadré par Julien le 2026-10-15) : l'admin colle la clé d'API d'un
 * numéro pris sur le compte client 360dialog, et le serveur fait le reste (`POST /tenants/:tenantId/360dialog/connecter`) :
 * il lit le numéro chez 360dialog, le relie à l'espace et branche la réception. Pas de fenêtre de Meta.
 *
 * Deux usages : à côté de « Connecter mon compte WhatsApp » quand l'espace n'a pas de numéro (la zone disparaît dès
 * qu'un numéro est connecté, par l'une ou l'autre voie), et « Recoller la clé 360dialog » sur la carte du numéro, pour
 * réparer une clé refusée. 🔴 La clé ne sort jamais de ce champ que vers la route : jamais affichée, ni gardée ici.
 */
export function Connexion360dialog({ tenantId, mode, onConnecte }: {
  tenantId: string;
  /** `connecter` : un espace sans numéro. `recoller` : remplacer la clé du numéro déjà relié. */
  mode: 'connecter' | 'recoller';
  onConnecte: () => void;
}) {
  const t = useT();
  const [ouvert, setOuvert] = useState(false);
  const [cle, setCle] = useState('');
  const [numero, setNumero] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  // Le numéro est relié mais la réception n'a pas pu être branchée (`rattache` dans le refus) : à la fermeture, la console
  // relit le compte, pour que la carte du numéro (et « Recoller la clé ») remplace la zone de connexion.
  const [rattache, setRattache] = useState(false);

  const fermer = (): void => {
    setOuvert(false); setCle(''); setNumero(''); setErreur(null);
    if (rattache) { setRattache(false); onConnecte(); }
  };
  const valider = async (): Promise<void> => {
    setEnCours(true);
    setErreur(null);
    try {
      await connecter360dialog(tenantId, { cle: cle.trim(), ...(numero.trim() !== '' ? { numeroAffiche: numero.trim() } : {}) });
      fermer();
      onConnecte();
    } catch (err) {
      if ((err as { corps?: { rattache?: unknown } } | null)?.corps?.rattache === true) setRattache(true);
      setErreur(routeInconnue(err)
        ? t('Ce geste n’est pas encore disponible : le serveur n’est pas à jour. Réessayez dans quelques minutes.', 'This action is not available yet: the server is not up to date. Try again in a few minutes.')
        : err instanceof Error ? err.message : t('La connexion a échoué', 'Connection failed'));
    } finally {
      setEnCours(false);
    }
  };

  const libelle = mode === 'connecter' ? t('Onboard with 360dialog', 'Onboard with 360dialog') : t('Recoller la clé 360dialog', 'Paste the 360dialog key again');
  return (
    <>
      <Bouton data-testid={mode === 'connecter' ? 'connecter-360dialog' : 'recoller-cle-360dialog'} variante="secondaire" type="button" onClick={() => setOuvert(true)}>
        {libelle}
      </Bouton>
      {ouvert && (
        <Modale
          titre={mode === 'connecter' ? t('Connecter un numéro 360dialog', 'Connect a 360dialog number') : t('Recoller la clé 360dialog', 'Paste the 360dialog key again')}
          taille="petite"
          testId="modale-360dialog"
          fermeture={enCours ? 'boutons' : 'partout'}
          onClose={() => { if (!enCours) fermer(); }}
        >
          <p className="text-sm text-ink-500">
            {t(
              'Collez la clé d’API du numéro, telle que 360dialog l’a donnée. Nous lisons le numéro chez 360dialog, le relions à cet espace et branchons la réception des messages.',
              'Paste the number’s API key, as 360dialog gave it. We read the number at 360dialog, link it to this workspace and connect message reception.',
            )}
          </p>
          <label className="mt-4 block text-sm text-ink-900">
            {t('Clé d’API 360dialog', '360dialog API key')}
            <input
              data-testid="cle-360dialog"
              type="password"
              value={cle}
              onChange={(e) => setCle(e.target.value)}
              // `off` est ignoré sur un mot de passe : le navigateur proposerait celui de la console, qui partirait comme clé.
              autoComplete="new-password"
              spellCheck={false}
              className="mt-1 block w-full rounded-controle border border-ink-200 px-3 py-2 font-mono text-sm"
            />
          </label>
          {mode === 'connecter' && (
            <label className="mt-3 block text-sm text-ink-900">
              {t('Numéro affiché (facultatif)', 'Displayed number (optional)')}
              <input
                data-testid="numero-360dialog"
                value={numero}
                onChange={(e) => setNumero(e.target.value)}
                placeholder="+33 4 23 50 07 16"
                maxLength={32}
                autoComplete="off"
                className="mt-1 block w-full rounded-controle border border-ink-200 px-3 py-2 font-mono text-sm"
              />
            </label>
          )}
          {erreur && <p role="alert" data-testid="erreur-360dialog" className="mt-3 rounded-controle bg-danger-50 px-3 py-2 text-xs text-danger-700">{erreur}</p>}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Bouton variante="secondaire" type="button" disabled={enCours} onClick={fermer}>{t('Annuler', 'Cancel')}</Bouton>
            <Bouton data-testid="valider-360dialog" type="button" enCours={enCours} disabled={enCours || cle.trim().length < 10} onClick={() => { void valider(); }}>
              {enCours ? t('Connexion…', 'Connecting…') : t('Connecter', 'Connect')}
            </Bouton>
          </div>
        </Modale>
      )}
    </>
  );
}
