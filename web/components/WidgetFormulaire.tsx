'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { inputCls, cardCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { Field } from '@/components/Field';
import { WidgetApercu } from '@/components/WidgetApercu';
import type { WorkflowSummary } from '@/lib/api';
import {
  COULEUR_PAR_DEFAUT, MAX_LIBELLE_WIDGET, MAX_NOM_WIDGET, MAX_PHRASE_WIDGET, POSITIONS_WIDGET,
  type PositionWidget, type SaisieWidget, type Widget,
} from '@/lib/widgets';

/**
 * Le formulaire d'un widget, à la création comme à la modification, avec l'APERÇU EN DIRECT de la bulle à côté.
 *
 * Les champs restent des chaînes tant qu'on tape (un nombre vide n'est pas zéro) ; la saisie typée n'est construite
 * qu'à l'envoi. Les bornes sont celles du serveur (`lib/widgets.ts`), qui tranche de toute façon : l'écran guide, il
 * ne décide rien.
 */

/**
 * Le choix « qui répond », tel que l'écran le présente. `espace` est le `null` du serveur ; `mba` est « le répondeur
 * automatique » (lot 5 : l'agent de Meta, ou l'agent IA répondeur de l'espace ; la valeur en base ne change pas).
 */
type ChoixDevenir = 'espace' | 'mba' | 'scenario';

interface Brouillon {
  nom: string;
  phrase: string;
  devenir: ChoixDevenir;
  workflowId: string;
  couleur: string;
  position: PositionWidget;
  libelle: string;
  avatarUrl: string;
  actif: boolean;
  maxParHeure: string;
}

function brouillonDe(w: Widget | null): Brouillon {
  return {
    nom: w?.nom ?? '',
    phrase: w?.phrase ?? '',
    devenir: w?.devenir === 'mba' || w?.devenir === 'scenario' ? w.devenir : 'espace',
    workflowId: w?.workflowId ?? '',
    couleur: w?.couleur ?? COULEUR_PAR_DEFAUT,
    position: w?.position ?? 'bas_droite',
    libelle: w?.libelle ?? '',
    avatarUrl: w?.avatarUrl ?? '',
    actif: w?.actif ?? true,
    maxParHeure: w?.maxParHeure === null || w?.maxParHeure === undefined ? '' : String(w.maxParHeure),
  };
}

function saisieDe(b: Brouillon): SaisieWidget {
  const plafond = b.maxParHeure.trim();
  return {
    nom: b.nom.trim(),
    phrase: b.phrase.trim(),
    devenir: b.devenir === 'espace' ? null : b.devenir,
    workflowId: b.devenir === 'scenario' && b.workflowId !== '' ? b.workflowId : null,
    couleur: b.couleur,
    position: b.position,
    libelle: b.libelle.trim() === '' ? null : b.libelle.trim(),
    avatarUrl: b.avatarUrl.trim() === '' ? null : b.avatarUrl.trim(),
    actif: b.actif,
    // Le champ est `type="number"` : le navigateur rend une chaîne vide pour ce qui n'est pas un nombre, jamais `NaN`
    // (qui partirait en `null` dans le JSON, donc effacerait le plafond sans le dire). Un décimal part tel quel, et
    // le serveur dit qu'il attend un entier.
    maxParHeure: plafond === '' ? null : Number(plafond),
  };
}

