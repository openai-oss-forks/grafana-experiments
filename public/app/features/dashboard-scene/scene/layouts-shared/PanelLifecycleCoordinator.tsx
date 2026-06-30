import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

export const PANEL_PREFETCH_MIN_MARGIN = 800;
export const PANEL_RETENTION_VIEWPORTS = 2;
export const PANEL_EVICTION_GRACE_MS = 1_000;
export const PANEL_RENDER_PREPARATION_BUDGET = 2;
export const PANEL_EVICTION_BUDGET = 2;

export interface PanelLifecycleSnapshot {
  rendererActive: boolean;
}

interface PanelLifecycleEntry {
  element: HTMLElement;
  listener: (snapshot: PanelLifecycleSnapshot) => void;
  rendererActive: boolean;
  rendererPrepared: boolean;
  visible: boolean;
  withinPrefetch: boolean;
  withinRetention: boolean;
  interactive: boolean;
  evictionEligible: boolean;
  evictionTimeout?: number;
}

export interface PanelLifecycleRegistration {
  setInteractive(interactive: boolean): void;
  unregister(): void;
}

function viewportDistance(element: Element): number {
  const rect = element.getBoundingClientRect();
  if (rect.bottom < 0) {
    return -rect.bottom;
  }
  if (rect.top > window.innerHeight) {
    return rect.top - window.innerHeight;
  }
  return 0;
}

function isWithinViewportMargin(element: Element, margin: number): boolean {
  const rect = element.getBoundingClientRect();
  return rect.bottom >= -margin && rect.top <= window.innerHeight + margin;
}

function lifecyclePriority(left: PanelLifecycleEntry, right: PanelLifecycleEntry): number {
  if (left.visible !== right.visible) {
    return left.visible ? -1 : 1;
  }
  if (left.interactive !== right.interactive) {
    return left.interactive ? -1 : 1;
  }
  return viewportDistance(left.element) - viewportDistance(right.element);
}

/** Paces renderer preparation and bounded eviction for one dashboard. */
export class PanelLifecycleCoordinator {
  private entries = new Map<Element, PanelLifecycleEntry>();
  private renderQueue = new Set<PanelLifecycleEntry>();
  private evictionQueue = new Set<PanelLifecycleEntry>();
  private renderFrame?: number;
  private evictionFrame?: number;
  private visibleObserver?: IntersectionObserver;
  private prefetchObserver?: IntersectionObserver;
  private retentionObserver?: IntersectionObserver;

  constructor() {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const prefetchMargin = Math.max(window.innerHeight, PANEL_PREFETCH_MIN_MARGIN);
    this.visibleObserver = new IntersectionObserver((entries) => this.updateVisibility(entries, 'visible'));
    this.prefetchObserver = new IntersectionObserver((entries) => this.updateVisibility(entries, 'prefetch'), {
      rootMargin: `${prefetchMargin}px 0px`,
    });
    this.retentionObserver = new IntersectionObserver((entries) => this.updateVisibility(entries, 'retention'), {
      rootMargin: `${prefetchMargin * PANEL_RETENTION_VIEWPORTS}px 0px`,
    });
  }

  register(element: HTMLElement, listener: (snapshot: PanelLifecycleSnapshot) => void): PanelLifecycleRegistration {
    const prefetchMargin = Math.max(window.innerHeight, PANEL_PREFETCH_MIN_MARGIN);
    const visible = isWithinViewportMargin(element, 0);
    const withinPrefetch = isWithinViewportMargin(element, prefetchMargin);
    const entry: PanelLifecycleEntry = {
      element,
      listener,
      rendererActive: false,
      rendererPrepared: false,
      visible,
      withinPrefetch,
      withinRetention: isWithinViewportMargin(element, prefetchMargin * PANEL_RETENTION_VIEWPORTS),
      interactive: false,
      evictionEligible: false,
    };

    this.entries.set(element, entry);
    this.visibleObserver?.observe(element);
    this.prefetchObserver?.observe(element);
    this.retentionObserver?.observe(element);
    this.publish(entry);

    if (withinPrefetch) {
      this.queueRenderPreparation(entry);
    }

    return {
      setInteractive: (interactive) => {
        if (entry.interactive === interactive) {
          return;
        }
        entry.interactive = interactive;
        if (interactive) {
          this.queueRenderPreparation(entry);
        }
        this.updateRendererRetention(entry);
      },
      unregister: () => this.unregister(entry),
    };
  }

