const flights = new Map<string, Promise<unknown>>();

/** Share concurrent background reads without retaining settled responses. */
export function singleFlightRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
  const active = flights.get(key);
  if (active) return active as Promise<T>;
  const flight = Promise.resolve().then(load).finally(() => {
    if (flights.get(key) === flight) flights.delete(key);
  });
  flights.set(key, flight);
  return flight;
}
