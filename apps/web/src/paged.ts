/** Every page of a paged list, in order (operator 31/10 «Βγάλε όλα τα όρια»: a dock showed only the first 100). */
export async function fetchEveryPage<T>(read: (page: number) => Promise<{ data: T[]; pagination: { totalItems: number; totalPages: number } }>): Promise<{ data: T[]; totalItems: number }> {
  const first = await read(1);
  const rest = first.pagination.totalPages > 1
    ? await Promise.all(Array.from({ length: first.pagination.totalPages - 1 }, (_, index) => read(index + 2))) : [];
  const data = [...first.data, ...rest.flatMap((page) => page.data)];
  // Every page read: the rows are the count (a history row past the owner's History period is left out of its page).
  return { data, totalItems: data.length };
}
