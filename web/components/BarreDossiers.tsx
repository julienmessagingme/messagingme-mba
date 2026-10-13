'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import {
  creerDossier, dansLOnglet, listerDossiers, renommerDossier, supprimerDossier, SANS_DOSSIER, SANS_DOSSIERS, TOUS,
  type Dossier, type TypeDossier, type VueDossiers,
} from '@/lib/api/dossiers';
import { Bouton } from '@/components/Bouton';
import { Icone } from '@/components/Icone';
import { Modale } from '@/components/Modale';
import { VoileMenu } from '@/components/Flottant';
import { useConfirmation } from '@/components/Confirmation';

/** L'onglet retenu par page : un confort du navigateur, jamais une donnée (il peut revenir vide). */
const cleOnglet = (type: TypeDossier): string => `mba.dossier.${type}`;
function ongletRetenu(type: TypeDossier): string {
  try { return window.localStorage.getItem(cleOnglet(type)) ?? TOUS; } catch { return TOUS; }
}
function retenirOnglet(type: TypeDossier, onglet: string): void {
  try { window.localStorage.setItem(cleOnglet(type), onglet); } catch { /* stockage indisponible : sans conséquence */ }
}

/**
 * Les dossiers d'une page et l'onglet choisi (décision de Julien du 2026-10-13). `disponible` faux : l'API ne connaît
 * pas encore les dossiers (fenêtre entre le push de la console et le `up` de l'API), la page reste celle d'avant.
 * Un onglet retenu qui ne désigne plus aucun dossier (supprimé, ou par un autre admin) retombe sur « Tous ».
 */
export function useDossiers(tenantId: string, type: TypeDossier) {
  const [vue, setVue] = useState<VueDossiers>(SANS_DOSSIERS);
  const [disponible, setDisponible] = useState(false);
  const [onglet, choisir] = useState<string>(TOUS);
  const recharger = useCallback(async () => {
    try {
      const v = await listerDossiers(tenantId, type);
      setDisponible(v !== null);
      setVue(v ?? SANS_DOSSIERS);
    } catch {
      // Best-effort : sans dossiers, la liste reste ENTIÈRE et utilisable ; garder l'ancienne vue la laisserait filtrée
      // par un rangement périmé, sans la barre qui permet d'en sortir.
      setDisponible(false);
      setVue(SANS_DOSSIERS);
    }
  }, [tenantId, type]);
  useEffect(() => { choisir(ongletRetenu(type)); void recharger(); }, [type, recharger]);
  const ongletValide = onglet === TOUS || (vue.dossiers.length > 0 && (onglet === SANS_DOSSIER || vue.dossiers.some((d) => d.id === onglet))) ? onglet : TOUS;
  const setOnglet = (o: string) => { choisir(o); retenirOnglet(type, o); };
  /** Les éléments de l'onglet choisi, parmi `elements` (la clé d'un élément : id d'un scénario, nom d'un template). */
  const filtrer = <E,>(elements: E[], cle: (e: E) => string): E[] =>
    elements.filter((e) => dansLOnglet(ongletValide, vue.rangement[cle(e)]));
  return { vue, disponible, onglet: ongletValide, setOnglet, recharger, filtrer };
}

/**
 * LA BARRE D'ONGLETS AU-DESSUS D'UNE LISTE : « Tous · Sans dossier · <dossiers> · + Dossier », chacun avec son compte
 * (calculé sur la liste réellement affichée par la page). Sur l'onglet d'un dossier, un admin le renomme ou le
 * supprime ; un membre non admin ne voit que les onglets.
 */
