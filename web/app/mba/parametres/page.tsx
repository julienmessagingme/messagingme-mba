'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { useT } from '@/lib/i18n';
import { getAccountStatus, type AccountStatusResponse } from '@/lib/api';
import {
  getMbaStatus, getMbaCompletion, getMbaMessages,
  type CompletionMba, type MbaSettings, type MbaStatus,
} from '@/lib/api-mba';
import { LIBELLES } from '@/lib/libelles-mba';
import { MbaTabs } from '@/components/MbaTabs';
import { EnteteAgent } from '@/components/EnteteAgent';
import { PastilleNumero } from '@/components/PastilleNumero';
import { MbaAssistantPanel } from '@/components/MbaAssistantPanel';
import { HistoriquePanel } from '@/components/HistoriquePanel';
import { MbaNotice } from '@/components/MbaNotice';
import { MbaGateBanner } from '@/components/MbaGateBanner';
import { MbaOverviewPanel } from '@/components/MbaOverviewPanel';
import { MbaActivationPanel } from '@/components/MbaActivationPanel';
import { MbaBusinessInfoPanel } from '@/components/MbaBusinessInfoPanel';
import { MbaFaqPanel } from '@/components/MbaFaqPanel';
import { MbaSkillsPanel } from '@/components/MbaSkillsPanel';
import { MbaWebsitesPanel } from '@/components/MbaWebsitesPanel';
import { MbaFilesPanel } from '@/components/MbaFilesPanel';
import { MbaTestPanel } from '@/components/MbaTestPanel';
import { OutilsMba } from '@/components/mba-outils/OutilsMba';

export default function MbaSettingsPage() {
  // `useSearchParams` impose une frontière Suspense au build (règle Next 15), sinon la page bascule en rendu
  // dynamique et `next build` échoue.
  return (
    <AppShell active="mba-settings">
      {(session) => (
        <Suspense fallback={null}>
          {/* `isAdmin` descend d'ici parce que l'onglet Outils en a besoin : la création d'un outil pour
              Meta et la publication chez Meta sont réservées aux administrateurs, comme toutes les routes de
              `mba-outils` (`g.admin`). Le déduire plus bas aurait fait deux vérités sur un même droit. */}
          <MbaSettings tenantId={session.tenantId} isAdmin={session.role === 'admin'} />
        </Suspense>
      )}
    </AppShell>
  );
}

// ⚠️ « assistant » EN DEUXIÈME, après l'aperçu : un onglet parmi les autres (décision de Julien), pas la
// porte d'entrée. En faire le premier déplacerait les repères de ceux qui utilisent déjà l'écran.
// ⚠️ « outils » APRÈS « competences », et le voisinage est le bon : une compétence dit QUOI FAIRE en
// langage naturel, un outil est ce que l'agent peut APPELER. Les deux répondent à « de quoi il est capable ».
const ONGLETS = ['apercu', 'assistant', 'activation', 'business', 'faq', 'competences', 'outils', 'fichiers', 'sites', 'historique', 'test'] as const;
type Onglet = (typeof ONGLETS)[number];

function lireOnglet(v: string | null): Onglet {
  return v !== null && (ONGLETS as readonly string[]).includes(v) ? (v as Onglet) : 'apercu';
}

/**
 * Configuration de l'agent MBA, branchée sur les routes `/tenants/:t/mba/:phoneNumberId/*`.
 *
 * Trois états, là où la maquette précédente n'en connaissait qu'un seul (« bloqué ») : pas de numéro, numéro
 * pas encore ouvert par Meta, et le cas normal. `onboarded: false` n'est PAS un blocage : seules les
 * compétences exigent que Meta ait créé la configuration, tout le reste s'édite déjà.
 */
