'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { MbaNotice } from '@/components/MbaNotice';
import { useConfirmation } from '@/components/Confirmation';
import { getSettings } from '@/lib/api';
import { choisirRepondeur, type AgentResume } from '@/lib/api-agent';
import {
  agentsProposables, confirmationRepondeur, lireMbaAllume, phraseContactsNonRetires, type ReglageRepondeur,
} from '@/lib/repondeur';

/**
 * LE RÉPONDEUR DE L'ESPACE (lot 5, livraison B ; spec `docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md`,
 * § 3) : quel agent IA répond à tout message que ni un scénario, ni un mot-clé, ni un membre de l'équipe ne tient.
 *
 * 🔴 UNE SEULE VOIX, ET L'ÉCRAN LE FAIT CONFIRMER. Désigner un agent IA alors que l'agent de Meta est allumé L'ÉTEINT
 * pour tous les contacts de l'espace, conversations en cours comprises (le serveur le fait, `choisirRepondeur`) : la
 * fenêtre le dit avant, et rien ne part si on refuse. L'état de l'agent de Meta est RELU au moment du geste (relecture
 * de la livraison B, JB4) : rallumé ailleurs depuis l'ouverture de la page, il serait sinon éteint sans question. Il est
 * relu aussi après une erreur (le serveur a pu l'éteindre avant d'échouer), et toute réussite qui désigne un agent le
 * dit éteint (le CHECK d'une seule voix le garantit). Revenir à « Aucun » se confirme aussi : plus aucun agent IA ne
 * répond alors aux messages que personne ne tient, l'effet même de la désactivation de l'agent répondeur.
 *
 * ⚠️ SEULS LES AGENTS ACTIFS SONT PROPOSÉS, comme le serveur l'exige : un brouillon n'a pas été relu, un agent désactivé
 * a été coupé exprès. 🔴 LE CHOIX NE PART PAS À LA SÉLECTION (JB5) : au clavier, chaque flèche sur une liste fermée
 * déclenche `change`, et parcourir la liste aurait retiré puis redésigné le répondeur de tout l'espace à chaque pas. Il
 * part au bouton « Enregistrer ».
 *
 * ⚠️ LES CONTACTS QUE META N'A PAS RETIRÉS SONT DITS, AVEC LEUR NOMBRE (relecture de la livraison A, J6) : ils restent sur
 * la liste de l'agent de Meta, éteint, et personne ne leur répond automatiquement. Le taire laisserait croire que la
 * bascule a couvert tout le monde.
 */
