/**
 * Classes Tailwind partagées de la console.
 *
 * `inputCls` était redéclaré dans une vingtaine d'écrans, et les copies commençaient à diverger (un `py-1.5`
 * ici, pas là) : les champs de deux pages voisines ne se ressemblaient plus. Une variante locale s'exprime en
 * composant (`${inputCls} w-32`), pas en recopiant la chaîne.
 */
export const inputCls =
  'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

/**
 * Même champ, sans `w-full` : pour les champs posés dans une rangée qui décide elle-même de leur largeur
 * (filtres, barre de dates, éditeur de carousel). Une classe Tailwind ne se retire pas par composition, d'où
 * une seconde constante plutôt qu'un `${inputCls}` amputé.
 */
export const inputClsAuto =
  'rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

/**
 * Carte de contenu : le fond blanc arrondi qui porte une section de réglages. Recopié à l'identique dans une
 * dizaine d'écrans avant d'atterrir ici, pour la même raison que `inputCls`.
 */
export const cardCls = 'rounded-2xl border border-ink-200 bg-white p-5 shadow-sm';

/** Le sur-titre coloré d'un en-tête de page (« MBA », « CAMPAGNES »). */
export const kickerCls = 'text-xs font-semibold uppercase tracking-wide text-brand-600';
