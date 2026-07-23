import { useCallback, useLayoutEffect, useRef } from "react";

export function useStableCallback<Arguments extends unknown[], Result>(
  callback: (...args: Arguments) => Result
): (...args: Arguments) => Result {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback((...args: Arguments) => callbackRef.current(...args), []);
}

export function reuseVersionedItems<Item extends { id: string }>(
  previous: readonly Item[] | undefined,
  incoming: readonly Item[],
  version: (item: Item) => string
): Item[] {
  if (!previous) return [...incoming];
  const previousById = new Map(previous.map((item) => [item.id, item]));
  let arrayChanged = previous.length !== incoming.length;
  const reconciled = incoming.map((item, index) => {
    const prior = previousById.get(item.id);
    const next = prior && version(prior) === version(item) ? prior : item;
    if (previous[index] !== next) arrayChanged = true;
    return next;
  });
  return arrayChanged ? reconciled : previous as Item[];
}
