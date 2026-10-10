import { notFound } from "next/navigation";

/**
 * Percorsi senza una pagina: senza questa route Next risponde con la sua 404 predefinita (in inglese,
 * fuori dal layout); notFound() qui fa usare [locale]/not-found.tsx, localizzata e con il tema.
 */
export default function CatchAllNotFound() {
  notFound();
}
