"use client";

import { useEffect, useState } from "react";

import type { BoardCard } from "@/server/domain/board/types";

/**
 * Trascinamento delle card con la Pointer Events API (mouse, penna e touch con la stessa logica):
 * - mouse/penna: il drag parte dopo uno spostamento di qualche pixel (il clic semplice resta un clic);
 * - touch: pressione prolungata (così lo scorrimento orizzontale delle colonne resta libero), poi trascinamento;
 * - la cella sotto il puntatore si trova con elementFromPoint (attributo data-board-cell);
 * - scorrimento automatico del contenitore orizzontale e della pagina vicino ai bordi; Esc annulla.
 * La logica imperativa sta in DragController (fuori dal ciclo di render); React riceve solo lo stato da mostrare.
 */

interface DragInfo {
  card: BoardCard;
  /** posizione della card all'inizio (coordinate del viewport) e spostamento iniziale del puntatore */
  left: number;
  top: number;
  dx: number;
  dy: number;
  width: number;
  /** cella sotto il puntatore (`lane::col`) */
  over: string | null;
}

interface Pending {
  card: BoardCard;
  pointerId: number;
  touch: boolean;
  startX: number;
  startY: number;
  rect: DOMRect;
  timer: number | null;
  active: boolean;
}

const MOUSE_THRESHOLD = 5;
const TOUCH_SLOP = 8;
const LONG_PRESS_MS = 320;
const EDGE = 56;

function cellAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  const cell =
    el instanceof Element ? el.closest<HTMLElement>("[data-board-cell]") : null;
  return cell?.dataset.boardCell ?? null;
}

class DragController {
  enabled = false;
  scroller: HTMLElement | null = null;
  ghost: HTMLElement | null = null;
  onDrop: (card: BoardCard, cell: string) => void = () => {};
  private pending: Pending | null = null;
  private point = { x: 0, y: 0 };
  private over: string | null = null;
  private raf: number | null = null;
  private suppress = false;

  constructor(
    private readonly setDrag: (
      fn: (d: DragInfo | null) => DragInfo | null,
    ) => void,
  ) {}

  /** il clic che segue un trascinamento va ignorato */
  shouldSuppressClick = (): boolean => this.suppress;

  setGhost = (el: HTMLElement | null) => {
    this.ghost = el;
  };

  start = (e: React.PointerEvent<HTMLElement>, card: BoardCard) => {
    if (!this.enabled || this.pending) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // i controlli interni (menu della card) non avviano il drag
    if ((e.target as Element).closest("[data-no-drag]")) return;
    const p: Pending = {
      card,
      pointerId: e.pointerId,
      touch: e.pointerType === "touch",
      startX: e.clientX,
      startY: e.clientY,
      rect: e.currentTarget.getBoundingClientRect(),
      timer: null,
      active: false,
    };
    if (p.touch)
      p.timer = window.setTimeout(
        () => this.pending === p && this.activate(p, p.startX, p.startY),
        LONG_PRESS_MS,
      );
    this.pending = p;
  };

  private activate(p: Pending, x: number, y: number) {
    p.active = true;
    this.suppress = true;
    document.body.classList.add("select-none");
    if (p.touch && "vibrate" in navigator) {
      try {
        navigator.vibrate(15);
      } catch {
        /* non supportato */
      }
    }
    this.point = { x, y };
    this.over = cellAt(x, y);
    const info: DragInfo = {
      card: p.card,
      left: p.rect.left,
      top: p.rect.top,
      dx: x - p.startX,
      dy: y - p.startY,
      width: p.rect.width,
      over: this.over,
    };
    this.setDrag(() => info);
    this.raf = requestAnimationFrame(this.tick);
  }

  private track(x: number, y: number) {
    this.point = { x, y };
    const p = this.pending;
    if (this.ghost && p)
      this.ghost.style.transform = `translate3d(${x - p.startX}px, ${y - p.startY}px, 0) rotate(2deg)`;
    const over = cellAt(x, y);
    if (over !== this.over) {
      this.over = over;
      this.setDrag((d) => (d ? { ...d, over } : d));
    }
  }

