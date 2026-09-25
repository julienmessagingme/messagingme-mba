import type { ReactNode } from 'react';

/**
 * Un champ de formulaire : son libellé au-dessus, le contrôle en dessous. Le dessin des formulaires de
 * contenu (templates WhatsApp, messages RCS).
 *
 * ⚠️ DANS SON PROPRE FICHIER, ET PAS EXPORTÉ DE `TemplateForm` : importer ce libellé de sept lignes depuis
 * `TemplateForm` embarquait tout le module des templates (aperçu WhatsApp, champ de corps, téléversement Meta)
 * dans chaque écran qui voulait seulement le même libellé (relevé en revue le 2026-09-21).
 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <label className="mb-1 block text-sm font-medium text-ink-900">{label}</label>
      {children}
    </div>
  );
}
