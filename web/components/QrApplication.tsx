'use client';

import { useEffect, useState } from 'react';
import { Bouton } from '@/components/Bouton';
import { useT } from '@/lib/i18n';
import type { ApiConnexionNumero, QrApplication as EtatQr } from '@/lib/api/connexion-numero';
import { ETAPES_RELIER_APPLICATION } from '@/lib/partage/etapes-application';

/**
 * LE QR CODE DE LA FILIÈRE APPLICATION (2026-10-22) : à la place de la fenêtre de Meta, la page ouvre la session du
 * compte (`relierApplication`), puis relit son QR code toutes les trois secondes jusqu'à « relié ». Le QR se renouvelle
 * côté WhatsApp ; un QR qui a expiré sans être scanné se redemande par « Nouveau QR code ». La page dit « connecté » par
 * l'état de la connexion, qu'elle relit déjà : ce bloc n'a pas à le dire.
 */
export function QrApplication({ api }: { api: ApiConnexionNumero }) {
  const t = useT();
  const [etat, setEtat] = useState<EtatQr | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  /** Change à chaque demande de session : la relecture repart avec elle. */
  const [demande, setDemande] = useState(0);

  const relier = async () => {
    setEnCours(true);
    setErreur(null);
    try {
      await api.relierApplication();
      setDemande((d) => d + 1);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Une erreur est survenue', 'Something went wrong'));
    } finally {
      setEnCours(false);
    }
  };

  // La session s'ouvre une fois, à l'arrivée sur le bloc.
  useEffect(() => { void relier(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (demande === 0) return undefined;
    let vivant = true;
    const lire = () => {
      api.qrApplication().then((r) => { if (vivant) setEtat(r); }).catch(() => {});
    };
    lire();
    const minuterie = setInterval(lire, 3_000);
    return () => { vivant = false; clearInterval(minuterie); };
  }, [api, demande]);

  if (etat?.relie) return null;
  return (
    <div data-testid="qr-application" className="mt-6 rounded-carte border border-ink-200 bg-white p-5">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-700">
        {ETAPES_RELIER_APPLICATION.map((e) => <li key={e.fr}>{t(e.fr, e.en)}</li>)}
      </ol>
      <div className="mt-4 flex flex-col items-center gap-3">
        {etat?.qr ? (
          // Une image `data:` rendue par le serveur : rien ne part chez un tiers pour dessiner le QR code.
          // eslint-disable-next-line @next/next/no-img-element
          <img data-testid="qr-application-image" src={etat.qr} alt={t('QR code à scanner avec WhatsApp Business', 'QR code to scan with WhatsApp Business')} className="h-56 w-56" />
        ) : (
          <p data-testid="qr-application-attente" className="text-sm text-ink-500">
            {t('Le QR code arrive…', 'The QR code is on its way…')}
          </p>
        )}
        <Bouton type="button" variante="secondaire" taille="petite" enCours={enCours} disabled={enCours} onClick={() => { void relier(); }} data-testid="qr-application-nouveau">
          {t('Nouveau QR code', 'New QR code')}
        </Bouton>
      </div>
      {erreur && <p data-testid="erreur-application" className="mt-4 rounded-controle bg-danger-50 px-3 py-2 text-xs text-danger-700">{erreur}</p>}
    </div>
  );
}
