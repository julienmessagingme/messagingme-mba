'use client';

import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listerMediatheque, supprimerDeLaMediatheque, ouvrirFichierMediatheque, type FichierMediatheque } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { useConfirmation } from '@/components/Confirmation';
import { Squelette } from '@/components/Squelette';
import { Bouton } from '@/components/Bouton';
import { ApiError } from '@/lib/http';
import { poids, phraseUtilisations, phrasesDuDepot, utilisationsDuRefus, type BilanDepot } from '@/lib/medias';
import { refusAvantEnvoi, typesAcceptes } from '@/lib/champ-fichier';
import { deposerDansLaMediatheque } from '@/lib/depot-mediatheque';
import { useChargement } from '@/lib/use-chargement';

/**
 * LA MÉDIATHÈQUE (spec `docs/superpowers/specs/2026-10-14-medias-message-rapide-design.md`, lot B) : ce que pèsent les
 * fichiers de l'espace face au quota de son offre, leur dépôt, et leur suppression. Un fichier qu'un contenu cite encore
 * ne se supprime pas : le serveur refuse en 409 et dit ce qui l'utilise.
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

  const charger = useCallback(async () => {
    const m = await listerMediatheque(session.tenantId);
    setFichiers(m.fichiers);
    setOccupation(m.occupation);
    setQuota(m.quota);
  }, [session.tenantId]);
  const { chargement: loading, erreur: error, setErreur: setError, recharger: load } = useChargement(charger);
  const fichierRef = useRef<HTMLInputElement>(null);
  const [depot, setDepot] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  /**
   * AJOUTER DES FICHIERS DEPUIS LA MÉDIATHÈQUE ELLE-MÊME (Julien, 2026-10-30), pour les choisir ensuite dans un bloc de
   * scénario ou un message (« Depuis la médiathèque », `ChoixMediatheque`). Même route et mêmes règles que le champ
   * d'image (`refusAvantEnvoi`, `deposerDansLaMediatheque`), avec les cinq types que la route accepte.
   *
   * ⚠️ UN PAR UN, DANS L'ORDRE : la route est sous le plafond des routes coûteuses (10 dépôts par minute et par espace), et
   * des envois en parallèle s'y disputeraient. Un refus n'arrête pas les suivants : chaque fichier a son verdict.
   */
  async function ajouter(liste: File[]) {
    setError(null);
    setInfo(null);
    setDepot(true);
    const bilan: BilanDepot = { ajoutes: 0, dejaLa: 0, refus: [] };
    try {
      for (const f of liste) {
        const avant = refusAvantEnvoi(f, 'tout', t);
        if (avant) { bilan.refus.push({ nom: f.name, raison: avant }); continue; }
        try {
          if ((await deposerDansLaMediatheque(session.tenantId, f)).existant === true) bilan.dejaLa += 1;
          else bilan.ajoutes += 1;
        } catch (err) {
          bilan.refus.push({ nom: f.name, raison: err instanceof Error ? err.message : t('Dépôt impossible.', 'Upload failed.') });
        }
      }
    } finally {
      setDepot(false);
      // Remis à zéro : sans ça, re-choisir LE MÊME fichier après un refus n'émet aucun événement.
      if (fichierRef.current) fichierRef.current.value = '';
    }
    // La liste d'abord : son rechargement efface le bandeau d'erreur, le bilan se pose donc après lui.
    if (bilan.ajoutes > 0 || bilan.dejaLa > 0) await load();
    const phrases = phrasesDuDepot(bilan, t);
    setInfo(phrases.info);
    if (phrases.erreur) setError(phrases.erreur);
  }

  // Le dépôt est réservé aux admins côté serveur, et une offre sans stockage (quota 0) le refuserait : le bouton ne se
  // montre qu'à qui peut s'en servir, une fois le quota lu.
  const peutAjouter = session.role === 'admin' && !loading && quota !== 0;

  /**
   * Une vidéo ou un PDF n'ont pas d'adresse publique : la console les télécharge sous session, puis les ENREGISTRE.
   * ⚠️ Pas de `window.open` : appelé après un `await`, il est bloqué par Safari (et par les autres dès que le
   * téléchargement dure), sans que la page puisse le savoir. Un lien `download` cliqué par le code ne l'est pas.
   */
  async function ouvrir(f: FichierMediatheque) {
    setError(null);
    try {
      const adresse = URL.createObjectURL(await ouvrirFichierMediatheque(session.tenantId, f.code));
      const lien = document.createElement('a');
      lien.href = adresse;
      lien.download = f.nom ?? `${f.code}.${f.mime === 'video/mp4' ? 'mp4' : 'pdf'}`;
      document.body.appendChild(lien);
      lien.click();
      lien.remove();
      setTimeout(() => URL.revokeObjectURL(adresse), 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Ouverture impossible', 'Unable to open'));
    }
  }

  async function supprimer(f: FichierMediatheque) {
    const nom = f.nom ?? t('ce fichier', 'this file');
    if (!(await confirmer({
      titre: t('Supprimer le fichier', 'Delete the file'),
      message: t(`Supprimer « ${nom} » de la médiathèque ?`, `Delete "${nom}" from the media library?`),
      confirmer: t('Supprimer', 'Delete'),
    }))) return;
    setError(null);
    setInfo(null);
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
      {info && <p className="rounded-controle bg-succes-50 px-3 py-2 text-sm text-succes-700" data-testid="medias-info">{info}</p>}

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
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-5 py-3">
          <span className="text-sm font-semibold text-ink-900">{t('Fichiers', 'Files')} ({fichiers.length})</span>
          {peutAjouter && (
            <div className="flex items-center gap-3">
              <span className="text-xs text-ink-500">{t('Image JPEG, PNG ou GIF (2 Mo), vidéo MP4 ou PDF (16 Mo)', 'JPEG, PNG or GIF image (2 MB), MP4 video or PDF (16 MB)')}</span>
              <Bouton variante="secondaire" enCours={depot}
                type="button"
                onClick={() => fichierRef.current?.click()}
                disabled={depot}
                data-testid="medias-ajouter"
              >
                {depot ? t('Envoi…', 'Uploading…') : t('Ajouter des fichiers', 'Add files')}
              </Bouton>
              <input
                ref={fichierRef}
                type="file"
                multiple
                accept={typesAcceptes('tout')}
                data-testid="medias-ajouter-fichier"
                className="hidden"
                onChange={(e) => { const liste = Array.from(e.target.files ?? []); if (liste.length > 0) void ajouter(liste); }}
              />
            </div>
          )}
        </div>
        {loading ? (
          <Squelette forme="lignes" className="px-5 py-6" />
        ) : fichiers.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Aucun fichier pour l’instant. Ils arrivent quand vous en ajoutez ici, ou quand vous déposez une image dans un message ou un bloc de scénario.', 'No files yet. They arrive when you add some here, or when you upload an image to a message or a scenario block.')}</p>
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
                      {f.mime.startsWith('image/') ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={f.url} alt="" className="h-10 w-10 shrink-0 rounded-controle border border-ink-200 object-cover" />
                      ) : (
                        <button type="button" onClick={() => void ouvrir(f)} data-testid="medias-ouvrir" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-controle border border-ink-200 bg-ink-50 text-[10px] font-semibold text-ink-700 hover:border-brand-400">
                          {f.mime === 'video/mp4' ? t('Vidéo', 'Video') : 'PDF'}
                        </button>
                      )}
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
