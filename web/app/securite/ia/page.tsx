'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { useT } from '@/lib/i18n';
import {
  politiqueMentionIa, politiqueTransfertAgent, setPolitiqueMentionIa, setPolitiqueTransfertAgent,
  type FrequenceMentionIa, type ModeTransfertAgent, type PolitiqueMentionIa, type PolitiqueTransfertAgent,
} from '@/lib/api';
import { cadreCls } from '@/lib/ui';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { Squelette } from '@/components/Squelette';

/**
 * L'IA, ET CE QU'ELLE DIT D'ELLE-MÊME.
 *
 * 🔴 UNE POLITIQUE PAR ESPACE, PAS UNE PAR AGENT. L'AI Act, article 50, fait peser l'obligation
 * d'information sur la marque DÉPLOYANTE : trois agents ne sont pas trois marques, et trois réponses
 * différentes seraient trois politiques, ce qui n'existe pas juridiquement. C'est pour ça que ce réglage a
 * quitté la fiche de l'agent.
 *
 * 🔴 L'ÉCRAN MONTRE AUSSI LA PHRASE DE CHAQUE AGENT, et c'est ce qui en fait autre chose qu'un interrupteur.
 * Le régime dit QUAND on annonce ; il ne dit pas CE QU'ON ANNONCE, qui reste la voix de chaque agent.
 * Montrer le réglage sans montrer le texte qu'il déclenche, ce serait promettre une vérification qu'on ne
 * permet pas de faire.
 */
export default function SecuriteIaPage() {
  return <AppShell active="securite-ia">{(session) => <Ia tenantId={session.tenantId} estAdmin={session.role === 'admin'} />}</AppShell>;
}

/** Les trois régimes, dits en français plutôt qu'en code : c'est une décision légale prise par un humain. */
function libelles(t: (fr: string, en: string) => string): Array<{ valeur: FrequenceMentionIa; titre: string; texte: string }> {
  return [
    {
      valeur: 'session',
      titre: t('Une fois par conversation', 'Once per conversation'),
      texte: t(
        'La phrase part au premier message de l’agent, puis plus du tout tant que la conversation dure.',
        'The sentence is said on the agent’s first message, then not again for the rest of the conversation.',
      ),
    },
    {
      valeur: 'chaque_message',
      titre: t('À chaque message', 'On every message'),
      texte: t(
        'La phrase accompagne chaque réponse de l’agent. Le plus explicite, et le plus lourd à lire.',
        'The sentence goes with every reply. The most explicit option, and the heaviest to read.',
      ),
    },
    {
      valeur: 'jamais',
      titre: t('Jamais', 'Never'),
      texte: t(
        'L’agent ne l’annonce pas. C’est un choix qui vous appartient : la loi n’impose l’information que lorsqu’elle n’est pas évidente du contexte.',
        'The agent does not disclose it. This is your call: the law only requires disclosure when it is not obvious from context.',
      ),
    },
  ];
}

