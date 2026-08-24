'use client';

import { useRef, useState } from 'react';
import { uploadRcsMedia } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';

/**
 * Le visuel d'un message RCS : on choisit un fichier, la console l'héberge, et l'adresse se remplit toute
 * seule.
 *
 * 🔴 Pourquoi ce champ ne peut pas être un simple sélecteur de fichier. Un message RCS ne TRANSPORTE pas
 * l'image : il transporte son ADRESSE, que l'opérateur télécom va chercher lui-même. Il faut donc une URL
 * publique, et c'est exactement ce que personne ne veut avoir à fabriquer. Le champ garde malgré tout la
 * saisie d'une adresse, pour le client qui héberge déjà ses visuels ailleurs et veut garder son CDN.
 *
 * Le fichier est envoyé en data URL base64 : le serveur relit sa SIGNATURE (un `.png` renommé est refusé) et
 * c'est le type réel qui décide de l'extension de l'adresse rendue.
 */

/** Extensions acceptées par l'opérateur. Contrôlé ICI aussi parce qu'un `.webp` passe la validation d'URL et
 *  se fait refuser à l'ENVOI, c'est-à-dire devant un client. */
const IMAGE_RE = /\.(jpe?g|png|gif)(\?.*)?$/i;
const TAILLE_MAX = 2 * 1024 * 1024;

export function RcsImageField({
  tenantId, valeur, onChange, testIdPrefix = 'rcs-message', compact = false,
}: {
  tenantId: string;
  valeur: string;
  onChange: (url: string) => void;
  testIdPrefix?: string;
  compact?: boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const fichierRef = useRef<HTMLInputElement>(null);
  const cls = compact ? `${inputCls} bg-white` : inputCls;

  async function televerser(file: File) {
    setErreur(null);
    // Poids vérifié AVANT la lecture : inutile d'encoder 20 Mo en base64 pour se les faire refuser ensuite.
    if (file.size > TAILLE_MAX) {
      setErreur(t('Image trop lourde : 2 Mo maximum.', 'Image too large: 2 MB maximum.'));
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const lecteur = new FileReader();
        lecteur.onload = () => resolve(String(lecteur.result ?? ''));
        lecteur.onerror = () => reject(new Error('lecture impossible'));
        lecteur.readAsDataURL(file);
      });
      const r = await uploadRcsMedia(tenantId, dataUrl, file.name);
      onChange(r.url);
    } catch (e) {
      // Le message vient du serveur et NOMME la cause (format refusé, trop lourd) : on l'affiche tel quel.
      setErreur(e instanceof Error ? e.message : t('Téléversement impossible', 'Upload failed'));
    } finally {
      setBusy(false);
      // Remis à zéro : sans ça, re-choisir LE MÊME fichier après une erreur n'émet aucun événement.
      if (fichierRef.current) fichierRef.current.value = '';
    }
  }

  const douteuse = valeur.trim() !== '' && !IMAGE_RE.test(valeur.trim());

  return (
    <div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => fichierRef.current?.click()}
          disabled={busy}
          data-testid={`${testIdPrefix}-image-upload`}
          className="shrink-0 rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 transition hover:bg-ink-50 disabled:opacity-40"
        >
          {busy ? t('Envoi…', 'Uploading…') : t('Choisir une image', 'Choose an image')}
        </button>
        {valeur.trim() !== '' && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={valeur.trim()}
              alt=""
              referrerPolicy="no-referrer"
              className="h-9 w-14 shrink-0 rounded border border-ink-200 bg-ink-50 object-cover"
            />
            <button
              type="button"
              onClick={() => { onChange(''); setErreur(null); }}
              data-testid={`${testIdPrefix}-image-clear`}
              className="shrink-0 text-sm text-ink-400 hover:text-coral"
            >
              {t('Retirer', 'Remove')}
            </button>
          </>
        )}
      </div>
      <input
        ref={fichierRef}
        type="file"
        accept="image/jpeg,image/png,image/gif"
        data-testid={`${testIdPrefix}-image-file`}
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void televerser(f); }}
      />

      <input
        value={valeur}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`${testIdPrefix}-image`}
        className={`${cls} mt-1.5`}
        placeholder={t('…ou collez l’adresse d’une image déjà en ligne', '…or paste the URL of an image already online')}
      />

      {erreur && <p className="mt-1 text-[11px] text-red-700" data-testid={`${testIdPrefix}-image-error`}>{erreur}</p>}
      {douteuse && (
        <p className="mt-1 text-[11px] text-amber-700" data-testid={`${testIdPrefix}-image-warn`}>
          {t('Cette adresse ne finit pas par .jpg, .png ou .gif : l’opérateur refusera l’envoi.', 'This URL does not end in .jpg, .png or .gif: the carrier will refuse the send.')}
        </p>
      )}
    </div>
  );
}
