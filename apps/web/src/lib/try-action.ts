import { unstable_rethrow } from "next/navigation";

type TryResult<T> = { ok: true; value: T } | { ok: false };

/**
 * Chiamata a una server action da un componente client fuori da un form (es. in startTransition): un
 * errore di rete o del server lanciato dentro una transizione arriverebbe all'error boundary e la pagina
 * perderebbe il modulo compilato. Qui diventa { ok: false }, che il componente mostra con la possibilità
 * di riprovare. Redirect e notFound di Next (es. sessione scaduta) passano invariati.
 */
export async function tryAction<T>(call: () => Promise<T>): Promise<TryResult<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    unstable_rethrow(error);
    console.error(error);
    return { ok: false };
  }
}
