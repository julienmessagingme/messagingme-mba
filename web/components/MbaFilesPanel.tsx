'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls } from '@/lib/ui';
import { MbaNotice } from './MbaNotice';
import { fileToDataUrl } from '@/lib/image';
import { MBA_FILE_ACCEPT, MBA_FILE_MAX_BYTES, mbaFileExtensionOk, mbaFileFormatConditionnel, mbaFileSizeOk } from '@/lib/mba-files';
import { deleteMbaFile, listMbaFiles, uploadMbaFile, type MbaFile } from '@/lib/api-mba';

/**
 * Documents que l'agent peut lire : PDF, Word, images, et (sous condition) CSV et Excel.
 *
 * ⚠️ Un envoi accepté ne veut PAS dire un document exploité. Meta répond « reçu », jamais « indexé », et aucun
 * champ n'expose l'indexation : un PDF scanné sans couche texte passe en silence sans rien apporter. L'écran le
 * dit, plutôt que de laisser croire que la connaissance est en place.
 */
export function MbaFilesPanel({ tenantId, phoneNumberId }: { tenantId: string; phoneNumberId: string }) {
  const t = useT();
  const [fichiers, setFichiers] = useState<MbaFile[]>([]);
  const [chargement, setChargement] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const recharger = useCallback(async (): Promise<void> => {
    const { files } = await listMbaFiles(tenantId, phoneNumberId);
    setFichiers(Array.isArray(files) ? files : []);
  }, [tenantId, phoneNumberId]);

  useEffect(() => {
    let vivant = true;
    recharger()
      .catch((e: unknown) => { if (vivant) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (vivant) setChargement(false); });
    return () => { vivant = false; };
  }, [recharger]);

  async function envoyer(f: File): Promise<void> {
    setErr('');
    // Refusé côté client : inutile de faire monter jusqu'à 27 Mo de base64 pour se faire jeter en 400.
    if (!mbaFileExtensionOk(f.name, f.type)) {
      setErr(t(
        'Format non accepté par Meta, ou nom de fichier incohérent avec son contenu. Formats acceptés : PDF, Word, PNG, JPG, CSV, Excel.',
        'Format not accepted by Meta, or file name inconsistent with its content. Accepted: PDF, Word, PNG, JPG, CSV, Excel.',
      ));
      return;
    }
    if (!mbaFileSizeOk(f.size)) {
      setErr(t(
        `Fichier trop lourd (maximum ${Math.round(MBA_FILE_MAX_BYTES / 1024 / 1024)} Mo).`,
        `File too large (maximum ${Math.round(MBA_FILE_MAX_BYTES / 1024 / 1024)} MB).`,
      ));
      return;
    }
    setBusy(true);
    try {
      await uploadMbaFile(tenantId, phoneNumberId, f.name, await fileToDataUrl(f));
      await recharger();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // CSV et Excel dépendent d'un réglage de l'actif WhatsApp que Meta ne documente pas : sans cette
      // précision, un refus sur ces deux formats se lit comme « mon fichier est mauvais », à tort.
      setErr(mbaFileFormatConditionnel(f.name)
        ? `${message} ${t(
            'Les fichiers CSV et Excel ne sont acceptés que si l’extraction correspondante est activée sur votre compte WhatsApp. Un PDF passe dans tous les cas.',
            'CSV and Excel files are only accepted if the matching extraction is enabled on your WhatsApp account. A PDF always works.',
          )}`
        : message);
    } finally {
      setBusy(false);
    }
  }

  if (chargement) return <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>;

  return (
    <div className="space-y-5">
      {err !== '' && <MbaNotice kind="error" testid="mba-files-error">{err}</MbaNotice>}

      <section className={cardCls}>
        <h3 className="text-sm font-semibold text-ink-900">{t('Ajouter un document', 'Add a document')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-ink-600">
          {t(
            'PDF, Word, images. Vos procédures, votre catalogue, vos conditions. Un document reçu n’est pas forcément exploitable : un PDF scanné sans texte n’apporte rien, et Meta ne le signale pas.',
            'PDF, Word, images. Your procedures, catalogue, terms. A received document is not necessarily usable: a scanned PDF with no text layer brings nothing, and Meta gives no warning.',
          )}
        </p>
        <label className="mt-3 flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-ink-300 px-4 py-6 text-sm text-ink-600 hover:border-brand-400">
          <input
            type="file"
            accept={MBA_FILE_ACCEPT}
            hidden
            disabled={busy}
            data-testid="mba-file-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void envoyer(f);
            }}
          />
          {busy ? t('Envoi…', 'Uploading…') : t('Choisir un document', 'Choose a document')}
        </label>
      </section>

      <ul className="space-y-2" data-testid="mba-files-list">
        {fichiers.map((f) => (
          <li key={f.id} className={`${cardCls} flex items-center justify-between gap-4 p-4`}>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink-900">{f.file_name ?? f.id}</p>
              <p className="mt-1 text-xs text-ink-500">
                {t('Reçu par Meta. L’indexation n’est pas vérifiable.', 'Received by Meta. Indexing cannot be verified.')}
              </p>
            </div>
            <button
              className="shrink-0 text-xs font-medium text-rose-600 hover:text-rose-700"
              onClick={() => {
                if (!window.confirm(t(`Supprimer ${f.file_name ?? f.id} ?`, `Delete ${f.file_name ?? f.id}?`))) return;
                setErr('');
                void deleteMbaFile(tenantId, phoneNumberId, f.id)
                  .then(recharger)
                  .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
              }}
            >
              {t('Supprimer', 'Delete')}
            </button>
          </li>
        ))}
        {fichiers.length === 0 && <li className="text-sm text-ink-500">{t('Aucun document pour l’instant.', 'No documents yet.')}</li>}
      </ul>
    </div>
  );
}