export function RepondeurEspace({ tenantId, agents, repondeurAgentId, soldeEpuise, onChange }: {
  tenantId: string;
  /** Tous les agents de l'espace (la liste de l'écran) : seuls les actifs sont proposés. */
  agents: AgentResume[];
  repondeurAgentId: string | null;
  /** Le crédit IA est épuisé : le répondeur ne répond plus, chaque message passe à l'équipe. */
  soldeEpuise: boolean;
  /** Ce que le serveur a fait ; `null` = on ne le sait pas (réponse illisible, ou erreur) : la page relit la liste. */
  onChange: (r: ReglageRepondeur | null) => void;
}) {
  const t = useT();
  const confirmer = useConfirmation();
  const [busy, setBusy] = useState(false);
  /** Le geste est parti chez le serveur : une bascule de l'agent de Meta peut durer, le bouton le dit. */
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [fait, setFait] = useState<{ texte: string; nonRetires: string | null } | null>(null);
  /** L'agent de Meta est-il allumé ? `null` = pas lu, ou illisible : la confirmation le dit au conditionnel. */
  const [mbaAllume, setMbaAllume] = useState<boolean | null>(null);
  /** Le choix de la liste, pas encore enregistré. Il suit le réglage relu (rechargement, désactivation depuis la fiche). */
  const [choix, setChoix] = useState(repondeurAgentId ?? '');
  useEffect(() => { setChoix(repondeurAgentId ?? ''); }, [repondeurAgentId]);
  const proposables = agentsProposables(agents, repondeurAgentId);
  const nomDe = (id: string): string => agents.find((a) => a.id === id)?.label ?? id;

  /** Relit l'état de l'agent de Meta, l'affiche et le rend. Au mieux : une lecture ratée vaut « on ne sait pas ». */
  const lireAgentDeMeta = useCallback(async (): Promise<boolean | null> => {
    const etat = await getSettings(tenantId).then(lireMbaAllume, () => null);
    setMbaAllume(etat);
    return etat;
  }, [tenantId]);
  useEffect(() => { void lireAgentDeMeta(); }, [lireAgentDeMeta]);

  async function enregistrer(): Promise<void> {
    const agentId = choix === '' ? null : choix;
    if (busy || agentId === repondeurAgentId) return;
    // Occupé dès la lecture : un double clic n'ouvre pas deux fenêtres.
    setBusy(true);
    setErreur(null);
    setFait(null);
    try {
      const question = confirmationRepondeur(
        { vers: agentId === null ? null : nomDe(agentId), depuis: repondeurAgentId === null ? null : nomDe(repondeurAgentId) },
        agentId === null ? null : await lireAgentDeMeta(),
        t,
      );
      // Un refus n'envoie rien, et la liste revient au réglage en place.
      if (question !== null && !(await confirmer(question))) {
        setChoix(repondeurAgentId ?? '');
        return;
      }
      setEnvoi(true);
      try {
        const r = await choisirRepondeur(tenantId, agentId);
        onChange(r);
        if (r === null) {
          void lireAgentDeMeta();
          return;
        }
        // Un agent désigné : l'agent de Meta est éteint, qu'il vienne de l'être ou non (CHECK d'une seule voix).
        if (r.repondeurAgentId !== null) setMbaAllume(false);
        const texte = r.repondeurAgentId === null
          ? t(
            'L’espace n’a plus d’agent IA répondeur : plus aucun répondeur automatique ne répond aux messages que personne ne tient.',
            'The workspace no longer has an AI responder: no automatic responder answers the messages nobody handles anymore.',
          )
          : t(
            `« ${nomDe(r.repondeurAgentId)} » répond désormais aux messages que personne ne tient.${r.agentDeMetaEteint ? ' L’agent de Meta est éteint.' : ''}`,
            `“${nomDe(r.repondeurAgentId)}” now answers the messages nobody handles.${r.agentDeMetaEteint ? ' Meta’s agent is off.' : ''}`,
          );
        setFait({ texte, nonRetires: phraseContactsNonRetires(r.liste.refuses, t) });
      } catch (err) {
        // Le serveur dit pourquoi (agent inactif, modèle absent, Meta qui refuse d'éteindre son agent). Il a pu éteindre
        // l'agent de Meta avant d'échouer, ou continuer après une coupure : on relit le réglage et l'agent de Meta, on ne
        // suppose pas que rien n'a changé.
        setErreur(err instanceof Error ? err.message : t('Le répondeur n’a pas pu être changé.', 'The responder could not be changed.'));
        setChoix(repondeurAgentId ?? '');
        onChange(null);
        void lireAgentDeMeta();
      }
    } finally {
      setEnvoi(false);
      setBusy(false);
    }
  }

  return (
    <section className={`${cardCls} flex flex-col gap-3`} data-testid="repondeur-espace">
      <div>
        <h2 className="text-sm font-semibold text-ink-900">{t('Répondeur de l’espace', 'Workspace responder')}</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          {t(
            'L’agent choisi répond à tout message que ni un scénario, ni un mot-clé, ni un membre de l’équipe ne tient, sans scénario à construire. Quand il conclut ou passe la main, le message suivant du contact le relance.',
            'The chosen agent answers every message that no scenario, keyword or team member handles, with no scenario to build. When it concludes or hands over, the contact’s next message starts it again.',
          )}
        </p>
      </div>
      {mbaAllume === true && (
        <p className="text-sm text-ink-900" data-testid="repondeur-agent-meta">
          {t('L’agent de Meta est allumé sur cet espace : c’est lui qui répond aujourd’hui.', 'Meta’s agent is on in this workspace: it is the one answering today.')}{' '}
          <Link href="/mba/parametres" className="font-medium text-brand-600 underline" data-testid="repondeur-agent-meta-lien">
            {t('Ouvrir l’agent de Meta', 'Open Meta’s agent')}
          </Link>
        </p>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor="repondeur-choix" className="text-sm font-medium text-ink-900">{t('Agent IA répondeur', 'AI responder agent')}</label>
        <div className="flex flex-wrap gap-2">
          <select
            id="repondeur-choix"
            data-testid="repondeur-choix"
            className={`${inputCls} max-w-sm`}
            value={choix}
            disabled={busy}
            onChange={(e) => { setChoix(e.target.value); setErreur(null); setFait(null); }}
          >
            <option value="">{t('Aucun', 'None')}</option>
            {proposables.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          <Bouton
            type="button"
            data-testid="repondeur-enregistrer"
            onClick={() => void enregistrer()}
            disabled={busy || choix === (repondeurAgentId ?? '')}
            enCours={envoi}
          >
            {envoi ? t('Enregistrement…', 'Saving…') : t('Enregistrer', 'Save')}
          </Bouton>
        </div>
        {proposables.length === 0 && (
          <p className="text-xs text-ink-500" data-testid="repondeur-aucun-actif">
            {t('Activez un agent pour pouvoir le choisir.', 'Activate an agent to be able to choose it.')}
          </p>
        )}
      </div>
      {soldeEpuise && repondeurAgentId !== null && (
        <MbaNotice kind="warning" testid="repondeur-credit">
          {t(
            'Crédit IA épuisé : le répondeur ne répond plus, chaque message passe à votre équipe, dans « À traiter ».',
            'AI credit used up: the responder no longer answers, every message goes to your team, in “To handle”.',
          )}
        </MbaNotice>
      )}
      {erreur && <MbaNotice kind="error" testid="repondeur-erreur">{erreur}</MbaNotice>}
      {fait && <MbaNotice kind="success" testid="repondeur-fait">{fait.texte}</MbaNotice>}
      {fait?.nonRetires && <MbaNotice kind="warning" testid="repondeur-non-retires">{fait.nonRetires}</MbaNotice>}
    </section>
  );
}