export function BarreDossiers({ tenantId, type, admin, vue, onglet, comptes, onChoisir, onChange }: {
  tenantId: string;
  type: TypeDossier;
  admin: boolean;
  vue: VueDossiers;
  onglet: string;
  /** Le nombre d'éléments par onglet : `tous`, `sans`, puis l'id de chaque dossier. */
  comptes: Record<string, number>;
  onChoisir: (onglet: string) => void;
  /** Après une création, un renommage ou une suppression : la page relit les dossiers. */
  onChange: () => Promise<void>;
}) {
  const t = useT();
  const confirmer = useConfirmation();
  const [saisie, setSaisie] = useState<{ dossier: Dossier | null; nom: string } | null>(null);
  const [menu, setMenu] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actif = vue.dossiers.find((d) => d.id === onglet) ?? null;

  // Un membre non admin, dans un espace sans dossier : rien à montrer.
  if (!admin && vue.dossiers.length === 0) return null;

  const enregistrer = async () => {
    if (!saisie) return;
    setBusy(true);
    setErreur(null);
    try {
      if (saisie.dossier) await renommerDossier(tenantId, saisie.dossier.id, saisie.nom.trim());
      else onChoisir((await creerDossier(tenantId, type, saisie.nom.trim())).id);
      setSaisie(null);
      await onChange();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Enregistrement impossible', 'Unable to save'));
    } finally {
      setBusy(false);
    }
  };
  const supprimer = async (d: Dossier) => {
    setMenu(false);
    if (!(await confirmer({
      titre: t('Supprimer le dossier', 'Delete the folder'),
      message: t(
        `Supprimer le dossier « ${d.nom} » ? Ce qu’il contient n’est pas supprimé : il repasse dans « Sans dossier ».`,
        `Delete the folder “${d.nom}”? Its content is not deleted: it goes back to “No folder”.`,
      ),
      confirmer: t('Supprimer', 'Delete'),
    }))) return;
    setBusy(true);
    setErreur(null);
    try {
      await supprimerDossier(tenantId, d.id);
      onChoisir(TOUS);
      await onChange();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    } finally {
      setBusy(false);
    }
  };

  const onglets: Array<{ id: string; nom: string }> = [
    { id: TOUS, nom: t('Tous', 'All') },
    ...(vue.dossiers.length > 0 ? [{ id: SANS_DOSSIER, nom: t('Sans dossier', 'No folder') }] : []),
    ...vue.dossiers,
  ];

  return (
    <div data-testid={`dossiers-${type}`}>
      {/* 🔴 SEULS LES ONGLETS DÉFILENT : un menu posé dans la zone qui défile y est rogné (vu sur capture le
          2026-10-13, le menu du dossier n'était qu'un trait). « + Dossier » et le menu restent hors de la zone. */}
      <div className="flex items-center gap-2">
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto pb-1" role="tablist" aria-label={t('Dossiers', 'Folders')}>
        {onglets.map((o) => (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={onglet === o.id}
            data-testid={`dossier-onglet-${o.id}`}
            onClick={() => onChoisir(o.id)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-controle border px-3 py-1.5 text-sm ${
              onglet === o.id ? 'border-brand-500 bg-brand-50 font-medium text-brand-700' : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50'
            }`}
          >
            <span className="max-w-[14rem] truncate">{o.nom}</span>
            <span className="tabular-nums text-xs text-ink-500">{comptes[o.id] ?? 0}</span>
          </button>
        ))}
      </div>
        {admin && (
          <button
            type="button"
            data-testid="dossier-creer"
            onClick={() => { setErreur(null); setSaisie({ dossier: null, nom: '' }); }}
            className="inline-flex shrink-0 items-center gap-1 rounded-controle px-2 py-1.5 text-sm text-brand-600 hover:underline"
          >
            <Icone nom="ajouter" taille="petite" />{t('Dossier', 'Folder')}
          </button>
        )}
        {admin && actif && (
          <div className="relative shrink-0">
            <button
              type="button"
              data-testid="dossier-menu"
              onClick={() => setMenu((m) => !m)}
              aria-label={t(`Actions du dossier « ${actif.nom} »`, `Actions for folder “${actif.nom}”`)}
              className="rounded-controle px-1.5 py-0.5 text-lg leading-none text-ink-500 hover:bg-ink-100 hover:text-ink-900"
            >
              ⋯
            </button>
            {menu && (
              <>
                <VoileMenu z="z-10" onClose={() => setMenu(false)} />
                <div className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-controle border border-ink-200 bg-white py-1 text-left text-sm shadow-mm-md">
                  <button type="button" data-testid="dossier-renommer" onClick={() => { setMenu(false); setErreur(null); setSaisie({ dossier: actif, nom: actif.nom }); }} className="block w-full px-4 py-2 text-left hover:bg-ink-50">{t('Renommer', 'Rename')}</button>
                  <button type="button" data-testid="dossier-supprimer" onClick={() => { void supprimer(actif); }} className="block w-full px-4 py-2 text-left text-danger hover:bg-danger-50">{t('Supprimer', 'Delete')}</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      {erreur && !saisie && <p className="mt-1 text-xs text-danger" data-testid="dossier-erreur">{erreur}</p>}

      {saisie && (
        <Modale titre={saisie.dossier ? t('Renommer le dossier', 'Rename the folder') : t('Nouveau dossier', 'New folder')} taille="petite" onClose={() => setSaisie(null)}>
          <input
            autoFocus
            value={saisie.nom}
            maxLength={60}
            onChange={(e) => setSaisie({ ...saisie, nom: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy && saisie.nom.trim() !== '') void enregistrer(); }}
            placeholder={t('Nom du dossier', 'Folder name')}
            data-testid="dossier-nom"
            className="mt-4 w-full rounded-controle border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          {erreur && <p className="mt-2 text-xs text-danger" data-testid="dossier-erreur">{erreur}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setSaisie(null)} disabled={busy} className="rounded-controle px-3 py-2 text-sm text-ink-500 hover:text-ink-900 disabled:opacity-50">{t('Annuler', 'Cancel')}</button>
            <Bouton onClick={() => void enregistrer()} disabled={busy || saisie.nom.trim() === ''} data-testid="dossier-enregistrer">
              {saisie.dossier ? t('Renommer', 'Rename') : t('Créer', 'Create')}
            </Bouton>
          </div>
        </Modale>
      )}
    </div>
  );
}

/**
 * « Déplacer vers… » : les dossiers de la page, plus « Sans dossier ». Le dossier où sont déjà TOUS les éléments
 * déplacés est désigné comme tel, sans être interdit (le geste ne change rien, il ne casse rien non plus).
 */
export function DeplacerVers({ dossiers, combien, actuel, onChoisir, onClose }: {
  dossiers: Dossier[];
  /** Combien d'éléments partent : le titre le dit. */
  combien: number;
  /** Le dossier commun aux éléments déplacés, `null` pour « Sans dossier », `undefined` s'ils sont dispersés. */
  actuel: string | null | undefined;
  onChoisir: (dossierId: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const choix: Array<{ id: string | null; nom: string }> = [{ id: null, nom: t('Sans dossier', 'No folder') }, ...dossiers];
  return (
    <Modale
      titre={combien === 1 ? t('Déplacer vers…', 'Move to…') : t(`Déplacer ${combien} éléments vers…`, `Move ${combien} items to…`)}
      taille="petite"
      onClose={onClose}
      testId="dossier-deplacer"
    >
      <div className="mt-4 flex flex-col gap-1">
        {choix.map((c) => (
          <button
            key={c.id ?? 'sans'}
            type="button"
            data-testid={`dossier-vers-${c.id ?? 'sans'}`}
            onClick={() => onChoisir(c.id)}
            className="flex items-center justify-between rounded-controle px-3 py-2 text-left text-sm text-ink-900 hover:bg-ink-50"
          >
            <span className="truncate">{c.nom}</span>
            {actuel === c.id && <span className="text-xs text-ink-500">{t('actuel', 'current')}</span>}
          </button>
        ))}
      </div>
    </Modale>
  );
}

/** Le compte de chaque onglet, sur les éléments réellement affichés par la page. */
export function comptesDesOnglets<E>(elements: E[], cle: (e: E) => string, vue: VueDossiers): Record<string, number> {
  const out: Record<string, number> = { [TOUS]: elements.length, [SANS_DOSSIER]: 0 };
  for (const d of vue.dossiers) out[d.id] = 0;
  for (const e of elements) {
    const d = vue.rangement[cle(e)];
    if (d === undefined || out[d] === undefined) out[SANS_DOSSIER] = (out[SANS_DOSSIER] ?? 0) + 1;
    else out[d] = (out[d] ?? 0) + 1;
  }
  return out;
}

/** Le dossier commun à des clés : celui de toutes, `null` si aucune n'est rangée, `undefined` si elles sont dispersées. */
export function dossierCommun(cles: string[], vue: VueDossiers): string | null | undefined {
  const ds = new Set(cles.map((c) => vue.rangement[c] ?? null));
  return ds.size === 1 ? [...ds][0] : undefined;
}
