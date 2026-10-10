/**
 * Id delle caselle selezionate nelle liste con azioni di massa (solo browser): `selector` individua le
 * caselle, il valore è l'id. Senza duplicati (una lista può avere più viste con le stesse caselle) e
 * senza valori non numerici o nulli.
 */
export function checkedIds(selector: string): number[] {
  const values = [...document.querySelectorAll<HTMLInputElement>(`${selector}:checked`)].map((i) => Number(i.value));
  return [...new Set(values)].filter(Boolean);
}