function Ia({ tenantId, estAdmin }: { tenantId: string; estAdmin: boolean }) {
  const t = useT();
  const [etat, setEtat] = useState<PolitiqueMentionIa | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enregistre, setEnregistre] = useState(false);

  useEffect(() => {
    let vivant = true;
    politiqueMentionIa(tenantId)
      .then((r) => { if (vivant) setEtat(r); })
      // ⚠️ Un échec de lecture n'est PAS « aucune politique » : sur un écran de conformité, « on n'a pas pu
      // lire » et « personne n'annonce rien » appellent des réactions opposées.
      .catch(() => { if (vivant) setErreur(t('Le réglage n’a pas pu être lu.', 'The setting could not be read.')); });
    return () => { vivant = false; };
  }, [tenantId, t]);

  /**
   * ⚠️ LE BOUTON BOUGE D'ABORD, ET REVIENT EN ARRIÈRE SI L'ÉCRITURE ÉCHOUE. Une radio contrôlée qui n'avance
   * qu'après la réponse du serveur laisse l'utilisateur cliquer dans le vide le temps de l'aller-retour, et
   * c'est le genre de latence qu'on ne voit pas en développement. Le retour arrière est ce qui rend
   * l'optimisme honnête : sans lui, l'écran afficherait un choix que la base n'a pas.
   */
  async function choisir(frequence: FrequenceMentionIa): Promise<void> {
    const avant = etat;
    setErreur(null);
    setEnregistre(false);
    setEtat((e) => (e ? { ...e, frequence, reglee: true } : e));
    try {
      await setPolitiqueMentionIa(tenantId, frequence);
      setEnregistre(true);
    } catch (e) {
      setEtat(avant);
      setErreur(e instanceof Error ? e.message : t('Le réglage n’a pas pu être enregistré.', 'The setting could not be saved.'));
    }
  }

  return (
    <div className="mx-auto w-full max-w-formulaire space-y-4" data-testid="securite-ia">
      <div className="space-y-1">
        <TitrePage>{t('IA', 'AI')}</TitrePage>
        <IntroPage>
          {t(
            'Ce choix vaut pour tout l’espace : l’obligation d’informer pèse sur votre marque, pas sur chaque agent.',
            'This choice applies to the whole workspace: the duty to inform lies with your brand, not with each agent.',
          )}
        </IntroPage>
      </div>

      <section className={cadreCls} data-testid="mention-ia">
        <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
          <span className="text-sm font-semibold text-ink-900">{t('Quand l’annoncer', 'When to disclose')}</span>
          {/* ⚠️ « Défaut appliqué » n'est PAS la même chose que « vous avez choisi ceci ». Le comportement est
              identique, la responsabilité non, et c'est précisément ce qu'un écran de conformité doit dire. */}
          {etat !== null && !etat.reglee && (
            <span className="text-xs text-ink-500" data-testid="mention-ia-defaut">
              {t('défaut appliqué, personne n’a encore choisi', 'default applied, nobody has chosen yet')}
            </span>
          )}
        </div>

        {erreur !== null && <p className="px-4 py-3 text-sm text-danger-700" data-testid="mention-ia-erreur">{erreur}</p>}
        {etat === null && erreur === null && <Squelette forme="lignes" className="px-4 py-3" />}

        {etat !== null && (
          <div className="divide-y divide-ink-100">
            {libelles(t).map((o) => (
              <label key={o.valeur} className="flex cursor-pointer items-start gap-3 px-4 py-3" data-testid={`mention-ia-${o.valeur}`}>
                <input
                  type="radio"
                  name="mention-ia"
                  className="mt-1"
                  disabled={!estAdmin}
                  checked={etat.frequence === o.valeur}
                  onChange={() => { void choisir(o.valeur); }}
                />
                <span className="min-w-0">
                  <span className="block text-sm text-ink-900">{o.titre}</span>
                  <span className="block text-xs text-ink-500">{o.texte}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        {enregistre && erreur === null && (
          <p className="px-4 pb-3 text-xs text-succes-700" data-testid="mention-ia-ok">{t('Enregistré.', 'Saved.')}</p>
        )}
        {etat !== null && !estAdmin && (
          <p className="px-4 pb-3 text-xs text-ink-500">
            {t('Seul un administrateur peut changer ce réglage.', 'Only an administrator can change this setting.')}
          </p>
        )}
      </section>

      <TransfertEquipe tenantId={tenantId} estAdmin={estAdmin} />

      {/*
        🔴 LE META BUSINESS AGENT N'EST PAS GOUVERNÉ PAR CE RÉGLAGE, et le taire serait le plus grave défaut
        possible sur cet écran : un client lirait « mes IA se déclarent » et ce serait faux pour l'une
        d'elles. Meta appose sa propre mention sous les messages de son agent ; ajouter la nôtre en ferait
        deux.
      */}
      <section className={cadreCls} data-testid="mention-ia-agents">
        <div className="border-b border-ink-100 px-4 py-3">
          <span className="text-sm font-semibold text-ink-900">{t('Ce que chaque agent dit', 'What each agent says')}</span>
          <p className="mt-1 text-xs text-ink-500">
            {t(
              'La phrase appartient à l’agent, c’est sa voix ; le réglage ci-dessus décide quand elle est dite. Elle se modifie depuis la fiche de l’agent.',
              'The sentence belongs to the agent, it is its voice; the setting above decides when it is said. It is edited from the agent’s page.',
            )}
          </p>
        </div>

        {etat !== null && etat.agents.length === 0 && (
          <p className="px-4 py-3 text-sm text-ink-500" data-testid="mention-ia-agents-vide">
            {t('Aucun agent IA sur cet espace.', 'No AI agent in this workspace.')}
          </p>
        )}
        {etat !== null && etat.agents.length > 0 && (
          <ul className="divide-y divide-ink-100">
            {etat.agents.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-3 px-4 py-2" data-testid="mention-ia-agent">
                <div className="min-w-0">
                  <p className="text-sm text-ink-900">
                    {a.label}
                    {a.status !== 'active' && (
                      <span className="ml-2 text-xs text-ink-500">
                        {a.status === 'draft' ? t('brouillon', 'draft') : t('désactivé', 'disabled')}
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-ink-500">« {a.mentionIa} »</p>
                </div>
                <Link href={`/agents?a=${a.id}`} className="shrink-0 text-xs font-medium text-brand-600 hover:underline">
                  {t('Ouvrir la fiche', 'Open the agent')}
                </Link>
              </li>
            ))}
          </ul>
        )}

        <p className="border-t border-ink-100 px-4 py-3 text-xs text-ink-500" data-testid="mention-ia-mba">
          {t(
            'L’agent de Meta (Meta Business Agent) n’est pas concerné par ce réglage : Meta appose déjà sa propre mention sous ses messages, et ajouter la nôtre en ferait deux.',
            'Meta’s agent (Meta Business Agent) is not covered by this setting: Meta already adds its own notice under its messages, and adding ours would make two.',
          )}
        </p>
      </section>
    </div>
  );
}

/**
 * QUAND L'ÉQUIPE EST JOIGNABLE, ET CE QUE L'AGENT A LE DROIT DE PROMETTRE (lot 1 du 2026-09-18).
 *
 * 🔴 IL NE DÉCIDE PAS SI ON TRANSFÈRE, et l'écran le DIT. La conversation arrive dans « À traiter » dans
 * tous les cas : une phrase « nous revenons vers vous » sans ligne de travail derrière serait un mensonge
 * poli, et un client qui croirait couper le transfert laisserait des demandes sans personne.
 *
 * 🔴 SA PLACE EST ICI, à côté de l'annonce d'IA, parce que les deux règlent la même chose : ce qu'un robot
 * DIT au nom de la marque. Ce sont les deux seules lignes de la configuration d'un agent qui engagent autre
 * chose que son efficacité.
 */
function TransfertEquipe({ tenantId, estAdmin }: { tenantId: string; estAdmin: boolean }) {
  const t = useT();
  const [etat, setEtat] = useState<PolitiqueTransfertAgent | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enregistre, setEnregistre] = useState(false);

  useEffect(() => {
    let vivant = true;
    void politiqueTransfertAgent(tenantId)
      .then((r) => { if (vivant) setEtat(r); })
      .catch((e) => { if (vivant) setErreur(e instanceof Error ? e.message : 'lecture impossible'); });
    return () => { vivant = false; };
  }, [tenantId]);

  async function choisir(mode: ModeTransfertAgent): Promise<void> {
    if (!etat || etat.mode === mode) return;
    setErreur(null);
    setEnregistre(false);
    // ⚠️ OPTIMISTE, PUIS REMIS EN PLACE SI ÇA ÉCHOUE : sans le retour en arrière, l'écran afficherait un
    // choix que la base n'a pas, sur un réglage qui décide de ce qu'un robot promet à un contact.
    const avant = etat;
    setEtat({ mode, reglee: true });
    try {
      await setPolitiqueTransfertAgent(tenantId, mode);
      setEnregistre(true);
    } catch (e) {
      setEtat(avant);
      setErreur(e instanceof Error ? e.message : 'enregistrement impossible');
    }
  }

  const choix: Array<{ valeur: ModeTransfertAgent; titre: string; texte: string }> = [
    {
      valeur: 'always',
      titre: t('À toute heure', 'At any time'),
      texte: t(
        'L’agent annonce qu’un conseiller prend le relais, quelle que soit l’heure. À choisir si quelqu’un répond la nuit et le week-end.',
        'The agent announces that a human is taking over, whatever the time. Choose this if someone answers at night and on weekends.',
      ),
    },
    {
      valeur: 'business_hours',
      titre: t('Seulement aux heures d’ouverture', 'Only during business hours'),
      texte: t(
        'Hors de vos horaires, l’agent n’annonce pas de conseiller : il dit quand votre équipe reprend, en calculant la vraie prochaine ouverture. Un samedi, il annonce lundi, pas demain.',
        'Outside your hours, the agent does not announce a human: it says when your team is back, computing the real next opening. On a Saturday it says Monday, not tomorrow.',
      ),
    },
    {
      valeur: 'never',
      titre: t('Jamais en direct', 'Never live'),
      texte: t(
        'L’agent ne promet ni conseiller ni délai. Il dit simplement que la demande est transmise.',
        'The agent promises neither a human nor a delay. It simply says the request has been passed on.',
      ),
    },
  ];

  return (
    <section className={cadreCls} data-testid="transfert-agent">
      <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
        <span className="text-sm font-semibold text-ink-900">{t('Quand votre équipe est joignable', 'When your team is reachable')}</span>
        {etat !== null && !etat.reglee && (
          <span className="text-xs text-ink-500" data-testid="transfert-agent-defaut">
            {t('défaut appliqué, personne n’a encore choisi', 'default applied, nobody has chosen yet')}
          </span>
        )}
      </div>

      <p className="px-4 pt-3 text-xs text-ink-500">
        {/* 🔴 LA PHRASE QUI EMPÊCHE LE CONTRESENS. Sans elle, un client lit « jamais » et croit avoir coupé
            le transfert, alors que la conversation remonte toujours. */}
        {t(
          'Ce réglage ne coupe jamais le transfert : la conversation arrive dans « À traiter » dans tous les cas. Il décide de ce que votre agent a le droit de promettre au contact.',
          'This setting never disables handover: the conversation always lands in “To handle”. It decides what your agent may promise to the contact.',
        )}
      </p>

      {erreur !== null && <p className="px-4 py-3 text-sm text-danger-700" data-testid="transfert-agent-erreur">{erreur}</p>}
      {etat === null && erreur === null && <Squelette forme="lignes" className="px-4 py-3" />}

      {etat !== null && (
        <div className="mt-2 divide-y divide-ink-100 border-t border-ink-100">
          {choix.map((o) => (
            <label key={o.valeur} className="flex cursor-pointer items-start gap-3 px-4 py-3" data-testid={`transfert-agent-${o.valeur}`}>
              <input
                type="radio"
                name="transfert-agent"
                className="mt-1"
                disabled={!estAdmin}
                checked={etat.mode === o.valeur}
                onChange={() => { void choisir(o.valeur); }}
              />
              <span className="min-w-0">
                <span className="block text-sm text-ink-900">{o.titre}</span>
                <span className="block text-xs text-ink-500">{o.texte}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {enregistre && erreur === null && (
        <p className="px-4 pb-3 pt-2 text-xs text-succes-700" data-testid="transfert-agent-ok">{t('Enregistré.', 'Saved.')}</p>
      )}
      {etat !== null && !estAdmin && (
        <p className="px-4 pb-3 pt-2 text-xs text-ink-500">
          {t('Seul un administrateur peut changer ce réglage.', 'Only an administrator can change this setting.')}
        </p>
      )}
    </section>
  );
}
