'use client';

import { useCallback, useEffect, useState } from 'react';
import { toDataURL } from 'qrcode';
import { AppShell } from '@/components/AppShell';
import { Bouton } from '@/components/Bouton';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { Icone } from '@/components/Icone';
import { Squelette } from '@/components/Squelette';
import { Toggle } from '@/components/Toggle';
import { useConfirmation } from '@/components/Confirmation';
import { WidgetApercu } from '@/components/WidgetApercu';
import { WidgetFormulaire } from '@/components/WidgetFormulaire';
import type { Session } from '@/lib/session';
import { listWorkflows, type WorkflowSummary } from '@/lib/api';
import { erreurDeChargement, estAnnulation } from '@/lib/http';
import { useT } from '@/lib/i18n';
import { cardCls, kickerCls } from '@/lib/ui';
import {
  LIMITE_WIDGETS, creerWidget, ecartsDeSaisie, listerWidgets, modifierWidget, saisieDuWidget, supprimerWidget,
  type SaisieWidget, type Widget,
} from '@/lib/widgets';

/**
 * Widget WhatsApp : la bulle que le client pose sur son site. Le visiteur clique, WhatsApp s'ouvre avec un message
 * déjà écrit, il l'envoie : c'est lui qui parle le premier, donc la conversation s'ouvre sans modèle approuvé.
 *
 * L'écran fait trois choses, et le code à copier est la plus importante : une balise posée chez un client doit
 * répondre pour toujours, elle se copie telle que le serveur l'a composée, jamais recomposée ici.
 */
export default function WidgetsPage() {
  return <AppShell active="widgets">{(session) => <WidgetsInner session={session} />}</AppShell>;
}

type Edition = { mode: 'creation' } | { mode: 'modification'; widget: Widget };

