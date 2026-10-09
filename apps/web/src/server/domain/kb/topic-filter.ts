/**
 * Logica pura del filtro FAQ per help topic (senza accesso al DB, testabile da sola).
 * Port di Staff::getTopicNames(false) (include/class.staff.php) e del filtro di
 * include/staff/faq-category.inc.php.
 */

export interface HelpTopicInfo {
  id: number;
  pid: number;
  isPublic: boolean;
  /** disattivato lui o un antenato (Topic::getHelpTopics) */
  disabled: boolean;
  /** nome completo "Padre / Figlio" */
  name: string;
  deptId: number;
}

/**
 * Topic attivi visibili a un agente SENZA visibility.departments, dati i suoi reparti:
 * - figlio: visibile se pubblico, senza reparto o di un reparto dell'agente; nascosto comunque se il
 *   padre è privato e di un reparto non accessibile;
 * - primo livello: visibile se pubblico, oppure privato senza reparto o di un reparto dell'agente.
 * Un agente senza reparti vede tutti i topic attivi (il PHP non filtra con `$staffDepts` vuoto).
 */
export function visibleTopicIds(topics: ReadonlyMap<number, HelpTopicInfo>, deptIds: readonly number[]): Set<number> {
  const enabled = [...topics.values()].filter((t) => !t.disabled);
  if (!deptIds.length) return new Set(enabled.map((t) => t.id));
  const out = new Set<number>();
  for (const info of enabled) {
    if (info.pid) {
      if (info.isPublic || !info.deptId || deptIds.includes(info.deptId)) out.add(info.id);
      const parent = topics.get(info.pid);
      if (parent && !parent.isPublic && parent.deptId && !deptIds.includes(parent.deptId)) out.delete(info.id);
    } else if (info.isPublic || !info.deptId || deptIds.includes(info.deptId)) {
      out.add(info.id);
    }
  }
  return out;
}

/**
 * Una FAQ è visibile nelle pagine KB dell'agente se l'agente non è filtrato (`allowed` null), se la
 * FAQ non ha topic, o se almeno uno dei suoi topic è tra quelli visibili.
 * Nota: faq-category.inc.php non azzera `$show` tra una FAQ e l'altra (dopo la prima FAQ visibile
 * mostra anche le successive); qui il filtro è applicato FAQ per FAQ, come voluto dal codice.
 */
export function faqVisibleForTopics(faqTopicIds: readonly number[], allowed: ReadonlySet<number> | null): boolean {
  if (!allowed || !faqTopicIds.length) return true;
  return faqTopicIds.some((id) => allowed.has(id));
}
