'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import { essayerAgent, estSimule, type AppelTrace, type TourEssai } from '@/lib/api-agent-test';

/**
 * L'onglet TESTER : parler à son agent avant de l'activer.
 *
 * 🔴 CE QUE CET ÉCRAN DOIT MONTRER, ET POURQUOI CE N'EST PAS QUE LA RÉPONSE. Ce qui fait qu'un agent marche
 * ou non, ce sont les outils qu'il choisit d'appeler et les sources qu'il trouve. Un panneau qui n'afficherait
 * que le texte laisserait le client régler à l'aveugle : il verrait une belle réponse sans savoir si elle
 * vient de sa base de connaissance ou de ce que le modèle a imaginé. Chaque appel est donc montré, avec ses
 * arguments et son issue.
 *
 * 🔴 ET IL DIT CE QU'IL NE FAIT PAS. Les outils à effet sont simulés : il n'y a ni contact, ni conversation,
 * ni parcours ici. Le taire ferait croire qu'un tag a été posé, et le client réglerait la suite de sa
 * conversation sur une prémisse fausse.
 */
export function AgentTest({ tenantId, agentId }: { tenantId: string; agentId: string }) {
  const t = useT();
  const [tours, setTours] = useState<TourEssai[]>([]);
  const [appels, setAppels] = useState<AppelTrace[]>([]);
  const [sortie, setSortie] = useState<string | null>(null);
  const [saisie, setSaisie] = useState('');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  async function envoyer(texte: string) {
    const propre = texte.trim();
    if (propre === '' || busy) return;
    const suite: TourEssai[] = [...tours, { role: 'user', content: propre }];
    setTours(suite);
    setSaisie('');
    setBusy(true);
    setErreur(null);
    setAppels([]);
    setSortie(null);
    try {
      const r = await essayerAgent(tenantId, agentId, suite);
      setAppels(r.appels);
      setSortie(r.sortie);
      // `texte: null` est un cas nominal : l'agent sort sans rien dire, c'est le bloc aval qui parlera.
      if (r.texte !== null && r.texte !== '') setTours([...suite, { role: 'assistant', content: r.texte }]);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('L’essai a échoué', 'The try failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <MbaNotice kind="warning">
        {t(
          'Vous parlez au VRAI agent : son prompt, ses outils, sa base de connaissance. Seules les actions qui touchent le monde réel (poser un tag, envoyer un bloc, passer la main) sont simulées, et c’est dit à chaque fois.',
          'You are talking to the REAL agent: its prompt, its tools, its knowledge base. Only actions that touch the real world (tagging, sending a block, handing over) are simulated, and it is stated each time.',
        )}
      </MbaNotice>
      {erreur && <MbaNotice kind="error" testid="test-erreur">{erreur}</MbaNotice>}

      <div className={`${cardCls} flex flex-col gap-3`}>
        {tours.length === 0 && (
          <p data-testid="test-vide" className="text-sm text-ink-500">
            {t('Écrivez ce qu’un client vous écrirait.', 'Write what a customer would write to you.')}
          </p>
        )}
        {tours.map((tour, i) => (
          <div
            key={`${i}-${tour.content.slice(0, 24)}`}
            data-testid={`test-tour-${tour.role}`}
            className={tour.role === 'user'
              ? 'self-end max-w-[85%] rounded-2xl bg-brand-600 px-3 py-2 text-sm text-white'
              : 'self-start max-w-[85%] rounded-2xl bg-ink-100 px-3 py-2 text-sm text-ink-800'}
          >
            {tour.content}
          </div>
        ))}
        {busy && <p className="text-xs text-ink-500">{t('L’agent réfléchit…', 'The agent is thinking…')}</p>}

        <div className="flex flex-wrap gap-2">
          <input
            data-testid="test-saisie"
            className={`${inputCls} flex-1`}
            value={saisie}
            disabled={busy}
            onChange={(e) => setSaisie(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void envoyer(saisie); }}
            placeholder={t('Bonjour, vous avez une piscine ?', 'Hi, do you have a pool?')}
          />
          <button
            data-testid="test-envoyer"
            disabled={busy || saisie.trim() === ''}
            onClick={() => void envoyer(saisie)}
            className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
          >
            {t('Envoyer', 'Send')}
          </button>
        </div>
      </div>

      {sortie !== null && (
        <MbaNotice kind="success" testid="test-sortie">
          {t(
            `L’agent est SORTI par « ${sortie} ». Dans un scénario, c’est cette branche du bloc qui prendrait la suite.`,
            `The agent LEFT through “${sortie}”. In a scenario, that branch of the block would take over.`,
          )}
        </MbaNotice>
      )}

      {appels.length > 0 && (
        <div data-testid="test-appels" className={`${cardCls} flex flex-col gap-2`}>
          <p className="text-sm font-medium text-ink-700">{t('Ce que l’agent a fait', 'What the agent did')}</p>
          {appels.map((a, i) => <Appel key={`${i}-${a.nom}`} appel={a} rang={i} />)}
        </div>
      )}
    </div>
  );
}

/** Un appel d'outil. Le statut et la simulation sont dits AVANT le contenu : c'est ce qu'on lit en premier. */
function Appel({ appel, rang }: { appel: AppelTrace; rang: number }) {
  const t = useT();
  const [ouvert, setOuvert] = useState(false);
  const simule = estSimule(appel);
  return (
    <div data-testid={`test-appel-${rang}`} className="flex flex-col gap-1 rounded-lg border border-ink-200 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-ink-800">{appel.nom}</span>
        {appel.status === 'ok'
          ? <Etiquette classe="bg-emerald-50 text-emerald-700">{t('exécuté', 'ran')}</Etiquette>
          : <Etiquette classe="bg-rose-50 text-rose-800">{appel.status}</Etiquette>}
        {simule && (
          <Etiquette classe="bg-gold/20 text-ink-800">
            <span data-testid={`test-simule-${rang}`}>{t('simulé', 'simulated')}</span>
          </Etiquette>
        )}
      </div>
      <p className="break-all font-mono text-[11px] text-ink-500">{appel.arguments}</p>
      {simule && (
        <p className="text-xs leading-relaxed text-amber-800">
          {t(
            'Rien n’a eu lieu pour de vrai : il n’y a ni contact ni conversation dans un test.',
            'Nothing actually happened: there is no contact and no conversation in a test.',
          )}
        </p>
      )}
      <button
        data-testid={`test-appel-detail-${rang}`}
        onClick={() => setOuvert(!ouvert)}
        className="self-start text-xs text-brand-600 hover:underline"
      >
        {ouvert ? t('Masquer ce qu’il a reçu', 'Hide what it got back') : t('Voir ce qu’il a reçu', 'See what it got back')}
      </button>
      {ouvert && (
        <pre className="max-h-48 overflow-auto rounded-lg bg-ink-50 p-2 text-[11px] leading-relaxed text-ink-700">
          {JSON.stringify(appel.contenu, null, 2)}
        </pre>
      )}
    </div>
  );
}

function Etiquette({ classe, children }: { classe: string; children: React.ReactNode }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${classe}`}>{children}</span>;
}