  destroy(): void {
    for (const entry of [...this.entries.values()]) {
      this.unregister(entry);
    }
    this.visibleObserver?.disconnect();
    this.prefetchObserver?.disconnect();
    this.retentionObserver?.disconnect();
    this.cancelFrame('render');
    this.cancelFrame('eviction');
  }

  private updateVisibility(entries: IntersectionObserverEntry[], boundary: 'visible' | 'prefetch' | 'retention') {
    for (const observerEntry of entries) {
      const entry = this.entries.get(observerEntry.target);
      if (!entry) {
        continue;
      }
      switch (boundary) {
        case 'visible':
          entry.visible = observerEntry.isIntersecting;
          if (entry.visible) {
            this.queueRenderPreparation(entry);
          }
          break;
        case 'prefetch':
          entry.withinPrefetch = observerEntry.isIntersecting;
          if (entry.withinPrefetch) {
            this.queueRenderPreparation(entry);
          }
          break;
        case 'retention':
          entry.withinRetention = observerEntry.isIntersecting;
          break;
      }
      this.updateRendererRetention(entry);
    }
  }

  private queueRenderPreparation(entry: PanelLifecycleEntry) {
    if (entry.rendererPrepared) {
      return;
    }
    this.renderQueue.add(entry);
    if (this.renderFrame === undefined) {
      this.renderFrame = window.requestAnimationFrame(() => this.drainRenderQueue());
    }
  }

  private drainRenderQueue() {
    this.renderFrame = undefined;
    const queued = [...this.renderQueue].sort(lifecyclePriority);
    let prepared = 0;
    for (const entry of queued) {
      if (prepared >= PANEL_RENDER_PREPARATION_BUDGET) {
        break;
      }
      this.renderQueue.delete(entry);
      if (!this.entries.has(entry.element) || (!entry.visible && !entry.interactive && !entry.withinPrefetch)) {
        continue;
      }
      entry.rendererPrepared = true;
      prepared++;
      this.updateRendererRetention(entry);
    }
    if (this.renderQueue.size > 0) {
      this.renderFrame = window.requestAnimationFrame(() => this.drainRenderQueue());
    }
  }

  private updateRendererRetention(entry: PanelLifecycleEntry) {
    if (entry.visible || entry.interactive || entry.withinPrefetch) {
      this.clearEviction(entry);
      if (entry.rendererPrepared) {
        this.setRendererActive(entry, true);
      }
      return;
    }
    if (entry.withinRetention) {
      this.clearEviction(entry);
      return;
    }
    if (!entry.rendererActive || entry.evictionTimeout !== undefined || entry.evictionEligible) {
      return;
    }
    entry.evictionTimeout = window.setTimeout(() => {
      entry.evictionTimeout = undefined;
      if (!entry.visible && !entry.interactive && !entry.withinRetention) {
        entry.evictionEligible = true;
        this.queueEviction(entry);
      }
    }, PANEL_EVICTION_GRACE_MS);
  }

  private queueEviction(entry: PanelLifecycleEntry) {
    this.evictionQueue.add(entry);
    if (this.evictionFrame === undefined) {
      this.evictionFrame = window.requestAnimationFrame(() => this.drainEvictionQueue());
    }
  }

