export type TagCatalogPage<Tag> = { items: Tag[]; total: number };

/** Complete selector catalog, tolerating rows shifted by concurrent mutations. */
export async function loadTagCatalog<Tag extends { id: number }>(
  load: (input: { limit: number; offset: number }) => Promise<TagCatalogPage<Tag>>,
): Promise<Tag[]> {
  const tags = new Map<number, Tag>();
  let offset = 0;
  while (true) {
    const page = await load({ limit: 100, offset });
    for (const tag of page.items) tags.set(tag.id, tag);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) return [...tags.values()];
  }
}
