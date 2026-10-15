'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listerMediatheque, supprimerDeLaMediatheque, type FichierMediatheque } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { useConfirmation } from '@/components/Confirmation';
import { Squelette } from '@/components/Squelette';
import { ApiError, erreurDeChargement } from '@/lib/http';
import { poids, phraseUtilisations, utilisationsDuRefus } from '@/lib/medias';

/**
 * LA MÉDIATHÈQUE (spec `docs/superpowers/specs/2026-10-14-medias-message-rapide-design.md`, lot B) : ce que pèsent les
 * fichiers de l'espace face au quota de son offre, et leur suppression. Un fichier qu'un contenu cite encore ne se
 * supprime pas : le serveur refuse en 409 et dit ce qui l'utilise.
 */
export default function MediasPage() {
  return <AppShell active="parametres-medias" fonction="scenarios">{(session) => <MediasInner session={session} />}</AppShell>;
}

function MediasInner({ session }: { session: Session }) {
  const t = useT();
  const confirmer = useConfirmation();
  const [fichiers, setFichiers] = useState<FichierMediatheque[]>([]);
  const [occupation, setOccupation] = useState(0);
  const [quota, setQuota] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const m = await listerMediatheque(session.tenantId);
      setFichiers(m.fichiers);
      setOccupation(m.occupation);
      setQuota(m.quota);
    } catch (err) {
      setError(erreurDeChargement(err, t));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function supprimer(f: FichierMediatheque) {
    const nom = f.nom ?? t('ce fichier', 'this file');
    if (!(await confirmer({
      titre: t('Supprimer le fichier', 'Delete the file'),
      message: t(`Supprimer « ${nom} » de la médiathèque ?`, `Delete "${nom}" from the media library?`),
      confirmer: t('Supprimer', 'Delete'),
    }))) return;
    setError(null);
    try {
      await supprimerDeLaMediatheque(session.tenantId, f.code);
      await load();
    } catch (err) {
      const utilisations = err instanceof ApiError && err.status === 409 ? utilisationsDuRefus(err.corps) : null;
      setError(utilisations ? phraseUtilisations(utilisations, t) : err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    }
  }

  const part = quota !== null && quota > 0 ? Math.min(100, Math.round((occupation / quota) * 100)) : 0;

  return (
    <div className="max-w-formulaire space-y-6">
      <div>
        <TitrePage>{t('Médiathèque', 'Media library')}</TitrePage>
        <IntroPage>{t(
          'Les fichiers que vos messages envoient. Un fichier utilisé par un scénario, un message RCS ou une campagne en cours ne peut pas être supprimé.',
          'The files your messages send. A file used by a scenario, an RCS message or an ongoing campaign cannot be deleted.',
        )}</IntroPage>
      </div>
      {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700" data-testid="medias-erreur">{error}</p>}

      <div className="rounded-carte border border-ink-200 bg-white px-5 py-4" data-testid="medias-jauge">
        {loading ? (
          <Squelette forme="lignes" />
        ) : quota === null ? (
          <p className="text-sm text-ink-700">{t(`${poids(occupation)} utilisés, sans limite.`, `${poids(occupation)} used, unlimited.`)}</p>
        ) : quota === 0 ? (
          <p className="text-sm text-ink-700">
            {t('Votre offre ne comprend pas de stockage de fichiers.', 'Your plan does not include file storage.')}{' '}
            <Link href="/offre" className="font-medium text-brand-600 hover:underline">{t('Voir les offres', 'See the plans')}</Link>
          </p>
        ) : (
          <>
            <p className="text-sm text-ink-700">{t(`${poids(occupation)} utilisés sur ${poids(quota)}`, `${poids(occupation)} used of ${poids(quota)}`)}</p>
            <div className="mt-2 h-2 overflow-hidden rounded-controle bg-ink-100">
              <div className={`h-full ${part >= 90 ? 'bg-danger' : 'bg-brand-500'}`} style={{ width: `${part}%` }} />
            </div>
          </>
        )}
      </div>

      <div className="overflow-hidden rounded-carte border border-ink-200 bg-white">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">{t('Fichiers', 'Files')} ({fichiers.length})</div>
        {loading ? (
          <Squelette forme="lignes" className="px-5 py-6" />
        ) : fichiers.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Aucun fichier. Ils arrivent quand vous ajoutez une image à un message ou à un bloc de scénario.', 'No files yet. They arrive when you add an image to a message or a scenario block.')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs text-ink-500">
                <th className="px-5 py-2 font-medium">{t('Fichier', 'File')}</th>
                <th className="px-5 py-2 font-medium">{t('Poids', 'Size')}</th>
                <th className="px-5 py-2 font-medium">{t('Ajouté le', 'Added on')}</th>
                <th className="px-5 py-2 text-right font-medium">{t('Actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {fichiers.map((f) => (
                <tr key={f.code} className="border-b border-ink-50 last:border-0" data-testid="medias-ligne">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={f.url} alt="" className="h-10 w-10 shrink-0 rounded-controle border border-ink-200 object-cover" />
                      <span className="font-medium text-ink-900">{f.nom ?? f.code}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 tabular-nums text-ink-700">{poids(f.taille)}</td>
                  <td className="px-5 py-3 text-ink-700">{new Date(f.createdAt).toLocaleDateString('fr-FR')}</td>
                  <td className="px-5 py-3 text-right">
                    {/* La suppression est réservée aux admins côté serveur ; un autre membre ne voit pas un bouton qui lui serait refusé. */}
                    {session.role === 'admin' && (
                      <button onClick={() => void supprimer(f)} className="text-danger hover:text-danger-500">{t('Supprimer', 'Delete')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