  private drainEvictionQueue() {
    this.evictionFrame = undefined;
    const queued = [...this.evictionQueue].sort(
      (left, right) => viewportDistance(right.element) - viewportDistance(left.element)
    );
    let evicted = 0;
    for (const entry of queued) {
      if (evicted >= PANEL_EVICTION_BUDGET) {
        break;
      }
      this.evictionQueue.delete(entry);
      if (
        !this.entries.has(entry.element) ||
        !entry.evictionEligible ||
        entry.visible ||
        entry.interactive ||
        entry.withinRetention
      ) {
        continue;
      }
      entry.evictionEligible = false;
      entry.rendererPrepared = false;
      evicted++;
      this.setRendererActive(entry, false);
    }
    if (this.evictionQueue.size > 0) {
      this.evictionFrame = window.requestAnimationFrame(() => this.drainEvictionQueue());
    }
  }

  private setRendererActive(entry: PanelLifecycleEntry, rendererActive: boolean) {
    if (entry.rendererActive === rendererActive) {
      return;
    }
    entry.rendererActive = rendererActive;
    this.publish(entry);
  }

  private publish(entry: PanelLifecycleEntry) {
    entry.listener({
      rendererActive: entry.rendererActive,
    });
  }

  private clearEviction(entry: PanelLifecycleEntry) {
    if (entry.evictionTimeout !== undefined) {
      window.clearTimeout(entry.evictionTimeout);
      entry.evictionTimeout = undefined;
    }
    entry.evictionEligible = false;
    this.evictionQueue.delete(entry);
  }

  private cancelFrame(kind: 'render' | 'eviction') {
    const frame = kind === 'render' ? this.renderFrame : this.evictionFrame;
    if (frame !== undefined) {
      window.cancelAnimationFrame(frame);
    }
    if (kind === 'render') {
      this.renderFrame = undefined;
    } else {
      this.evictionFrame = undefined;
    }
  }

  private unregister(entry: PanelLifecycleEntry) {
    if (!this.entries.delete(entry.element)) {
      return;
    }
    this.visibleObserver?.unobserve(entry.element);
    this.prefetchObserver?.unobserve(entry.element);
    this.retentionObserver?.unobserve(entry.element);
    this.renderQueue.delete(entry);
    this.evictionQueue.delete(entry);
    this.clearEviction(entry);
  }
}

const PanelLifecycleContext = createContext<PanelLifecycleCoordinator | null>(null);
const UNCOORDINATED_SNAPSHOT: PanelLifecycleSnapshot = {
  rendererActive: true,
};
const PENDING_REGISTRATION_SNAPSHOT: PanelLifecycleSnapshot = {
  rendererActive: false,
};

export function PanelLifecycleProvider({ children }: { children: ReactNode }) {
  const coordinator = useMemo(() => new PanelLifecycleCoordinator(), []);
  useEffect(() => () => coordinator.destroy(), [coordinator]);
  return <PanelLifecycleContext.Provider value={coordinator}>{children}</PanelLifecycleContext.Provider>;
}

export function usePanelLifecycleRegistration() {
  const coordinator = useContext(PanelLifecycleContext);
  const elementRef = useRef<HTMLElement | null>(null);
  const registrationRef = useRef<PanelLifecycleRegistration>();
  const [snapshot, setSnapshot] = useState<PanelLifecycleSnapshot>(() =>
    coordinator ? PENDING_REGISTRATION_SNAPSHOT : UNCOORDINATED_SNAPSHOT
  );

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!coordinator || !element) {
      return;
    }
    const registration = coordinator.register(element, setSnapshot);
    registrationRef.current = registration;
    return () => {
      registration.unregister();
      registrationRef.current = undefined;
    };
  }, [coordinator]);

  const setElement = useCallback((element: HTMLElement | null) => {
    elementRef.current = element;
  }, []);
  const setInteractive = useCallback(
    (interactive: boolean) => registrationRef.current?.setInteractive(interactive),
    []
  );

  return useMemo(
    () => ({
      snapshot: !coordinator ? UNCOORDINATED_SNAPSHOT : snapshot,
      setElement,
      setInteractive,
      coordinated: coordinator !== null,
    }),
    [coordinator, setElement, setInteractive, snapshot]
  );
}
