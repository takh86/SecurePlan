/** Largest page the SecurePlan API accepts (Phase 8.8: pageSize 1..100). */
export const MAX_PAGE_SIZE = 100;

// Bounded on purpose: selection lists for one company (MVP: about 100 people)
// fit into a few pages. More than this is treated as an error, not as data.
const MAX_PAGES = 20;

type Paged<T> = { items: T[]; pagination: { totalPages: number } };

/** Loads every page of a paginated collection, one request at a time. */
export async function loadAllPages<T>(loadPage: (page: number) => Promise<Paged<T>>): Promise<T[]> {
  const first = await loadPage(1);
  const { totalPages } = first.pagination;
  if (totalPages > MAX_PAGES) throw new Error('Collection too large to load at once');
  const items = [...first.items];
  for (let page = 2; page <= totalPages; page += 1) {
    items.push(...(await loadPage(page)).items);
  }
  return items;
}
