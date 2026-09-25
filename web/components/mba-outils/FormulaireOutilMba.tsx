'use client';

import { useState } from 'react';
import {
  creerOutilMba, modifierOutilMba, type CibleSaisie, type OutilMbaVue, type TypeOutilMba,
} from '@/lib/api-mba-outils';
import { BORNES_OUTIL, TEXTES_PAR_TYPE, consigneIncomplete, nomTechniqueDepuisTitre } from '@/lib/mba-outils';
import { CibleBloc, CibleChamp, CibleConnecteur, CibleScenario, CibleTag } from './CiblesOutil';
import { inputCls } from '@/lib/ui';
import { useT } from '@/lib/i18n';
import { Bouton } from '@/components/Bouton';

/** La cible de départ : celle de l'outil modifié, ou une cible vide du type choisi. */
function cibleInitiale(type: TypeOutilMba, outil: OutilMbaVue | null): CibleSaisie | null {
  const c = outil?.cible;
  if (c?.type === 'tag') return { type: 'tag', tag: c.tag };
  if (c?.type === 'champ') return { type: 'champ', champ: c.champ, valeurs: c.valeurs };
  if (c?.type === 'connecteur') return { type: 'connecteur', requeteId: c.requeteId };
  if (c?.type === 'bloc') return { type: 'bloc', workflowId: c.workflowId, code: c.code };
  if (c?.type === 'scenario') return { type: 'scenario', workflowId: c.workflowId };
  if (type === 'tag') return { type: 'tag', tag: '' };
  if (type === 'champ') return { type: 'champ', champ: '', valeurs: [] };
  if (type === 'bloc') return { type: 'bloc', workflowId: '', code: '' };
  if (type === 'scenario') return { type: 'scenario', workflowId: '' };
  return null;
}

/** Ce qui dépasse les bornes de la route, dit à l'écran plutôt qu'en 400. */
function horsBornes(c: CibleSaisie | null): boolean {
  if (c?.type === 'tag') return c.tag.trim().length > BORNES_OUTIL.tag;
  if (c?.type === 'champ') {
    return c.valeurs.length > BORNES_OUTIL.valeurs || c.valeurs.some((v) => v.length > BORNES_OUTIL.valeur);
  }
  return false;
}

function cibleComplete(c: CibleSaisie | null): boolean {
  if (c === null) return false;
  if (c.type === 'tag') return c.tag.trim() !== '';
  if (c.type === 'champ') return c.champ !== '';
  if (c.type === 'bloc') return c.workflowId !== '' && c.code !== '';
  if (c.type === 'scenario') return c.workflowId !== '';
  return c.requeteId !== '';
}

/**
 * CRÉER OU MODIFIER UN OUTIL DE L'AGENT DE META (spec 2026-09-21-outils-maison-mba, § 9.3 et § 9.4).
 *
 * 🔴 ENREGISTRER, C'EST ENVOYER : le parent publie chez Meta après un succès. Le formulaire est le lieu où l'on
 * relit ses mots avant qu'ils partent ; un bouton « Envoyer » séparé a fait rater le premier essai réel du relais.
 *
 * ⚠️ Le formulaire ne se referme que sur un succès : le refermer sur un refus perdrait la saisie (défaut payé
 * deux fois le 2026-09-15).
 */
