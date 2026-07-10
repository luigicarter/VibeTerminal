import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import clsx from "clsx";
import type { LayoutBox } from "../types";

import {
  BOARD_PADDING,
  DEFAULT_MIN_H,
  DEFAULT_MIN_W,
  RESIZE_AXES,
  buildAdjacentResizeLayouts,
  buildMoveDropRect,
  buildMoveLayout,
  buildResizeLayout,
  buildSwapCommitLayouts,
  buildSwapPreviewLayouts,
  changedLayoutEntries,
  committedLayoutsOverlap,
  compactCommittedLayouts,
  findSwapTargetId,
  isLayoutWithinBounds,
  layoutToRect,
  layoutsEqual,
  resolveDropLayout,
  sanitizeLayout,
  settleLayouts,
  type PixelRect,
  type ResizeAxis
} from "./tiledBoardGeometry";

interface TiledBoardItem {
  id: string;
  layout: LayoutBox;
  minW?: number;
  minH?: number;
  content: ReactNode;
}

interface TiledBoardProps {
  items: TiledBoardItem[];
  disabled?: boolean;
  onArrangeChange?: (isArranging: boolean) => void;
  onLayoutCommit: (layouts: Record<string, LayoutBox>) => void;
}

interface BoardMetrics {
  width: number;
  height: number;
}

interface InteractionState {
  type: "move" | "resize";
  itemId: string;
  pointerId: number;
  axis?: ResizeAxis;
  startClientX: number;
  startClientY: number;
  startLayout: LayoutBox;
  startRect: PixelRect;
  itemIdsAtStart: string[];
  layoutsAtStart: Record<string, LayoutBox>;
  lastValidLayout: LayoutBox;
  lastValidLayouts: Record<string, LayoutBox>;
  swapTargetId?: string | null;
  capturedElement: HTMLElement;
}

const ARRANGE_SETTLE_MS = 180;

function shouldIgnoreDragTarget(target: HTMLElement) {
  return Boolean(
    target.closest(
      ".pane-actions, .pane-actions *, .terminal-surface, .terminal-command-strip, button, input, textarea, select, a"
    )
  );
}

