'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { WhatsAppPreview } from '@/components/WhatsAppPreview';
import { CarouselPreview } from '@/components/CarouselPreview';
import { CarouselForm } from '@/components/CarouselForm';
import { TemplateForm } from '@/components/TemplateForm';
import type { Session } from '@/lib/session';
import { listTemplates, deleteTemplate, type TemplateSummary } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n';
import { categorieTemplate, statutTemplate } from '@/lib/format';
import { Icone } from '@/components/Icone';
import { Bouton } from '@/components/Bouton';
import { TitrePage } from '@/components/TitrePage';
import { useConfirmation } from '@/components/Confirmation';
import { Modale } from '@/components/Modale';
import { Squelette } from '@/components/Squelette';
import { erreurDeChargement } from '@/lib/http';
import { BarreDossiers, comptesDesOnglets, DeplacerVers, dossierCommun, useDossiers } from '@/components/BarreDossiers';
import { ranger, SANS_DOSSIER } from '@/lib/api/dossiers';

export default function TemplatesPage() {
  return <AppShell active="templates">{(session) => <TemplatesInner session={session} />}</AppShell>;
}

const STATUS: Record<string, string> = {
  APPROVED: 'bg-succes-50 text-succes-700',
  PENDING: 'bg-alerte-50 text-alerte-700',
  REJECTED: 'bg-danger-50 text-danger-700',
};