export function WidgetFormulaire({ initial, scenarios, enCours, onAnnuler, onEnregistrer }: {
  /** null = un widget neuf. */
  initial: Widget | null;
  scenarios: WorkflowSummary[];
  enCours: boolean;
  onAnnuler: () => void;
  onEnregistrer: (saisie: SaisieWidget) => void | Promise<void>;
}) {
  const t = useT();
  const [b, setB] = useState<Brouillon>(() => brouillonDe(initial));
  const maj = (p: Partial<Brouillon>): void => setB((courant) => ({ ...courant, ...p }));

  const libellesPositions: Record<PositionWidget, string> = {
    bas_droite: t('En bas à droite', 'Bottom right'),
    bas_gauche: t('En bas à gauche', 'Bottom left'),
    haut_droite: t('En haut à droite', 'Top right'),
    haut_gauche: t('En haut à gauche', 'Top left'),
  };
  // Un widget devenu inerte : son scénario a été supprimé. Le formulaire le dit à côté du choix, sans l'imposer :
  // laissé tel quel, le devenir ne part pas dans la modification (`ecartsDeSaisie`), et le reste s'enregistre.
  const scenarioSupprime = initial?.scenarioSupprime === true && b.devenir === 'scenario' && b.workflowId === '';
  const pret = b.nom.trim() !== '' && b.phrase.trim() !== ''
    && (b.devenir !== 'scenario' || b.workflowId !== '' || scenarioSupprime);

  return (
    <form
      className={`${cardCls} grid gap-6 lg:grid-cols-2`}
      onSubmit={(e) => { e.preventDefault(); if (pret) void onEnregistrer(saisieDe(b)); }}
      data-testid="widget-formulaire"
    >
      <div>
        <h2 className="text-base font-semibold text-ink-900">
          {initial ? t('Modifier le widget', 'Edit the widget') : t('Nouveau widget', 'New widget')}
        </h2>

        <Field label={t('Nom', 'Name')}>
          <input
            value={b.nom}
            onChange={(e) => maj({ nom: e.target.value })}
            maxLength={MAX_NOM_WIDGET}
            placeholder={t('Site vitrine, blog, page tarifs', 'Website, blog, pricing page')}
            className={inputCls}
            data-testid="widget-nom"
          />
        </Field>
        <p className="mt-1 text-xs text-ink-500">{t('Pour vous y retrouver : le visiteur ne le voit pas.', 'For you to find your way: visitors do not see it.')}</p>

        <Field label={t('Message pré-rempli', 'Pre-filled message')}>
          <textarea
            value={b.phrase}
            onChange={(e) => maj({ phrase: e.target.value })}
            maxLength={MAX_PHRASE_WIDGET}
            rows={2}
            placeholder={t('Bonjour, je viens de votre site', 'Hello, I come from your website')}
            className={inputCls}
            data-testid="widget-phrase"
          />
        </Field>
        <p className="mt-1 text-xs text-ink-500">
          {t(
            'Le message déjà écrit quand WhatsApp s’ouvre. C’est lui qui dit par quel widget la conversation est arrivée : il doit être propre à ce widget, et ne pas ressembler à un message ordinaire.',
            'The message already typed when WhatsApp opens. It tells which widget the conversation came from: it must be unique to this widget, and not look like an ordinary message.',
          )}
          {' '}<span className="tabular-nums">{b.phrase.trim().length}/{MAX_PHRASE_WIDGET}</span>
        </p>

        <fieldset className="mt-4">
          <legend className="mb-1 block text-sm font-medium text-ink-900">{t('Qui répond', 'Who answers')}</legend>
          <div className="space-y-1.5 text-sm text-ink-900">
            <label className="flex items-center gap-2">
              <input type="radio" name="devenir" checked={b.devenir === 'espace'} onChange={() => maj({ devenir: 'espace' })} data-testid="widget-devenir-espace" />
              {t('Comme les autres conversations (le réglage de l’espace)', 'Like other conversations (the workspace setting)')}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="devenir" checked={b.devenir === 'mba'} onChange={() => maj({ devenir: 'mba' })} data-testid="widget-devenir-mba" />
              {t('Le répondeur automatique', 'The automatic responder')}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="devenir" checked={b.devenir === 'scenario'} onChange={() => maj({ devenir: 'scenario' })} data-testid="widget-devenir-scenario" />
              {t('Un scénario', 'A scenario')}
            </label>
            {b.devenir === 'scenario' && (
              <div className="pl-6">
                <select
                  value={b.workflowId}
                  onChange={(e) => maj({ workflowId: e.target.value })}
                  className={inputCls}
                  data-testid="widget-scenario"
                >
                  <option value="">{t('Choisir un scénario', 'Choose a scenario')}</option>
                  {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                {scenarioSupprime && (
                  <p className="mt-1 text-xs text-danger-700" data-testid="widget-scenario-supprime">
                    {t('Scénario supprimé : ce widget ne démarre plus rien. Choisissez-en un autre.', 'Scenario deleted: this widget no longer starts anything. Choose another one.')}
                  </p>
                )}
              </div>
            )}
            {/* Le choix grisé « Un agent IA (à venir) » a disparu (lot 5) : un agent IA répond désormais par le répondeur
                de l'espace (« Le répondeur automatique », ou le réglage de l'espace), et le serveur refuse `agent`. */}
          </div>
        </fieldset>

        <div className="mt-4 grid gap-x-4 sm:grid-cols-2">
          <Field label={t('Couleur de la bulle', 'Bubble colour')}>
            <input
              type="color"
              value={b.couleur}
              onChange={(e) => maj({ couleur: e.target.value })}
              className="h-10 w-full cursor-pointer rounded-controle border border-ink-300 bg-white px-1"
              data-testid="widget-couleur"
            />
          </Field>
          <Field label={t('Position', 'Position')}>
            <select
              value={b.position}
              onChange={(e) => {
                const p = POSITIONS_WIDGET.find((x) => x === e.target.value);
                if (p) maj({ position: p });
              }}
              className={inputCls}
              data-testid="widget-position"
            >
              {POSITIONS_WIDGET.map((p) => <option key={p} value={p}>{libellesPositions[p]}</option>)}
            </select>
          </Field>
        </div>

        <Field label={t('Libellé à côté de la bulle (facultatif)', 'Label next to the bubble (optional)')}>
          <input
            value={b.libelle}
            onChange={(e) => maj({ libelle: e.target.value })}
            maxLength={MAX_LIBELLE_WIDGET}
            placeholder={t('Une question ?', 'A question?')}
            className={inputCls}
            data-testid="widget-libelle"
          />
        </Field>
        <Field label={t('Avatar (facultatif)', 'Avatar (optional)')}>
          <input
            value={b.avatarUrl}
            onChange={(e) => maj({ avatarUrl: e.target.value })}
            placeholder="https://"
            className={inputCls}
            data-testid="widget-avatar"
          />
        </Field>
        <p className="mt-1 text-xs text-ink-500">{t('L’adresse d’une image, en https.', 'The address of an image, over https.')}</p>

        <Field label={t('Démarrages par heure au plus (facultatif)', 'Starts per hour at most (optional)')}>
          <input
            type="number"
            min={1}
            value={b.maxParHeure}
            onChange={(e) => maj({ maxParHeure: e.target.value })}
            placeholder={t('Le plafond de la plateforme', 'The platform limit')}
            className={inputCls}
            data-testid="widget-plafond"
          />
        </Field>
        <p className="mt-1 text-xs text-ink-500">
          {t(
            'La phrase est publique : n’importe qui peut l’envoyer en rafale. Ce plafond borne les scénarios démarrés par ce widget.',
            'The message is public: anyone can send it repeatedly. This limit caps the scenarios started by this widget.',
          )}
        </p>

        <label className="mt-4 flex items-center gap-2 text-sm text-ink-900">
          <input type="checkbox" checked={b.actif} onChange={(e) => maj({ actif: e.target.checked })} className="h-4 w-4 rounded-controle border-ink-300" data-testid="widget-actif" />
          {t('Widget actif (éteint, la bulle disparaît du site sans retirer la balise)', 'Widget on (off, the bubble disappears from the site without removing the tag)')}
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <Bouton type="button" variante="secondaire" onClick={onAnnuler} disabled={enCours}>{t('Annuler', 'Cancel')}</Bouton>
          <Bouton type="submit" enCours={enCours} disabled={enCours || !pret} data-testid="widget-enregistrer">
            {initial ? t('Enregistrer', 'Save') : t('Créer le widget', 'Create the widget')}
          </Bouton>
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-ink-900">{t('Aperçu', 'Preview')}</p>
        <WidgetApercu
          couleur={b.couleur}
          position={b.position}
          libelle={b.libelle.trim() === '' ? null : b.libelle.trim()}
          avatarUrl={b.avatarUrl.trim().startsWith('https://') ? b.avatarUrl.trim() : null}
          badge={initial?.badge ?? true}
        />
        <p className="mt-2 text-xs text-ink-500">
          {t(
            'Sur un téléphone, la bulle ouvre WhatsApp avec le message déjà écrit. Sur un ordinateur, elle montre un QR code à scanner.',
            'On a phone, the bubble opens WhatsApp with the message already typed. On a computer, it shows a QR code to scan.',
          )}
        </p>
      </div>
    </form>
  );
}