  /** scorrimento automatico vicino ai bordi */
  private tick = () => {
    if (!this.pending?.active) return;
    const { x, y } = this.point;
    const sc = this.scroller;
    if (sc) {
      const r = sc.getBoundingClientRect();
      if (x < r.left + EDGE)
        sc.scrollLeft -= Math.ceil((r.left + EDGE - x) / 4);
      else if (x > r.right - EDGE)
        sc.scrollLeft += Math.ceil((x - (r.right - EDGE)) / 4);
    }
    if (y < EDGE) window.scrollBy(0, -Math.ceil((EDGE - y) / 4));
    else if (y > window.innerHeight - EDGE)
      window.scrollBy(0, Math.ceil((y - (window.innerHeight - EDGE)) / 4));
    this.track(x, y);
    this.raf = requestAnimationFrame(this.tick);
  };

  private finish(drop: boolean, x = 0, y = 0) {
    const p = this.pending;
    if (!p) return;
    if (p.timer) window.clearTimeout(p.timer);
    this.pending = null;
    this.over = null;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    document.body.classList.remove("select-none");
    this.setDrag(() => null);
    if (p.active) {
      const target = drop ? cellAt(x, y) : null;
      if (target) this.onDrop(p.card, target);
      // il clic sintetico arriva subito dopo pointerup
      window.setTimeout(() => (this.suppress = false), 0);
    }
  }

  onMove = (e: PointerEvent) => {
    const p = this.pending;
    if (!p || e.pointerId !== p.pointerId) return;
    if (!p.active) {
      const dist = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
      if (p.touch) {
        // lo scorrimento prima della pressione prolungata annulla il drag
        if (dist > TOUCH_SLOP) this.finish(false);
        return;
      }
      if (dist >= MOUSE_THRESHOLD) this.activate(p, e.clientX, e.clientY);
      return;
    }
    this.track(e.clientX, e.clientY);
  };

  onUp = (e: PointerEvent) => {
    if (this.pending && e.pointerId === this.pending.pointerId)
      this.finish(true, e.clientX, e.clientY);
  };

  onCancel = (e: PointerEvent) => {
    if (this.pending && e.pointerId === this.pending.pointerId)
      this.finish(false);
  };

  onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.pending?.active) {
      e.preventDefault();
      this.finish(false);
    }
  };

  /** durante il drag touch la pagina non deve scorrere (listener non passivo) */
  onTouchMove = (e: TouchEvent) => {
    if (this.pending?.active) e.preventDefault();
  };

  attach(): () => void {
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointercancel", this.onCancel);
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("touchmove", this.onTouchMove, { passive: false });
    return () => {
      this.finish(false);
      window.removeEventListener("pointermove", this.onMove);
      window.removeEventListener("pointerup", this.onUp);
      window.removeEventListener("pointercancel", this.onCancel);
      window.removeEventListener("keydown", this.onKey);
      window.removeEventListener("touchmove", this.onTouchMove);
    };
  }

  configure(
    enabled: boolean,
    scroller: HTMLElement | null,
    onDrop: (card: BoardCard, cell: string) => void,
  ) {
    this.enabled = enabled;
    this.scroller = scroller;
    this.onDrop = onDrop;
  }
}

export function useBoardDrag(opts: {
  enabled: boolean;
  scroller: React.RefObject<HTMLElement | null>;
  onDrop: (card: BoardCard, cell: string) => void;
}) {
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [controller] = useState(() => new DragController(setDrag));
  const { enabled, scroller, onDrop } = opts;

  useEffect(() => {
    controller.configure(enabled, scroller.current, onDrop);
  });

  useEffect(() => controller.attach(), [controller]);

  return {
    drag,
    start: controller.start,
    shouldSuppressClick: controller.shouldSuppressClick,
    ghostRef: controller.setGhost,
  };
}