function WidgetsInner({ session }: { session: Session }) {
  const t = useT();
  const confirmer = useConfirmation();
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [limite, setLimite] = useState(LIMITE_WIDGETS);
  const [scenarios, setScenarios] = useState<WorkflowSummary[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [edition, setEdition] = useState<Edition | null>(null);
  const [enCours, setEnCours] = useState(false);

  const charger = useCallback(async () => {
    setErreur(null);
    try {
      const [w, s] = await Promise.all([listerWidgets(session.tenantId), listWorkflows(session.tenantId)]);
      // Lecture défensive au bord du réseau : une 200 sans le champ attendu poserait `undefined` dans un état typé
      // tableau, et le premier `.map` démonterait l'écran.
      setWidgets(Array.isArray(w?.widgets) ? w.widgets : []);
      setLimite(typeof w?.limite === 'number' ? w.limite : LIMITE_WIDGETS);
      setScenarios(Array.isArray(s?.workflows) ? s.workflows : []);
    } catch (err) {
      if (estAnnulation(err)) return;
      setErreur(erreurDeChargement(err, t));
    } finally {
      setChargement(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => { void charger(); }, [charger]);

  async function enregistrer(saisie: SaisieWidget): Promise<void> {
    if (edition === null) return;
    setEnCours(true);
    setErreur(null);
    try {
      if (edition.mode === 'creation') {
        await creerWidget(session.tenantId, saisie);
      } else {
        // Seul l'écart part : voir `ecartsDeSaisie`. Rien de changé, rien à envoyer.
        const ecarts = ecartsDeSaisie(saisieDuWidget(edition.widget), saisie);
        if (Object.keys(ecarts).length > 0) await modifierWidget(session.tenantId, edition.widget.id, ecarts);
      }
      setEdition(null);
      await charger();
    } catch (err) {
      // Le refus du serveur est lisible tel quel (phrase en conflit, déjà vue, limite) : il s'affiche, et le
      // formulaire reste ouvert avec la saisie.
      setErreur(err instanceof Error ? err.message : t('Enregistrement impossible', 'Could not save'));
    } finally {
      setEnCours(false);
    }
  }

  async function basculer(w: Widget): Promise<void> {
    setErreur(null);
    try {
      await modifierWidget(session.tenantId, w.id, { actif: !w.actif });
      await charger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Modification impossible', 'Could not update'));
    }
  }

  async function supprimer(w: Widget): Promise<void> {
    const ok = await confirmer({
      titre: t('Supprimer le widget', 'Delete the widget'),
      message: t(
        `Supprimer « ${w.nom} » ? La bulle disparaîtra du site où sa balise est posée. Les conversations déjà arrivées par ce widget gardent leur étiquette.`,
        `Delete “${w.nom}”? The bubble will disappear from the site where its tag is placed. Conversations that already came through this widget keep their tag.`,
      ),
      confirmer: t('Supprimer', 'Delete'),
    });
    if (!ok) return;
    setErreur(null);
    try {
      await supprimerWidget(session.tenantId, w.id);
      await charger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Suppression impossible', 'Deletion failed'));
    }
  }

  const complet = widgets.length >= limite;

  return (
    <div className="mx-auto max-w-liste space-y-6 px-4 py-8">
      <header>
        <p className={kickerCls}>{t('Votre site', 'Your website')}</p>
        <TitrePage className="mt-1">{t('Widget WhatsApp', 'WhatsApp widget')}</TitrePage>
        <IntroPage>
          {t(
            'Une bulle WhatsApp sur votre site : le visiteur clique, WhatsApp s’ouvre avec un message déjà écrit, et la conversation arrive dans votre Inbox.',
            'A WhatsApp bubble on your website: the visitor clicks, WhatsApp opens with a message already typed, and the conversation lands in your Inbox.',
          )}
        </IntroPage>
      </header>

      {erreur && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700" data-testid="widgets-erreur">{erreur}</p>}

      {edition !== null ? (
        <WidgetFormulaire
          key={edition.mode === 'creation' ? 'creation' : edition.widget.id}
          initial={edition.mode === 'creation' ? null : edition.widget}
          scenarios={scenarios}
          enCours={enCours}
          onAnnuler={() => { setEdition(null); setErreur(null); }}
          onEnregistrer={enregistrer}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-500" data-testid="widgets-compte">
            {t(`${widgets.length} widget(s) sur ${limite} possibles`, `${widgets.length} of ${limite} widgets`)}
          </p>
          <Bouton
            onClick={() => { setErreur(null); setEdition({ mode: 'creation' }); }}
            disabled={chargement || complet}
            title={complet ? t('Limite atteinte : supprimez un widget pour en créer un autre.', 'Limit reached: delete a widget to create another one.') : undefined}
            data-testid="widget-nouveau"
          >
            <Icone nom="ajouter" />
            {t('Nouveau widget', 'New widget')}
          </Bouton>
        </div>
      )}

      {chargement ? (
        <div className={cardCls}><Squelette forme="lignes" /></div>
      ) : widgets.length === 0 ? (
        edition === null && (
          <p className={`${cardCls} text-sm text-ink-500`}>
            {t('Aucun widget pour l’instant : créez-en un, puis collez sa balise sur votre site.', 'No widget yet: create one, then paste its tag on your website.')}
          </p>
        )
      ) : (
        <ul className="space-y-4" data-testid="widgets-liste">
          {widgets.map((w) => (
            <CarteWidget
              key={w.id}
              widget={w}
              scenarios={scenarios}
              onModifier={() => { setErreur(null); setEdition({ mode: 'modification', widget: w }); }}
              onBasculer={() => { void basculer(w); }}
              onSupprimer={() => { void supprimer(w); }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CarteWidget({ widget: w, scenarios, onModifier, onBasculer, onSupprimer }: {
  widget: Widget;
  scenarios: WorkflowSummary[];
  onModifier: () => void;
  onBasculer: () => void;
  onSupprimer: () => void;
}) {
  const t = useT();
  const [copie, setCopie] = useState(false);

  const devenir = w.devenir === 'mba'
    ? t('L’agent de Meta répond.', 'Meta’s agent answers.')
    : w.devenir === 'scenario'
      ? (w.workflowId !== null
        ? t(`Démarre le scénario « ${scenarios.find((s) => s.id === w.workflowId)?.name ?? 'inconnu'} ».`, `Starts the scenario “${scenarios.find((s) => s.id === w.workflowId)?.name ?? 'unknown'}”.`)
        : null)
      : w.devenir === 'agent'
        ? t('Un agent IA (à venir) : traité comme le réglage de l’espace.', 'An AI agent (coming soon): handled as the workspace setting.')
        : t('Répond comme les autres conversations (le réglage de l’espace).', 'Answered like other conversations (the workspace setting).');

  function copier(): void {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(w.balise).then(() => setCopie(true), () => setCopie(false));
  }

  return (
    <li className={`${cardCls} space-y-4`} data-testid={`widget-${w.code}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink-900">{w.nom}</h2>
          <p className="mt-0.5 text-sm text-ink-500">
            {t('Message : ', 'Message: ')}<span className="text-ink-900">{w.phrase}</span>
          </p>
          {w.scenarioSupprime ? (
            <p className="mt-1 text-sm text-danger-700" data-testid="widget-scenario-supprime">
              {t('Scénario supprimé : ce widget ne démarre plus rien. ', 'Scenario deleted: this widget no longer starts anything. ')}
              <button type="button" onClick={onModifier} className="font-medium underline">{t('Choisir un autre scénario', 'Choose another scenario')}</button>
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-900">{devenir}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Toggle
            checked={w.actif}
            onChange={onBasculer}
            title={w.actif ? t('Éteindre : la bulle disparaît du site', 'Turn off: the bubble disappears from the site') : t('Rallumer', 'Turn on')}
            testid={`widget-actif-${w.code}`}
          />
          <Bouton variante="secondaire" taille="petite" onClick={onModifier}>
            <Icone nom="modifier" taille="petite" />{t('Modifier', 'Edit')}
          </Bouton>
          <Bouton variante="discret" taille="petite" onClick={onSupprimer} aria-label={t('Supprimer', 'Delete')}>
            <Icone nom="supprimer" taille="petite" />
          </Bouton>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium text-ink-900">{t('Le code à coller sur votre site', 'The code to paste on your website')}</p>
            <p className="mt-0.5 text-xs text-ink-500">
              {t('Juste avant la balise </body>, sur chaque page où la bulle doit apparaître.', 'Just before the </body> tag, on every page where the bubble should appear.')}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-controle bg-ink-50 px-3 py-2 font-mono text-xs text-ink-900" data-testid="widget-balise">{w.balise}</code>
              <Bouton variante="secondaire" onClick={copier} className="shrink-0" data-testid="widget-copier">
                {copie ? t('Copié', 'Copied') : t('Copier', 'Copy')}
              </Bouton>
            </div>
          </div>
          {!w.actif && (
            <p className="text-sm text-ink-500">{t('Éteint : la balise reste posée, la bulle n’apparaît plus.', 'Off: the tag stays in place, the bubble no longer appears.')}</p>
          )}
          <QrDuLien lien={w.waMeUrl} />
        </div>
        <WidgetApercu
          couleur={w.couleur}
          position={w.position}
          libelle={w.libelle}
          avatarUrl={w.avatarUrl}
          badge={w.badge}
          grisee={w.waMeUrl === null}
        />
      </div>
    </li>
  );
}

/**
 * Le QR code du lien `wa.me`, dessiné ICI, dans le navigateur, par la bibliothèque déjà présente : celui que le
 * visiteur d'un ordinateur scannera. Sans numéro relié, il n'y a pas de lien, et la bulle s'affiche grisée.
 */
function QrDuLien({ lien }: { lien: string | null }) {
  const t = useT();
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    if (lien === null) { setQr(null); return; }
    toDataURL(lien, { margin: 1, width: 160 }).then((u) => { if (vivant) setQr(u); }, () => { if (vivant) setQr(null); });
    return () => { vivant = false; };
  }, [lien]);

  if (lien === null) {
    return (
      <p className="rounded-controle bg-alerte-50 px-3 py-2 text-sm text-alerte-800" data-testid="widget-sans-numero">
        {t(
          'Aucun numéro WhatsApp relié à cet espace : la bulle s’affiche grisée, sans clic possible.',
          'No WhatsApp number linked to this workspace: the bubble shows greyed out, and cannot be clicked.',
        )}
      </p>
    );
  }
  return (
    <div className="flex items-center gap-3">
      {qr && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} width={96} height={96} alt={t('QR code du lien WhatsApp', 'QR code of the WhatsApp link')} data-testid="widget-qr" />
      )}
      <a href={lien} target="_blank" rel="noopener noreferrer" className="text-sm text-brand-600 hover:underline">
        {t('Essayer le lien WhatsApp', 'Try the WhatsApp link')}
      </a>
    </div>
  );
}
