'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { lireQuiRepond, reglerQuiRepond, type ChoixQuiRepond } from '@/lib/api-agent';
import {
  DELAI_HEURES_MAX, DELAI_HEURES_MIN, MODES_REPONDEUR, cibleDisparue, confirmationQuitterMba, delaiHeuresDe, nomDuMode,
  positionGrisee, type EtatRepondeur, type ModeRepondeur,
} from '@/lib/repondeur';
import { useConfirmation } from '@/components/Confirmation';
import { Bouton } from '@/components/Bouton';

/**
 * « QUI RÉPOND AU CLIENT » (RC6, plan `docs/superpowers/plans/2026-10-06-rc6-qui-repond.md`) : la carte de l'Accueil,
 * réservée aux admins (le serveur aussi). Un seul réglage décide qui répond à un nouveau contact, ou à un message que
 * personne ne tient : l'agent de Meta, un agent IA, un scénario, ou l'équipe.
 *
 * Ce que la carte garantit, et pourquoi :
 *  - une position qui ne peut pas répondre est GRISÉE avec le lien qui la configure (`positionGrisee`) : la choisir
 *    laisserait les clients sans réponse ;
 *  - un mode dont la cible a disparu (agent désactivé, scénario supprimé, agent de Meta éteint) se lit « Équipe », et
 *    la carte le DIT (`cibleDisparue`) au lieu d'afficher un choix qui ne s'applique plus ;
 *  - quitter « MBA » se confirme : l'agent de Meta cesse de répondre aux contacts qu'il tient ;
 *  - rien ne part à la sélection : il faut « Enregistrer », et l'état est RELU ensuite, jamais supposé.
 * `version` : la page l'incrémente quand l'interrupteur de l'agent de Meta change, ce qui peut changer le mode.
 * `onChange` : appelé après un enregistrement, avec l'état relu (l'interrupteur suit si le choix a allumé l'agent).
 */
