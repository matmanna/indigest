// The feed map is cached for a minute. Anything that changes which channels
// are pub'd or who subscribes to them clears it so the map stays honest.
export const graphCache: { value: { data: unknown; at: number } | null } = {
  value: null,
};

export function invalidateGraphCache() {
  graphCache.value = null;
}
