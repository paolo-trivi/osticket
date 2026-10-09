import { describe, expect, it } from "vitest";

import { faqVisibleForTopics, visibleTopicIds, type HelpTopicInfo } from "@/server/domain/kb/topic-filter";

const topic = (id: number, over: Partial<HelpTopicInfo> = {}): [number, HelpTopicInfo] => [
  id,
  { id, pid: 0, isPublic: true, disabled: false, name: `T${id}`, deptId: 0, ...over },
];

// Staff::getTopicNames(false) per un agente senza visibility.departments
const topics = new Map<number, HelpTopicInfo>([
  topic(1), // pubblico
  topic(2, { isPublic: false, deptId: 3 }), // privato, reparto 3
  topic(3, { isPublic: false, deptId: 0 }), // privato senza reparto
  topic(4, { isPublic: false, deptId: 2 }), // privato, reparto 2
  topic(5, { pid: 2, isPublic: true }), // figlio pubblico di un padre privato del reparto 3
  topic(6, { pid: 1, isPublic: false, deptId: 3 }), // figlio privato del reparto 3, padre pubblico
  topic(7, { pid: 1, isPublic: false, deptId: 2 }), // figlio privato del reparto 2
  topic(8, { disabled: true }), // disattivato
]);

describe("visibleTopicIds (Staff::getTopicNames)", () => {
  it("filtra per reparto i topic privati e i figli dei padri non accessibili", () => {
    expect([...visibleTopicIds(topics, [2])].sort()).toEqual([1, 3, 4, 7]);
    expect([...visibleTopicIds(topics, [3])].sort()).toEqual([1, 2, 3, 5, 6]);
  });

  it("senza reparti mostra tutti i topic attivi, mai quelli disattivati", () => {
    expect([...visibleTopicIds(topics, [])].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("faqVisibleForTopics (faq-category.inc.php)", () => {
  const allowed = new Set([1, 3]);
  it("mostra la FAQ se l'agente non è filtrato o la FAQ non ha topic", () => {
    expect(faqVisibleForTopics([2], null)).toBe(true);
    expect(faqVisibleForTopics([], allowed)).toBe(true);
  });
  it("mostra la FAQ solo se almeno un topic è visibile", () => {
    expect(faqVisibleForTopics([2, 3], allowed)).toBe(true);
    expect(faqVisibleForTopics([2, 4], allowed)).toBe(false);
  });
});