export function FormulaireOutilMba({ tenantId, type, outil, occupe, onOccupe, onEnregistre, onAnnuler }: {
  tenantId: string;
  type: TypeOutilMba;
  outil: OutilMbaVue | null;
  /** Un envoi vers Meta, une suppression ou cet enregistrement même : l'écran attend. */
  occupe: boolean;
  /** Dit au parent qu'un enregistrement est en cours, pour qu'il bloque aussi ses propres gestes. */
  onOccupe: (enCours: boolean) => void;
  onEnregistre: (nomsAttendus: Set<string>) => Promise<void>;
  onAnnuler: () => void;
}) {
  const t = useT();
  const textes = TEXTES_PAR_TYPE[type];
  const [cible, setCible] = useState<CibleSaisie | null>(() => cibleInitiale(type, outil));
  // La cible d'origine, pour n'envoyer la cible que si elle a CHANGÉ : renvoyer celle d'un champ supprimé du
  // mini-CRM faisait refuser (422) une simple correction des mots.
  const [cibleDeDepart] = useState(() => JSON.stringify(cibleInitiale(type, outil)));
  const [title, setTitle] = useState(outil?.title ?? '');
  const [name, setName] = useState(outil?.name ?? '');
  // Un nom technique retouché à la main ne suit plus le titre.
  const [nomTouche, setNomTouche] = useState(outil !== null);
  const [description, setDescription] = useState(outil?.description ?? t(textes.quand[0], textes.quand[1]));
  const [nePasUtiliser, setNePasUtiliser] = useState(outil?.nePasUtiliser ?? t(textes.pasQuand[0], textes.pasQuand[1]));
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const changerTitre = (v: string): void => {
    setTitle(v);
    if (!nomTouche) setName(nomTechniqueDepuisTitre(v));
  };

  const manque: string | null =
    !cibleComplete(cible) ? t('Choisissez ce que fait l’outil.', 'Pick what the tool does.')
      : horsBornes(cible) ? t(
        `Trop long : une étiquette fait ${BORNES_OUTIL.tag} caractères au plus, une liste ${BORNES_OUTIL.valeurs} valeurs de ${BORNES_OUTIL.valeur} caractères.`,
        `Too long: a tag is at most ${BORNES_OUTIL.tag} characters, a list ${BORNES_OUTIL.valeurs} values of ${BORNES_OUTIL.valeur} characters.`)
      : title.trim() === '' ? t('Donnez un titre lisible.', 'Give it a readable title.')
        : !/^[a-z0-9_]{1,64}$/.test(name) ? t('Un nom technique en minuscules, chiffres et tirets bas.', 'A technical name in lowercase, digits and underscores.')
          : description.trim() === '' || consigneIncomplete(description) ? t('Complétez « Quand l’appeler ».', 'Complete “When to call it”.')
            : nePasUtiliser.trim() === '' ? t('Dites quand NE PAS l’appeler.', 'Say when NOT to call it.')
              : busy ? t('Enregistrement en cours…', 'Saving…')
                : occupe ? t('Une suppression ou un envoi vers Meta est en cours : attendez qu’il se termine.', 'A deletion or a send to Meta is running: wait for it to end.')
                  : null;

  const enregistrer = async (): Promise<void> => {
    if (manque !== null || cible === null) return;
    setBusy(true);
    onOccupe(true);
    setErreur(null);
    const mots = { name, title: title.trim(), description: description.trim(), nePasUtiliser: nePasUtiliser.trim() };
    try {
      if (outil === null) await creerOutilMba(tenantId, { ...mots, cible });
      // Un connecteur ne change pas d'appel (plan, écart 1) : sa cible ne part pas.
      else {
        const cibleChangee = cible.type !== 'connecteur' && JSON.stringify(cible) !== cibleDeDepart;
        await modifierOutilMba(tenantId, outil.id, cibleChangee ? { ...mots, cible } : mots);
      }
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('Enregistrement impossible', 'Saving failed'));
      setBusy(false);
      onOccupe(false);
      return;
    }
    setBusy(false);
    // L'ancien nom est ATTENDU aussi : renommer efface l'ancien outil chez Meta, et ce n'est pas une surprise.
    // L'écran reste occupé jusqu'à la fin de l'envoi qui suit, que le parent prend alors en charge.
    try {
      await onEnregistre(new Set([name, ...(outil ? [outil.name] : [])]));
    } finally {
      onOccupe(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-ink-200 bg-white p-4" data-testid="mba-form">
      <p className="text-sm font-semibold text-ink-900">{t(textes.titre[0], textes.titre[1])}</p>
      {erreur !== null && <p className="text-xs text-danger" data-testid="mba-form-erreur">{erreur}</p>}

      {cible?.type === 'tag' && (
        <CibleTag tenantId={tenantId} valeur={cible.tag} onChange={(tag) => setCible({ type: 'tag', tag })} />
      )}
      {cible?.type === 'champ' && (
        <CibleChamp tenantId={tenantId} champ={cible.champ} valeurs={cible.valeurs}
          onChange={(champ, valeurs) => setCible({ type: 'champ', champ, valeurs })} />
      )}
      {cible?.type === 'bloc' && (
        <CibleBloc tenantId={tenantId} workflowId={cible.workflowId} code={cible.code}
          onChange={(workflowId, code, nom) => {
            setCible({ type: 'bloc', workflowId, code });
            if (title.trim() === '' && nom !== '') changerTitre(nom);
          }} />
      )}
      {cible?.type === 'scenario' && (
        <CibleScenario tenantId={tenantId} workflowId={cible.workflowId}
          onChange={(workflowId, nom) => {
            setCible({ type: 'scenario', workflowId });
            if (title.trim() === '' && nom !== null) changerTitre(nom);
          }} />
      )}
      {type === 'connecteur' && (
        <CibleConnecteur tenantId={tenantId} requeteId={cible?.type === 'connecteur' ? cible.requeteId : null} fixe={outil !== null}
          onChoisir={(r) => {
            setCible({ type: 'connecteur', requeteId: r.id });
            if (title.trim() === '') changerTitre(r.label);
          }} />
      )}

      <label className="text-xs text-ink-500">
        {t('Titre', 'Title')}
        <input className={`${inputCls} mt-1`} data-testid="mba-form-titre" value={title} maxLength={BORNES_OUTIL.titre}
          onChange={(e) => changerTitre(e.target.value)} />
      </label>
      <label className="text-xs text-ink-500">
        {t('Nom technique (vu par l’agent de Meta)', 'Technical name (seen by Meta’s agent)')}
        <input className={`${inputCls} mt-1`} data-testid="mba-form-nom" value={name}
          onChange={(e) => { setNomTouche(true); setName(e.target.value); }} />
      </label>
      <label className="text-xs text-ink-500">
        {t('Quand l’appeler', 'When to call it')}
        <textarea className={`${inputCls} mt-1`} rows={3} data-testid="mba-form-quand" value={description} maxLength={BORNES_OUTIL.texte}
          onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="text-xs text-ink-500">
        {t('Quand NE PAS l’appeler', 'When NOT to call it')}
        <textarea className={`${inputCls} mt-1`} rows={2} data-testid="mba-form-pasquand" value={nePasUtiliser} maxLength={BORNES_OUTIL.texte}
          onChange={(e) => setNePasUtiliser(e.target.value)} />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Bouton taille="petite" type="button" data-testid="mba-form-enregistrer" disabled={manque !== null} title={manque ?? ''}
          onClick={() => { void enregistrer(); }}>
          {busy ? t('Enregistrement…', 'Saving…') : t('Enregistrer et envoyer à Meta', 'Save and send to Meta')}
        </Bouton>
        {manque !== null && <span className="text-xs text-ink-500" data-testid="mba-form-manque">{manque}</span>}
        {/* Grisé pendant l'enregistrement : il démontait le formulaire en cours, dont l'erreur se perdait avec la
            saisie, et l'outil partait quand même chez Meta (relecture du 2026-09-22). */}
        <button type="button" data-testid="mba-form-annuler" disabled={busy} onClick={onAnnuler}
          className="text-xs text-ink-500 hover:underline disabled:opacity-40">
          {t('Annuler', 'Cancel')}
        </button>
      </div>
    </section>
  );
}