export default function TiledBoard({
  items,
  disabled = false,
  onArrangeChange,
  onLayoutCommit
}: TiledBoardProps) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<InteractionState | null>(null);
  const onArrangeChangeRef = useRef(onArrangeChange);
  const onLayoutCommitRef = useRef(onLayoutCommit);
  const pendingLayoutFrameRef = useRef<number | null>(null);
  const pendingPointerPositionRef = useRef<{
    clientX: number;
    clientY: number;
  } | null>(null);
  const settleTimeoutRef = useRef<number | null>(null);
  const [metrics, setMetrics] = useState<BoardMetrics>({
    width: 0,
    height: 0
  });
  const [liveLayouts, setLiveLayouts] = useState<Record<string, LayoutBox>>({});
  const [activeInteraction, setActiveInteraction] = useState<{
    itemId: string;
    type: "move" | "resize";
    axis?: ResizeAxis;
  } | null>(null);
  // True for the frames between releasing a drag/resize and the layout settling.
  // Keeps `.pane-frame` transitions suppressed across the synchronous commit ->
  // persist -> propLayouts round-trip so nothing eases from the drop spot.
  const [released, setReleased] = useState(false);

  // Keep geometry work stable when App only rebuilds pane JSX and handlers.
  const itemGeometrySignature = useMemo(
    () =>
      JSON.stringify(
        items.map((item) => [
          item.id,
          item.layout.x,
          item.layout.y,
          item.layout.w,
          item.layout.h,
          item.layout.unit ?? null,
          item.minW ?? null,
          item.minH ?? null
        ])
      ),
    [items]
  );
  const geometryItems = useMemo(
    () =>
      items.map((item) => ({
        id: item.id,
        layout: item.layout,
        minW: item.minW,
        minH: item.minH
      })),
    [itemGeometrySignature]
  );

  const innerWidth = useMemo(
    () => Math.max(1, metrics.width - BOARD_PADDING * 2),
    [metrics.width]
  );

  const itemOptions = useMemo(
    () =>
      new Map(
        geometryItems.map((item) => [
          item.id,
          {
            minW: item.minW ?? DEFAULT_MIN_W,
            minH: item.minH ?? DEFAULT_MIN_H
          }
        ])
      ),
    [geometryItems]
  );

  const propLayouts = useMemo(
    () =>
      settleLayouts(
        geometryItems.map((item, index) => ({
          id: item.id,
          layout: item.layout,
          minW: item.minW,
          minH: item.minH,
          index
        })),
        innerWidth
      ),
    [geometryItems, innerWidth]
  );
  const propLayoutsRef = useRef(propLayouts);

  const boardHeight = useMemo(() => {
    const contentHeight = Math.max(
      0,
      ...Object.values(liveLayouts).map((layout) => layout.y + layout.h)
    );

    return Math.max(metrics.height, contentHeight + BOARD_PADDING);
  }, [liveLayouts, metrics.height]);

  useEffect(() => {
    onArrangeChangeRef.current = onArrangeChange;
  }, [onArrangeChange]);

  useEffect(() => {
    onLayoutCommitRef.current = onLayoutCommit;
  }, [onLayoutCommit]);

  useEffect(() => {
    propLayoutsRef.current = propLayouts;
  }, [propLayouts]);

  useEffect(() => {
    return () => {
      const interaction = interactionRef.current;
      const wasArranging = Boolean(interaction || settleTimeoutRef.current !== null);

      cancelScheduledLayouts();
      clearSettleTimeout();

      if (interaction) {
        interactionRef.current = null;

        try {
          interaction.capturedElement.releasePointerCapture(interaction.pointerId);
        } catch {
          // The pointer may already be released if the window lost focus.
        }
      }

      if (wasArranging) {
        onArrangeChangeRef.current?.(false);
      }
    };
  }, []);

  useEffect(() => {
    if (interactionRef.current) {
      return;
    }

    setLiveLayouts((current) =>
      layoutsEqual(current, propLayouts) ? current : propLayouts
    );
  }, [propLayouts]);

  // Clear the post-release transition suppression one frame after the layout
  // stops moving. Keyed on liveLayouts so each post-release change (the commit,
  // then the synchronous persist -> propLayouts round-trip) re-arms the frame;
  // released only clears once nothing further is pending, avoiding a fixed-timer
  // race that could re-enable the eased transition mid-settle.
  useEffect(() => {
    if (!released) {
      return;
    }

    const frame = window.requestAnimationFrame(() => setReleased(false));
    return () => window.cancelAnimationFrame(frame);
  }, [released, liveLayouts]);

  useEffect(() => {
    if (!boardRef.current) {
      return;
    }

    const measuredElement = boardRef.current.parentElement ?? boardRef.current;
    const measureBoard = () => {
      const rect = measuredElement.getBoundingClientRect();

      setMetrics((current) => {
        if (current.width === rect.width && current.height === rect.height) {
          return current;
        }

        return {
          width: rect.width,
          height: rect.height
        };
      });
    };
    const resizeObserver = new ResizeObserver(measureBoard);

    measureBoard();
    resizeObserver.observe(measuredElement);
    window.addEventListener("resize", measureBoard);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measureBoard);
    };
  }, []);

  useEffect(() => {
    if (!activeInteraction) {
      return;
    }

    const updateInteractionAtPosition = (clientX: number, clientY: number) => {
      const interaction = interactionRef.current;
      if (!interaction) {
        return;
      }

      const dx = clientX - interaction.startClientX;
      const dy = clientY - interaction.startClientY;
      const options = itemOptions.get(interaction.itemId) ?? {
        minW: DEFAULT_MIN_W,
        minH: DEFAULT_MIN_H
      };
      const candidate =
        interaction.type === "move"
          ? buildMoveLayout(interaction.startRect, dx, dy, innerWidth)
          : buildResizeLayout(
              interaction.startRect,
              interaction.axis ?? "se",
              dx,
              dy,
              innerWidth,
              options.minW,
              options.minH
            );

      if (
        !isLayoutWithinBounds(
          candidate,
          innerWidth,
          options.minW,
          options.minH
        )
      ) {
        return;
      }

      const nextLayout = sanitizeLayout(
        candidate,
        innerWidth,
        options.minW,
        options.minH
      );
      const swapTargetId =
        interaction.type === "move"
          ? findSwapTargetId(
              interaction.itemId,
              nextLayout,
              interaction.layoutsAtStart,
              innerWidth
            )
          : null;
      const nextLayouts =
        interaction.type === "move" && swapTargetId
          ? buildSwapPreviewLayouts(
              interaction,
              nextLayout,
              swapTargetId,
              innerWidth,
              itemOptions
            )
          : interaction.type === "resize"
            ? buildAdjacentResizeLayouts(
                interaction,
                nextLayout,
                innerWidth,
                itemOptions
              )
          : {
              ...interaction.layoutsAtStart,
              [interaction.itemId]: nextLayout
            };

      interaction.lastValidLayouts = nextLayouts;
      interaction.lastValidLayout = nextLayouts[interaction.itemId] ?? nextLayout;
      interaction.swapTargetId = swapTargetId;
      setLiveLayouts((current) =>
        layoutsEqual(current, nextLayouts) ? current : nextLayouts
      );
    };

    const handlePointerMove = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return;
      }

      event.preventDefault();
      pendingPointerPositionRef.current = {
        clientX: event.clientX,
        clientY: event.clientY
      };

      if (pendingLayoutFrameRef.current !== null) {
        return;
      }

      pendingLayoutFrameRef.current = window.requestAnimationFrame(() => {
        pendingLayoutFrameRef.current = null;
        const position = pendingPointerPositionRef.current;
        pendingPointerPositionRef.current = null;

        if (position) {
          updateInteractionAtPosition(position.clientX, position.clientY);
        }
      });
    };

    const finishInteraction = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return;
      }

      // The last raw move may still be waiting for rAF. Cancel it and compute
      // once at the release coordinates before reading the interaction result.
      cancelScheduledLayouts();
      updateInteractionAtPosition(event.clientX, event.clientY);

      const swapCommitLayouts =
        interaction.type === "move" && interaction.swapTargetId
          ? buildSwapCommitLayouts(
              interaction,
              interaction.swapTargetId,
              innerWidth,
              itemOptions
            )
          : null;
      const committedLayouts =
        swapCommitLayouts ??
        (interaction.type === "resize"
          ? interaction.lastValidLayouts
          : null) ??
        (() => {
          const desiredDropRect =
            interaction.type === "move"
              ? buildMoveDropRect(
                  interaction.startRect,
                  event.clientX - interaction.startClientX,
                  event.clientY - interaction.startClientY
                )
              : undefined;
          const committedLayout = resolveDropLayout(
            interaction.itemId,
            interaction.lastValidLayout,
            interaction.layoutsAtStart,
            innerWidth,
            metrics.height,
            itemOptions,
            desiredDropRect
          );

          return {
            ...interaction.layoutsAtStart,
            [interaction.itemId]: committedLayout
          };
        })();

      const compactedLayouts = committedLayoutsOverlap(
        committedLayouts,
        innerWidth
      )
        ? compactCommittedLayouts(committedLayouts, geometryItems, innerWidth)
        : committedLayouts;
      const changedLayouts = changedLayoutEntries(
        interaction.layoutsAtStart,
        compactedLayouts
      );

      try {
        interaction.capturedElement.releasePointerCapture(interaction.pointerId);
      } catch {
        // The pointer may already be released if the window lost focus.
      }

      interactionRef.current = null;
      setLiveLayouts((current) =>
        layoutsEqual(current, compactedLayouts) ? current : compactedLayouts
      );
      setActiveInteraction(null);
      setReleased(true);
      finishArrangeAfterSettle();
      if (Object.keys(changedLayouts).length > 0) {
        onLayoutCommitRef.current(changedLayouts);
      }
    };

    const cancelInteraction = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return;
      }

      abortInteraction();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !interactionRef.current) {
        return;
      }

      event.preventDefault();
      abortInteraction();
    };

    const handleWindowBlur = () => {
      if (interactionRef.current) {
        abortInteraction();
      }
    };

    window.addEventListener("pointermove", handlePointerMove, {
      passive: false
    });
    window.addEventListener("pointerup", finishInteraction);
    window.addEventListener("pointercancel", cancelInteraction);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishInteraction);
      window.removeEventListener("pointercancel", cancelInteraction);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", handleWindowBlur);
      cancelScheduledLayouts();
    };
  }, [activeInteraction, geometryItems, innerWidth, itemOptions, metrics.height]);

  useEffect(() => {
    const interaction = interactionRef.current;
    if (!interaction) {
      return;
    }

    const currentItemIds = new Set(geometryItems.map((item) => item.id));
    const itemMembershipChanged =
      currentItemIds.size !== interaction.itemIdsAtStart.length ||
      interaction.itemIdsAtStart.some((itemId) => !currentItemIds.has(itemId));

    if (disabled || itemMembershipChanged) {
      abortInteraction();
    }
  }, [disabled, geometryItems]);

  function startInteraction(
    event: ReactPointerEvent<HTMLElement>,
    item: TiledBoardItem,
    type: "move" | "resize",
    axis?: ResizeAxis
  ) {
    if (
      disabled ||
      interactionRef.current ||
      event.isPrimary === false ||
      event.button !== 0
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    clearSettleTimeout();

    const layoutsAtStart = {
      ...propLayouts,
      ...liveLayouts
    };
    const options = itemOptions.get(item.id) ?? {
      minW: DEFAULT_MIN_W,
      minH: DEFAULT_MIN_H
    };
    const startLayout = sanitizeLayout(
      layoutsAtStart[item.id] ?? item.layout,
      innerWidth,
      options.minW,
      options.minH
    );
    const startingLayouts = {
      ...layoutsAtStart,
      [item.id]: startLayout
    };
    const capturedElement = event.currentTarget;

    try {
      capturedElement.setPointerCapture(event.pointerId);
    } catch {
      // Window-level pointer listeners still keep the interaction alive.
    }

    interactionRef.current = {
      type,
      itemId: item.id,
      pointerId: event.pointerId,
      axis,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLayout,
      startRect: layoutToRect(startLayout, innerWidth),
      itemIdsAtStart: geometryItems.map((currentItem) => currentItem.id),
      layoutsAtStart: startingLayouts,
      lastValidLayout: startLayout,
      lastValidLayouts: startingLayouts,
      swapTargetId: null,
      capturedElement
    };

    setActiveInteraction({ itemId: item.id, type, axis });
    onArrangeChangeRef.current?.(true);
  }

  function cancelScheduledLayouts() {
    if (pendingLayoutFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingLayoutFrameRef.current);
      pendingLayoutFrameRef.current = null;
    }

    pendingPointerPositionRef.current = null;
  }

  function clearSettleTimeout() {
    if (settleTimeoutRef.current !== null) {
      window.clearTimeout(settleTimeoutRef.current);
      settleTimeoutRef.current = null;
    }
  }

  function abortInteraction() {
    const interaction = interactionRef.current;

    clearSettleTimeout();
    cancelScheduledLayouts();
    interactionRef.current = null;

    if (interaction) {
      try {
        interaction.capturedElement.releasePointerCapture(interaction.pointerId);
      } catch {
        // The pointer may already be released if the window lost focus.
      }
    }

    setLiveLayouts((current) =>
      layoutsEqual(current, propLayoutsRef.current) ? current : propLayoutsRef.current
    );
    setActiveInteraction(null);
    setReleased(true);
    onArrangeChangeRef.current?.(false);
  }

  function finishArrangeAfterSettle() {
    clearSettleTimeout();

    settleTimeoutRef.current = window.setTimeout(() => {
      settleTimeoutRef.current = null;
      onArrangeChangeRef.current?.(false);
    }, ARRANGE_SETTLE_MS);
  }

  function handleFramePointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
    item: TiledBoardItem
  ) {
    const target = event.target as HTMLElement;
    if (shouldIgnoreDragTarget(target) || !target.closest(".pane-drag-zone")) {
      return;
    }

    startInteraction(event, item, "move");
  }

  function layoutToStyle(layout: LayoutBox): CSSProperties {
    const rect = layoutToRect(layout, innerWidth);
    return {
      transform: `translate3d(${BOARD_PADDING + rect.left}px, ${rect.top}px, 0)`,
      width: rect.width,
      height: rect.height
    };
  }

  return (
    <div
      ref={boardRef}
      className={clsx(
        "tiled-board",
        activeInteraction && "tiled-board-arranging",
        released && "tiled-board-released",
        disabled && "tiled-board-disabled"
      )}
      style={{ height: boardHeight }}
    >
      {items.map((item) => {
        const layout = liveLayouts[item.id] ?? propLayouts[item.id] ?? item.layout;
        const isActive = activeInteraction?.itemId === item.id;

        return (
          <div
            key={item.id}
            className={clsx(
              "pane-frame",
              isActive && activeInteraction.type === "move" && "pane-frame-moving",
              isActive &&
                activeInteraction.type === "resize" &&
                "pane-frame-resizing",
              disabled && "pane-frame-disabled"
            )}
            data-session-id={item.id}
            style={layoutToStyle(layout)}
            onPointerDown={(event) => handleFramePointerDown(event, item)}
          >
            {item.content}
            {!disabled &&
              RESIZE_AXES.map((axis) => (
                <span
                  key={axis}
                  className={clsx(
                    "pane-resize-edge",
                    `pane-resize-edge-${axis}`,
                    isActive &&
                      activeInteraction.type === "resize" &&
                      activeInteraction.axis === axis &&
                      "pane-resize-edge-active"
                  )}
                  data-resize-axis={axis}
                  onPointerDown={(event) =>
                    startInteraction(event, item, "resize", axis)
                  }
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}
