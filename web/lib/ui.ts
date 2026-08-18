/**
 * Classes Tailwind partagées de la console.
 *
 * `inputCls` était redéclaré dans une vingtaine d'écrans, et les copies commençaient à diverger (un `py-1.5`
 * ici, pas là) : les champs de deux pages voisines ne se ressemblaient plus. Une variante locale s'exprime en
 * composant (`${inputCls} w-32`), pas en recopiant la chaîne.
 */
export const inputCls =
  'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';