function MbaSettings({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const onglet = lireOnglet(params.get('tab'));

  const [phoneNumberId, setPhoneNumberId] = useState<string | null>(null);
  // La réponse ENTIÈRE du compte, et pas seulement l'identifiant du numéro : l'en-tête y lit le nom
  // d'affichage, le numéro et la pastille d'état. N'en garder qu'un champ obligerait à la relire ailleurs.
  const [compte, setCompte] = useState<AccountStatusResponse | null>(null);
  const [status, setStatus] = useState<MbaStatus | null>(null);
  const [chargement, setChargement] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let vivant = true;
    (async () => {
      const c = await getAccountStatus(tenantId);
      if (!vivant) return;
      // AVANT la sortie anticipée : sans numéro, l'écran est bloqué mais l'en-tête garde du sens (la
      // pastille dit pourquoi). Le poser après aurait laissé l'en-tête muet sur le seul état où il informe.
      setCompte(c);
      if (!c.hasNumber || c.phoneNumberId === null) return;
      setPhoneNumberId(c.phoneNumberId);
      const s = await getMbaStatus(tenantId, c.phoneNumberId);
      if (vivant) setStatus(s);
    })()
      .catch((e: unknown) => { if (vivant) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (vivant) setChargement(false); });
    return () => { vivant = false; };
  }, [tenantId]);

  /**
   * 🔴 DEUX EFFETS À PART, ET DEUX `.catch` QUI AVALENT. Les joindre à la chaîne ci-dessus les ferait tomber
   * dans SON `.catch` unique, qui rend la page entière comme une erreur (`mba-page-error`) : un 404 (la
   * console publiée chez Vercel avant le déploiement de l'API) ou un 403 (compte non administrateur)
   * effacerait alors un écran parfaitement utilisable. Ici, la valeur reste à `null` et l'en-tête n'affiche
   * simplement pas ce qu'il ne sait pas.
   *
   * 🔴 ET ILS NE PARTENT QUE SI L'ÉCRAN PEUT SERVIR À QUELQUE CHOSE, c'est-à-dire si Meta a ouvert l'agent
   * sur ce numéro. Un numéro CONNECTÉ mais pas encore ouvert pose `phoneNumberId` (il vient de
   * `getAccountStatus`) alors que l'écran restera sur sa bannière de blocage quel que soit l'onglet demandé.
   * Or `/completion` ne regarde PAS l'éligibilité côté serveur : elle interroge les informations, les FAQ,
   * les sites et les fichiers, donc elle rend de vraies tâches `a_faire` (« aucune FAQ » en premier). Sans
   * cette garde, l'en-tête annonçait « 1 étape à finir » avec un bouton qui change l'URL et ne produit
   * RIEN : le motif « offert-et-inerte », que ce produit s'interdit. Et c'est le cas COURANT d'un client qui
   * vient de connecter son numéro, pas un cas limite.
   *
   * ⚠️ La dépendance est le BOOLÉEN, pas l'objet `status` : `majReglages` en reconstruit un à chaque
   * enregistrement de réglage, ce qui relancerait les deux lectures réseau à chaque bascule d'interrupteur.
   * Ce qui décide ici est l'éligibilité, et elle, elle ne change pas quand on enregistre.
   */
  const eligible = status?.eligible === true;

  const [messages, setMessages] = useState<number | null>(null);
  useEffect(() => {
    if (phoneNumberId === null || !eligible) return;
    let vivant = true;
    void getMbaMessages(tenantId, phoneNumberId)
      .then((r) => { if (vivant) setMessages(r.messages); })
      .catch(() => { if (vivant) setMessages(null); });
    return () => { vivant = false; };
  }, [tenantId, phoneNumberId, eligible]);

  // La complétion se lit ICI depuis que l'en-tête l'affiche (elle vivait dans `MbaCompletion`, supprimé) :
  // l'en-tête est purement présentationnel, il n'appelle rien lui-même.
  const [completion, setCompletion] = useState<CompletionMba | null>(null);
  useEffect(() => {
    if (phoneNumberId === null || !eligible) return;
    let vivant = true;
    void getMbaCompletion(tenantId, phoneNumberId)
      .then((r) => { if (vivant && Array.isArray(r?.taches)) setCompletion(r); })
      .catch(() => { if (vivant) setCompletion(null); });
    return () => { vivant = false; };
  }, [tenantId, phoneNumberId, eligible]);

  // L'onglet vit dans l'adresse : la page est partageable, et le navigateur retrouve où on en était.
  const choisirOnglet = useCallback((cle: string) => {
    router.replace(`/mba/parametres?tab=${cle}`, { scroll: false });
  }, [router]);

  const majReglages = useCallback((settings: MbaSettings) => {
    setStatus((s) => (s === null ? s : {
      ...s,
      settings,
      onboarded: true,
      agentId: typeof settings.agent_id === 'string' ? settings.agent_id : s.agentId,
    }));
  }, []);

  /**
   * 🔴 RENDU DANS LES CINQ ÉTATS, y compris les deux blocages et le chargement : il est à l'intérieur de
   * `coquille`. Il doit donc tenir avec `compte === null` (titre générique, aucune précision, aucun état) et
   * avec `completion === null` (aucune étape, aucun ratio). Un en-tête qui n'apparaîtrait qu'une fois tout
   * chargé ferait sauter la page au moment où la lecture aboutit.
   */
  const entete = (
    <EnteteAgent
      logo={{ src: '/meta-business-agent.png', alt: '' }}
      pastille="MB"
      // ⚠️ NI TRADUIT NI ABRÉGÉ : « Meta Business Agent » est le nom du produit de META, il reste tel quel
      // partout (CLAUDE.md). C'est lui qui dit CE QUE cet écran règle, puisque `nom` porte l'identité du
      // NUMÉRO et pas un titre d'écran.
      surTitre="Meta Business Agent"
      // ⚠️ LE REPLI NOMME L'ÉCRAN, PAS « L'AGENT ». Il ne sert que dans les états sans compte (chargement,
      // aucun numéro, numéro non éligible) : « Paramètres de l'agent » y laissait le lecteur sans savoir
      // DUQUEL des deux répondeurs de la console il s'agissait.
      nom={compte?.verifiedName ?? t('Paramètres du Meta Business Agent', 'Meta Business Agent settings')}
      // ⚠️ `number` n'est PAS normalisé par le serveur : le préfixe `+` se pose à l'affichage, exactement
      // comme sur l'Accueil (`web/app/accueil/page.tsx`). Deux gestes différents feraient deux numéros.
      precision={compte?.number ? (compte.number.startsWith('+') ? compte.number : `+${compte.number}`) : undefined}
      etat={compte?.status ? <PastilleNumero status={compte.status} /> : undefined}
      // 🔴 `null` TANT QU'ON N'A PAS LU LA COMPLÉTION, jamais une liste vide : `[]` ferait annoncer « Tout
      // est réglé » pendant le chargement et sur les deux écrans bloqués, à côté d'un bandeau qui dit qu'il
      // n'y a pas de numéro. C'est le défaut que `MbaCompletion` évitait en ne s'affichant pas du tout.
      etapes={completion === null ? null : completion.taches
        .filter((x) => x.etat === 'a_faire')
        .map((x) => ({ message: x.raison ?? t(LIBELLES[x.cle].fr, LIBELLES[x.cle].en), onglet: LIBELLES[x.cle].onglet }))}
      // 🔴 LES OBLIGATOIRES DONT L'ÉTAT EST HORS DE NOTRE PORTÉE, rendues à part et en gris. Depuis le
      // retrait du moyen de paiement (2026-09-24), il n'y en a PLUS EN PERMANENCE : cette liste ne se montre
      // que quand une lecture chez Meta a vraiment échoué, ce qui est exactement ce qu'on veut qu'elle dise.
      // 🔴 `requise` DANS LE FILTRE, ET CE N'EST PAS DÉCORATIF. `connecteurs` et `outils` sont aussi
      // `inconnue`, mais FACULTATIFS : les afficher poserait sous les yeux du client deux lignes grises
      // permanentes qui ne disent rien de l'état de son agent. Le serveur les compte d'ailleurs à part
      // (`indeterminees` ne retient que les obligatoires).
      signalements={completion === null ? undefined : completion.taches
        .filter((x) => x.etat === 'inconnue' && x.requise)
        .map((x) => x.raison ?? t(LIBELLES[x.cle].fr, LIBELLES[x.cle].en))}
      ratio={completion ? { faites: completion.faites, total: completion.total } : undefined}
      messages30j={messages}
      onOnglet={choisirOnglet}
    />
  );
  /**
   * ⚠️ `max-w-6xl` et non `4xl` (demandé par Julien le 2026-09-10) : la liste `ONGLETS` ci-dessus et des
   * panneaux qui listent des FAQ, des fichiers et des compétences n'ont rien à faire dans une colonne de
   * 896 px sur un écran de 1600. C'est l'écran le plus dense de la console, il est désormais le plus large.
   */
  const coquille = (contenu: React.ReactNode) => <div className="mx-auto max-w-6xl space-y-6">{entete}{contenu}</div>;

  if (chargement) return coquille(<p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>);
  if (err !== '') return coquille(<MbaNotice kind="error" testid="mba-page-error">{err}</MbaNotice>);
  if (phoneNumberId === null) return coquille(<MbaGateBanner reason="no-number" />);
  if (status === null || !status.eligible) return coquille(<MbaGateBanner reason="not-eligible" />);

  const props = { tenantId, phoneNumberId };

  return coquille(
    <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
      {/* ⚠️ `min-w-0` ICI AUSSI, et pas seulement sur le contenu. Un élément de grille a `min-width: auto`,
          donc il ne peut pas devenir plus étroit que son contenu : sous `lg`, le menu redevient une barre
          horizontale à défilement (onze entrées, environ 1 030 px), et la grille prenait cette largeur. La
          PAGE ENTIÈRE défilait alors horizontalement sur un téléphone, au lieu de la seule barre d'onglets.
          Mesuré avant correction : `scrollWidth` 1029 pour un `clientWidth` de 390. */}
      <div className="min-w-0 lg:border-r lg:border-ink-200 lg:pr-3">
        <MbaTabs
          orientation="verticale"
          active={onglet}
          onSelect={choisirOnglet}
          tabs={[
            { key: 'apercu', label: t('Vue d’ensemble', 'Overview') },
            { key: 'assistant', label: t('Assistant', 'Assistant') },
            { key: 'activation', label: t('Activation', 'Activation') },
            { key: 'business', label: t('Informations', 'Business info') },
            { key: 'faq', label: t('FAQ', 'FAQ') },
            { key: 'competences', label: t('Compétences', 'Skills') },
            { key: 'outils', label: t('Outils', 'Tools') },
            { key: 'fichiers', label: t('Fichiers', 'Files') },
            { key: 'sites', label: t('Sites web', 'Websites') },
            { key: 'historique', label: t('Historique', 'History') },
            { key: 'test', label: t('Tester', 'Test') },
          ]}
        />
      </div>

      {/* ⚠️ `min-w-0` : une piste de grille `1fr` prend la largeur MINIMALE de son contenu comme plancher, et
          un panneau large (le tableau de FAQ, la liste des fichiers) pousserait alors la grille et ferait
          déborder la page entière. Même geste que la mise en page de l'Inbox. */}
      <div className="min-w-0 space-y-6">
        {onglet === 'apercu' && <MbaOverviewPanel {...props} status={status} onChange={majReglages} />}
        {/* L'assistant affiche le MEME compte d etapes que l en-tete : les deux lisent la meme
            completion, donc ils ne peuvent pas se contredire. `null` tant qu elle n a pas ete lue. */}
        {onglet === 'assistant' && (
          <MbaAssistantPanel
            tenantId={tenantId}
            etapesRestantes={completion === null ? null : completion.taches.filter((x) => x.etat === 'a_faire').length}
          />
        )}
        {onglet === 'activation' && <MbaActivationPanel tenantId={tenantId} />}
        {onglet === 'business' && <MbaBusinessInfoPanel {...props} />}
        {onglet === 'faq' && <MbaFaqPanel {...props} />}
        {onglet === 'competences' && <MbaSkillsPanel {...props} />}
        {/* 🔴 LES OUTILS DE L'AGENT DE META, ET EUX SEULS (spec 2026-09-21-outils-maison-mba, § 9). L'ancien
            écran mélangeait la bibliothèque de l'espace et ce que Meta peut appeler, et Julien l'a trouvé
            illisible : on y décide désormais seulement ce que fait l'agent de Meta, et enregistrer envoie chez
            Meta. Les connecteurs d'un agent IA se gèrent depuis sa fiche. */}
        {onglet === 'outils' && <OutilsMba tenantId={tenantId} isAdmin={isAdmin} />}
        {onglet === 'fichiers' && <MbaFilesPanel {...props} />}
        {onglet === 'sites' && <MbaWebsitesPanel {...props} />}
        {onglet === 'historique' && <HistoriquePanel tenantId={tenantId} surface="mba" />}
        {onglet === 'test' && <MbaTestPanel {...props} />}
      </div>
    </div>,
  );
}