function TemplatesInner({ session }: { session: Session }) {
  const t = useT();
  const { locale } = useLocale();
  const confirmer = useConfirmation();
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'simple' | 'carousel'>('simple');
  const [editing, setEditing] = useState<TemplateSummary | null>(null);
  const [creating, setCreating] = useState(false);
  // Duplication : le formulaire s'ouvre PRÉ-REMPLI mais en mode création (nom et langue redeviennent
  // modifiables, rien n'est envoyé à Meta avant le clic). Distinct de `editing`, qui modifie l'existant.
  const [dupliquer, setDupliquer] = useState<TemplateSummary | null>(null);
  const [preview, setPreview] = useState<TemplateSummary | null>(null);
  /**
   * LES DOSSIERS (décision de Julien du 2026-10-13). Un template se range par son NOM : ses lignes de langue suivent
   * ensemble, et la sélection se fait par nom (cocher une langue coche le template). La liste ne change pas : le
   * rangement vient de la route des dossiers.
   */
  const dossiers = useDossiers(session.tenantId, 'template');
  const rangeable = session.role === 'admin' && dossiers.disponible;
  const visibles = dossiers.filtrer(templates, (tpl) => tpl.name);
  const nomsVisibles = [...new Set(visibles.map((tpl) => tpl.name))];
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [aDeplacer, setADeplacer] = useState<string[] | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setTemplates((await listTemplates(session.tenantId)).templates);
    } catch (err) {
      setError(erreurDeChargement(err, t));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function remove(tpl: TemplateSummary) {
    if (!(await confirmer({ titre: t('Supprimer le template', 'Delete the template'), message: t(`Supprimer le template « ${tpl.name} » ?\nSuppression définitive chez Meta (toutes les langues). Bloquée si une campagne active l’utilise.`,
      `Delete template “${tpl.name}”?\nPermanent deletion at Meta (all languages). Blocked if an active campaign uses it.`), confirmer: t('Supprimer', 'Delete') }))) return;
    setError(null);
    try {
      await deleteTemplate(session.tenantId, tpl.name);
      // Le template n'existe plus chez Meta : sa place dans un dossier part avec lui. Un échec la laisse en base, où
      // elle ne compte nulle part (les comptes se font sur la liste de Meta).
      if (dossiers.vue.rangement[tpl.name]) await ranger(session.tenantId, 'template', [tpl.name], null).catch(() => 0);
      setSelection((sel) => { const suivant = new Set(sel); suivant.delete(tpl.name); return suivant; });
      await Promise.all([reload(), dossiers.recharger()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    }
  }

  /** Range les templates de la fenêtre « Déplacer vers… » dans un dossier, ou dans « Sans dossier ». */
  async function deplacer(dossierId: string | null) {
    const noms = aDeplacer ?? [];
    setADeplacer(null);
    if (noms.length === 0) return;
    setError(null);
    try {
      await ranger(session.tenantId, 'template', noms, dossierId);
      setSelection(new Set());
      await dossiers.recharger();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Déplacement impossible', 'Unable to move'));
    }
  }
  const basculer = (nom: string) => setSelection((sel) => {
    // Une COPIE, jamais une mutation : muter garderait la même référence et React ne rendrait rien.
    const suivant = new Set(sel);
    if (suivant.has(nom)) suivant.delete(nom); else suivant.add(nom);
    return suivant;
  });

  return (
    <div className="space-y-6">
      {dupliquer ? (
        <section className="rounded-carte border border-brand-200 bg-brand-50/40 p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink-900">{t(`Dupliquer « ${dupliquer.name} »`, `Duplicate “${dupliquer.name}”`)}</h2>
            <button onClick={() => setDupliquer(null)} className="text-xs text-ink-500 hover:text-ink-900">{t('Fermer', 'Close')}</button>
          </div>
          <TemplateForm
            key={`dup-${dupliquer.name}`}
            tenantId={session.tenantId}
            onCreated={() => { void reload(); setDupliquer(null); }}
            initial={dupliquer}
            duplique
          />
        </section>
      ) : editing ? (
        <section className="rounded-carte border border-brand-200 bg-brand-50/40 p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink-900">{t(`Modifier « ${editing.name} »`, `Edit “${editing.name}”`)}</h2>
            <button onClick={() => setEditing(null)} className="text-xs text-ink-500 hover:text-ink-900">{t('Fermer', 'Close')}</button>
          </div>
          <p className="mb-4 rounded-controle bg-alerte-50 px-3 py-2 text-xs text-alerte">{t('Modifier un template le renvoie en revue chez Meta : il ne peut plus partir avant sa nouvelle validation. Le nom et la langue ne changent pas.', 'Editing a template sends it back to Meta for review: it cannot be sent until re-approved. Name and language cannot change.')}</p>
          <TemplateForm key={editing.name} tenantId={session.tenantId} onCreated={() => { void reload(); setEditing(null); }} initial={editing} />
        </section>
      ) : creating ? (
        <section className="rounded-carte border border-brand-200 bg-brand-50/40 p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink-900">{t('Nouveau template', 'New template')}</h2>
            <button onClick={() => setCreating(false)} className="text-xs text-ink-500 hover:text-ink-900">{t('Fermer', 'Close')}</button>
          </div>
          <div className="mb-4 inline-flex gap-1 rounded-controle bg-ink-100 p-1 text-xs">
            {(['simple', 'carousel'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-controle px-3 py-1 ${mode === m ? 'bg-white font-medium text-brand-700' : 'text-ink-500 hover:text-ink-900'}`}
              >
                {m === 'simple' ? t('Template simple', 'Simple template') : 'Carousel'}
              </button>
            ))}
          </div>
          {mode === 'simple' ? (
            <TemplateForm tenantId={session.tenantId} onCreated={() => { void reload(); setCreating(false); }} />
          ) : (
            <CarouselForm tenantId={session.tenantId} onCreated={() => { void reload(); setCreating(false); }} />
          )}
        </section>
      ) : null}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <TitrePage className="tabular-nums">{t('Templates', 'Templates')} ({visibles.length})</TitrePage>
          <div className="flex items-center gap-3">
            <button onClick={reload} className="text-xs text-brand-600 hover:underline">{t('Rafraîchir', 'Refresh')}</button>
            {!creating && !editing && (
              <Bouton onClick={() => setCreating(true)}><Icone nom="ajouter" />{t('Créer un template', 'Create a template')}</Bouton>
            )}
          </div>
        </div>
        {error && <p className="mb-3 rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
        {dossiers.disponible && (
          <div className="mb-3">
            <BarreDossiers
              tenantId={session.tenantId} type="template" admin={session.role === 'admin'} vue={dossiers.vue} onglet={dossiers.onglet}
              comptes={comptesDesOnglets(templates, (tpl) => tpl.name, dossiers.vue)}
              // Changer d'onglet vide la sélection : on ne garde pas cochées des lignes qu'on ne voit plus.
              onChoisir={(o) => { dossiers.setOnglet(o); setSelection(new Set()); }}
              onChange={dossiers.recharger}
            />
          </div>
        )}
        {selection.size > 0 && (
          <div className="mb-3 flex items-center justify-between rounded-controle bg-ink-50 px-4 py-2" data-testid="templates-barre-selection">
            <span className="text-sm text-ink-900">
              {selection.size === 1 ? t('1 template sélectionné', '1 template selected') : t(`${selection.size} templates sélectionnés`, `${selection.size} templates selected`)}
            </span>
            <div className="flex items-center gap-3">
              <button onClick={() => setSelection(new Set())} className="text-sm text-ink-500 hover:text-ink-900">{t('Annuler', 'Cancel')}</button>
              <Bouton variante="secondaire" taille="petite" data-testid="templates-deplacer-selection" onClick={() => setADeplacer([...selection])}>
                {t('Déplacer vers…', 'Move to…')}
              </Bouton>
            </div>
          </div>
        )}
        {loading ? (
          <Squelette forme="lignes" />
        ) : templates.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-ink-500">
            {t('Aucun template. Cliquez sur « Créer un template » : il passe en revue chez Meta avant d’être utilisable.', 'No templates yet. Click “Create a template”: it goes through Meta review before it can be used.')}
          </div>
        ) : visibles.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-ink-500" data-testid="templates-dossier-vide">
            {dossiers.onglet === SANS_DOSSIER
              ? t('Tous vos templates sont rangés dans un dossier.', 'All your templates are in a folder.')
              : t('Aucun template dans ce dossier : « Déplacer vers… », sur la ligne d’un template, l’y range.', 'No template in this folder: “Move to…”, on a template’s row, puts it here.')}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-carte border border-ink-200 bg-white">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-ink-50 text-left text-xs text-ink-500">
                <tr>
                  {rangeable && (
                    <th className="w-10 px-3 py-2.5">
                      {/* « Tout cocher » porte sur la liste AFFICHÉE : on ne coche pas ce qu'on ne voit pas. */}
                      <input
                        type="checkbox"
                        aria-label={t('Tout sélectionner', 'Select all')}
                        data-testid="templates-tout-cocher"
                        checked={nomsVisibles.length > 0 && nomsVisibles.every((n) => selection.has(n))}
                        onChange={(e) => setSelection(e.target.checked ? new Set(nomsVisibles) : new Set())}
                      />
                    </th>
                  )}
                  <th className="px-4 py-2.5 font-medium">{t('Nom', 'Name')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('Catégorie', 'Category')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('Langue', 'Language')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('Statut', 'Status')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('Actions', 'Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {visibles.map((tpl) => (
                  <tr key={`${tpl.name}-${tpl.language}`} className="hover:bg-ink-50">
                    {rangeable && (
                      <td className="w-10 px-3 py-2.5">
                        <input
                          type="checkbox"
                          aria-label={t(`Sélectionner ${tpl.name} (${tpl.language})`, `Select ${tpl.name} (${tpl.language})`)}
                          data-testid={`template-cocher-${tpl.name}-${tpl.language}`}
                          checked={selection.has(tpl.name)}
                          onChange={() => basculer(tpl.name)}
                        />
                      </td>
                    )}
                    <td className="px-4 py-2.5">
                      <button onClick={() => setPreview(tpl)} className="font-mono text-xs font-medium text-brand-600 hover:underline" title={t("Voir l’aperçu", 'View preview')}>{tpl.name}</button>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-500">{categorieTemplate(tpl.category, locale)}</td>
                    <td className="px-4 py-2.5 text-xs">{tpl.language}</td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[tpl.status] ?? 'bg-ink-100 text-ink-500'}`}>
                        {statutTemplate(tpl.status, locale)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-3 text-xs">
                        {tpl.editable === false ? (
                          <span className="text-ink-500" title={tpl.isCarousel ? t('Un carousel ne se modifie pas ici.', 'A carousel cannot be edited here.') : !tpl.body ? t('Un modèle sans corps ne se modifie pas ici.', 'A template without a body cannot be edited here.') : t('Modification impossible ici : un en-tête image, vidéo ou document, un bouton téléphone, code à copier, appel ou catalogue, ou un élément que la console ne connaît pas (une offre limitée dans le temps…) serait perdu.', 'Cannot be edited here: an image, video or document header, a phone, copy code, call or catalog button, or an element the console does not know (a limited-time offer…) would be lost.')}>{t('Modifier', 'Edit')}</span>
                        ) : (
                          <button onClick={() => setEditing(tpl)} className="font-medium text-brand-600 hover:text-brand-700">{t('Modifier', 'Edit')}</button>
                        )}
                        {tpl.isCarousel ? (
                          <span className="text-ink-500" title={t('Duplication d’un carousel non supportée', 'Duplicating a carousel is not supported')}>{t('Dupliquer', 'Duplicate')}</span>
                        ) : (
                          <button onClick={() => { setDupliquer(tpl); setEditing(null); setCreating(false); }} data-testid={`template-dupliquer-${tpl.name}`} className="font-medium text-brand-600 hover:text-brand-700">{t('Dupliquer', 'Duplicate')}</button>
                        )}
                        {rangeable && (
                          <button onClick={() => setADeplacer([tpl.name])} data-testid={`template-deplacer-${tpl.name}-${tpl.language}`} className="font-medium text-brand-600 hover:text-brand-700">{t('Déplacer vers…', 'Move to…')}</button>
                        )}
                        <button onClick={() => remove(tpl)} className="font-medium text-danger hover:text-danger-700">{t('Supprimer', 'Delete')}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {preview && <TemplatePreviewModal template={preview} onClose={() => setPreview(null)} />}
      {aDeplacer && (
        <DeplacerVers
          dossiers={dossiers.vue.dossiers} combien={aDeplacer.length} actuel={dossierCommun(aDeplacer, dossiers.vue)}
          onChoisir={(d) => { void deplacer(d); }} onClose={() => setADeplacer(null)}
        />
      )}
    </div>
  );
}

/** Aperçu WhatsApp d'un template au clic sur son nom : corps + boutons ; un carousel rend ses cartes
 *  (image, texte, boutons) ; un en-tête média simple reste une note (son média n'est pas relu). */
function TemplatePreviewModal({ template, onClose }: { template: TemplateSummary; onClose: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  return (
    <Modale
      titre={template.name}
      sousTitre={`${categorieTemplate(template.category, locale)} · ${template.language} · ${statutTemplate(template.status, locale)}`}
      taille="petite"
      onClose={onClose}
    >
      {template.isCarousel ? (
        <CarouselPreview
          body={template.body ?? ''}
          cards={(template.carousel?.cards ?? []).map((c) => ({
            ...(c.mediaUrl !== undefined ? { imageUrl: c.mediaUrl } : {}),
            ...(c.mediaFormat !== undefined ? { mediaFormat: c.mediaFormat } : {}),
            ...(c.body !== undefined ? { body: c.body } : {}),
            ...(c.buttons !== undefined ? { buttons: c.buttons } : {}),
          }))}
          buttons={template.buttons ?? []}
        />
      ) : (
        <WhatsAppPreview
          body={template.body ?? ''}
          examples={template.example ?? []}
          buttons={template.buttons ?? []}
          header={template.headerFormat ? { format: template.headerFormat, text: template.headerText } : null}
          footer={template.footer}
          hideNote
        />
      )}
      {template.headerFormat && template.headerFormat !== 'TEXT' && !template.isCarousel && (
        <p className="mt-2 text-xs text-ink-500">{t('En-tête', 'Header')} {template.headerFormat.toLowerCase()} {t("(le média réel s’affiche à l’envoi).", '(the actual media is shown when sending).')}</p>
      )}
    </Modale>
  );
}