export function QuiRepond({ tenantId, version = 0, onChange }: {
  tenantId: string; version?: number; onChange?: (etat: EtatRepondeur) => void;
}) {
  const t = useT();
  const confirmer = useConfirmation();
  const [etat, setEtat] = useState<EtatRepondeur | null>(null);
  const [choix, setChoix] = useState<ModeRepondeur>('equipe');
  const [agentId, setAgentId] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [delai, setDelai] = useState(24);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  /** Pose l'état lu, et la saisie sur ce qu'il dit : le mode qui S'APPLIQUE, et la cible en vigueur sinon la première. */
  const appliquer = useCallback((e: EtatRepondeur | null) => {
    setEtat(e);
    if (e === null) return;
    setChoix(e.modeEffectif);
    setAgentId(e.agentsActifs.some((a) => a.id === e.agentId) ? (e.agentId ?? '') : (e.agentsActifs[0]?.id ?? ''));
    setWorkflowId(e.scenariosPublies.some((s) => s.id === e.workflowId) ? (e.workflowId ?? '') : (e.scenariosPublies[0]?.id ?? ''));
    setDelai(delaiHeuresDe(e.delaiS));
  }, []);

  useEffect(() => {
    let vivant = true;
    // Une API d'avant RC6 rend un 404 : la carte ne s'affiche pas.
    lireQuiRepond(tenantId).then((e) => { if (vivant) appliquer(e); }).catch(() => { if (vivant) setEtat(null); });
    return () => { vivant = false; };
  }, [tenantId, version, appliquer]);

  if (etat === null) return null;

  const delaiValide = Number.isInteger(delai) && delai >= DELAI_HEURES_MIN && delai <= DELAI_HEURES_MAX;
  const modifie = choix !== etat.modeEffectif
    || (choix === 'agent' && agentId !== etat.agentId)
    || (choix === 'scenario' && (workflowId !== etat.workflowId || delai !== delaiHeuresDe(etat.delaiS)));
  const complet = (choix !== 'agent' || agentId !== '') && (choix !== 'scenario' || (workflowId !== '' && delaiValide));
  const avertissement = cibleDisparue(etat, t);

  async function enregistrer(): Promise<void> {
    if (etat === null || enCours || !modifie || !complet) return;
    // Quitter « MBA » : ses contacts sont retirés de sa liste, il cesse de leur répondre. Lu sur l'état en vigueur.
    if (etat.mode === 'mba' && choix !== 'mba' && !(await confirmer(confirmationQuitterMba(t)))) return;
    const demande: ChoixQuiRepond = choix === 'agent' ? { mode: 'agent', agentId }
      : choix === 'scenario' ? { mode: 'scenario', workflowId, delaiHeures: delai }
        : { mode: choix };
    setEnCours(true);
    setErreur(null);
    try {
      await reglerQuiRepond(tenantId, demande);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('Le réglage n’a pas pu être enregistré.', 'The setting could not be saved.'));
    }
    // Relu dans tous les cas : après une erreur, la carte revient à ce qui est vraiment en vigueur.
    try {
      const relu = await lireQuiRepond(tenantId);
      appliquer(relu);
      if (relu !== null) onChange?.(relu);
    } catch {
      // La lecture a échoué : on garde l'écran tel quel, l'erreur éventuelle du geste est déjà dite.
    } finally {
      setEnCours(false);
    }
  }

  const description = (mode: ModeRepondeur): string => {
    switch (mode) {
      case 'mba': return t('L’agent de Meta répond, et lui seul reçoit les contacts que personne ne tient.', 'Meta’s agent answers, and only it receives the contacts nobody handles.');
      case 'agent': return t('Un de vos agents IA répond, comme le ferait l’agent de Meta.', 'One of your AI agents answers, as Meta’s agent would.');
      case 'scenario': return t('Un scénario publié démarre, au plus une fois par délai pour un même contact ; entre-temps, l’équipe.', 'A published scenario starts, at most once per delay for the same contact; in between, the team.');
      case 'equipe': return t('Personne ne répond automatiquement : le message arrive dans « À traiter ».', 'Nobody answers automatically: the message lands in “To handle”.');
    }
  };

  return (
    <section data-testid="qui-repond" className={`${cardCls} flex flex-col gap-3`}>
      <div>
        <h3 className="text-sm font-semibold text-ink-900">{t('Qui répond au client', 'Who answers the customer')}</h3>
        <p className="mt-0.5 text-xs text-ink-500">
          {t('À un nouveau contact, et à tout message que ni un scénario, ni un mot-clé, ni un membre de l’équipe ne tient.',
            'To a new contact, and to any message no scenario, keyword or team member is handling.')}
        </p>
      </div>
      {avertissement !== null && (
        <p data-testid="qui-repond-cible-disparue" className="rounded-controle bg-alerte-50 px-3 py-2 text-xs text-alerte-700">{avertissement}</p>
      )}
      <fieldset className="flex flex-col gap-2" disabled={enCours}>
        <legend className="sr-only">{t('Qui répond au client', 'Who answers the customer')}</legend>
        {MODES_REPONDEUR.map((mode) => {
          const grisee = positionGrisee(mode, etat, t);
          return (
            <div key={mode} data-testid={`qui-repond-position-${mode}`} className="flex flex-col gap-1">
              <label className={`flex items-start gap-2 ${grisee !== null ? 'text-ink-400' : 'text-ink-900'}`}>
                <input
                  type="radio" name="qui-repond" value={mode} className="mt-0.5 h-4 w-4 accent-brand-500"
                  checked={choix === mode} disabled={grisee !== null} onChange={() => setChoix(mode)}
                  aria-label={nomDuMode(mode, t)}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium">{nomDuMode(mode, t)}</span>
                  <span className="text-xs text-ink-500">{description(mode)}</span>
                  {grisee !== null && (
                    <span className="text-xs text-ink-500" data-testid={`qui-repond-${mode}-grisee`}>
                      {grisee.raison}{' '}
                      <Link href={grisee.lien} className="font-medium text-brand-600 underline">{grisee.libelleLien}</Link>
                    </span>
                  )}
                </span>
              </label>
              {mode === 'agent' && choix === 'agent' && (
                <select
                  data-testid="qui-repond-agent" aria-label={t('L’agent IA qui répond', 'The AI agent who answers')}
                  className={`${inputCls} ml-6 max-w-sm bg-white`} value={agentId} onChange={(e) => setAgentId(e.target.value)}
                >
                  {etat.agentsActifs.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              )}
              {mode === 'scenario' && choix === 'scenario' && (
                <div className="ml-6 flex flex-wrap items-center gap-2">
                  <select
                    data-testid="qui-repond-scenario" aria-label={t('Le scénario qui répond', 'The scenario that answers')}
                    className={`${inputCls} max-w-sm bg-white`} value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}
                  >
                    {etat.scenariosPublies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <label className="flex items-center gap-2 text-xs text-ink-700">
                    {t('Pas plus d’une fois toutes les', 'No more than once every')}
                    <input
                      data-testid="qui-repond-delai" type="number" min={DELAI_HEURES_MIN} max={DELAI_HEURES_MAX} step={1}
                      className={`${inputCls} w-20`} value={Number.isFinite(delai) ? delai : ''}
                      onChange={(e) => setDelai(Number(e.target.value))}
                    />
                    {t('heures par contact', 'hours per contact')}
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </fieldset>
      {choix === 'scenario' && !delaiValide && (
        <p className="text-xs text-danger" data-testid="qui-repond-delai-invalide">
          {t(`Le délai va de ${DELAI_HEURES_MIN} à ${DELAI_HEURES_MAX} heures.`, `The delay goes from ${DELAI_HEURES_MIN} to ${DELAI_HEURES_MAX} hours.`)}
        </p>
      )}
      {erreur !== null && <p className="text-xs text-danger" data-testid="qui-repond-erreur">{erreur}</p>}
      <div>
        <Bouton data-testid="qui-repond-enregistrer" taille="petite" disabled={!modifie || !complet || enCours} onClick={() => void enregistrer()}>
          {enCours ? t('Enregistrement…', 'Saving…') : t('Enregistrer', 'Save')}
        </Bouton>
      </div>
    </section>
  );
}
