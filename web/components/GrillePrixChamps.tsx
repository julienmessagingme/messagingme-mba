'use client';

import { useT } from '@/lib/i18n';

/**
 * LES SIX CHAMPS D'UNE GRILLE DE PRIX, une seule fois pour tout le produit.
 *
 * 🔴 IL EXISTE PARCE QUE LA GRILLE A CHANGÉ DE MAISON (lot 8 du 2026-09-23, migration 0168). Ce formulaire
 * vivait dans l'écran Paramètres du CLIENT, qui fixait donc lui-même ce qu'on lui facture. Il part dans
 * `/ops`, où la grille est désormais unique pour tous les espaces. Le recopier là-bas aurait produit deux
 * formulaires pour une même grille, et le jour où un septième prix apparaît, l'un des deux l'aurait eu et
 * pas l'autre. C'est le motif que le dépôt paie déjà : l'audit du 2026-08-18 a retiré une centaine de
 * copies de fonctions que le repo possédait.
 *
 * ⚠️ PUREMENT PRÉSENTATIONNEL : il ne sait ni lire, ni écrire, ni valider. Son appelant garde l'état, la
 * note d'exploitation et le bouton, parce que ces trois-là ne sont pas les mêmes selon la surface.
 *
 * 🔴 LA SAISIE RESTE UNE CHAÎNE, ET C'EST UN CORRECTIF, PAS UNE PARESSE. La première version convertissait
 * à chaque frappe sur un champ contrôlé : taper « 3 » puis « . » donnait `Number('3.') === 3`, le point
 * disparaissait, et on ne pouvait JAMAIS créer un séparateur décimal ; vider le champ donnait
 * `Number('') === 0`, donc il se remplissait tout seul de « 0 ». Sur un écran dont un défaut vaut 2,48,
 * passer de 2,48 à 3,10 rendait 310, refusé par les bornes. La conversion se fait à l'ENREGISTREMENT, une
 * seule fois, chez l'appelant (`depuisChamps`).
 */
export function GrillePrixChamps({ valeurs, onChange, champFautif }: {
  /** Les six champs, en CHAÎNES (cf. le docblock) : la conversion appartient à l'appelant. */
  valeurs: Record<string, string>;
  onChange: (champ: string, valeur: string) => void;
  /** Le champ que le serveur a nommé dans son refus, souligné en rouge. `null` = aucun. */
  champFautif: string | null;
}) {
  const t = useT();
  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Champ
        id="marge" label={t('Marge sur le tarif Meta', 'Margin on the Meta rate')}
        aide={t('100 = vous facturez le tarif Meta. 120 = vous le majorez de 20 %.', '100 = you charge the Meta rate. 120 = you add 20%.')}
        valeur={valeurs.margeTemplate ?? ''} onChange={(v) => onChange('margeTemplate', v)}
        suffixe="%" fautif={champFautif === 'margeTemplate'}
      />
      <Champ
        id="service" label={t('Message de service', 'Service message')}
        aide={t('Prix d’un message hors template, en centimes.', 'Price of one non-template message, in cents.')}
        valeur={valeurs.serviceCentimes ?? ''} onChange={(v) => onChange('serviceCentimes', v)}
        suffixe={t('cts', 'cts')} fautif={champFautif === 'serviceCentimes'}
      />
      <Champ
        id="franchise" label={t('Messages de service offerts', 'Free service messages')}
        aide={t('Par mois et par espace. Au-delà, chaque message est facturé.', 'Per month and per workspace. Beyond that, every message is charged.')}
        valeur={valeurs.serviceFranchise ?? ''} onChange={(v) => onChange('serviceFranchise', v)}
        suffixe={t('/ mois', '/ month')} fautif={champFautif === 'serviceFranchise'}
      />
      <Champ
        id="depuis" label={t('Facturé à partir du', 'Charged from')}
        aide={t('Avant cette date, les messages de service ne comptent pas.', 'Before this date, service messages are not counted.')}
        valeur={valeurs.serviceDepuis ?? ''} onChange={(v) => onChange('serviceDepuis', v)}
        type="date" fautif={champFautif === 'serviceDepuis'}
      />
      <Champ
        id="rcs" label={t('RCS simple', 'Plain RCS')}
        aide={t('Un envoi RCS sans échange, en centimes.', 'One RCS send with no exchange, in cents.')}
        valeur={valeurs.rcsSimpleCentimes ?? ''} onChange={(v) => onChange('rcsSimpleCentimes', v)}
        suffixe={t('cts', 'cts')} fautif={champFautif === 'rcsSimpleCentimes'}
      />
      <Champ
        id="rcsconv" label={t('RCS conversationnel', 'Conversational RCS')}
        aide={t('Dès qu’une personne répond, tout l’échange passe à ce prix.', 'As soon as someone replies, the whole exchange moves to this price.')}
        valeur={valeurs.rcsConversationnelCentimes ?? ''} onChange={(v) => onChange('rcsConversationnelCentimes', v)}
        suffixe={t('cts', 'cts')} fautif={champFautif === 'rcsConversationnelCentimes'}
      />
    </div>
  );
}

function Champ({ id, label, aide, valeur, onChange, suffixe, type = 'text', fautif }: {
  id: string; label: string; aide: string; valeur: string;
  onChange: (v: string) => void; suffixe?: string; type?: string; fautif?: boolean;
}) {
  return (
    <div>
      <label htmlFor={`prix-${id}`} className="block text-xs font-medium text-ink-900">{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={`prix-${id}`} type={type} value={valeur} onChange={(e) => onChange(e.target.value)}
          data-testid={`prix-${id}`}
          className={`w-36 rounded-controle border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-100 ${fautif ? 'border-danger-400 focus:border-danger-500' : 'border-ink-300 focus:border-brand-500'}`}
        />
        {suffixe && <span className="text-xs text-ink-500">{suffixe}</span>}
      </div>
      <p className="mt-1 text-xs text-ink-500">{aide}</p>
    </div>
  );
}
