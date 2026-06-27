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

type ResizeAxis = "n" | "e" | "s" | "w" | "ne" | "se" | "sw" | "nw";

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

interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface NormalizableItem {
  id: string;
  layout: LayoutBox;
  minW?: number;
  minH?: number;
  index: number;
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
  layoutsAtStart: Record<string, LayoutBox>;
  lastValidLayout: LayoutBox;
  lastValidLayouts: Record<string, LayoutBox>;
  swapTargetId?: string | null;
  capturedElement: HTMLElement;
}

const BOARD_GAP = 4;
const BOARD_PADDING = 10;
const DEFAULT_MIN_W = 280;
const DEFAULT_MIN_H = 170;
const SWAP_OVERLAP_RATIO = 0.22;
const ARRANGE_SETTLE_MS = 180;
const ADJACENT_RESIZE_TOLERANCE = 32;
const RESIZE_AXES: ResizeAxis[] = ["n", "e", "s", "w", "ne", "se", "sw", "nw"];

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function percentToPx(value: number, innerWidth: number) {
  return (value / 100) * innerWidth;
}

function pxToPercent(value: number, innerWidth: number) {
  if (innerWidth <= 0) {
    return 0;
  }

  return (value / innerWidth) * 100;
}

function layoutToRect(layout: LayoutBox, innerWidth: number): PixelRect {
  return {
    left: percentToPx(layout.x, innerWidth),
    top: layout.y,
    width: percentToPx(layout.w, innerWidth),
    height: layout.h
  };
}

function rectToLayout(rect: PixelRect, innerWidth: number): LayoutBox {
  return {
    x: pxToPercent(rect.left, innerWidth),
    y: rect.top,
    w: pxToPercent(rect.width, innerWidth),
    h: rect.height,
    unit: "fluid"
  };
}

function sanitizeLayout(
  layout: LayoutBox,
  innerWidth: number,
  minW = DEFAULT_MIN_W,
  minH = DEFAULT_MIN_H
): LayoutBox {
  const minWidth = Math.min(minW, innerWidth);
  const width = clamp(percentToPx(layout.w, innerWidth), minWidth, innerWidth);
  const left = clamp(
    percentToPx(layout.x, innerWidth),
    0,
    Math.max(0, innerWidth - width)
  );
  const height = Math.max(minH, layout.h);

  return rectToLayout(
    {
      left,
      top: Math.max(BOARD_PADDING, layout.y),
      width,
      height
    },
    innerWidth
  );
}

function normalizeLayouts(
  items: NormalizableItem[],
  innerWidth: number,
  pinnedId?: string
): Record<string, LayoutBox> {
  const sanitizedItems = items
    .map((item) => ({
      ...item,
      layout: sanitizeLayout(
        item.layout,
        innerWidth,
        item.minW ?? DEFAULT_MIN_W,
        item.minH ?? DEFAULT_MIN_H
      )
    }))
    .sort((a, b) => {
      if (a.id === pinnedId && b.id !== pinnedId) {
        return -1;
      }

      if (b.id === pinnedId && a.id !== pinnedId) {
        return 1;
      }

      if (a.layout.y !== b.layout.y) {
        return a.layout.y - b.layout.y;
      }

      if (a.layout.x !== b.layout.x) {
        return a.layout.x - b.layout.x;
      }

      return a.index - b.index;
    });
  const placedRects: Array<{ id: string; rect: PixelRect }> = [];
  const normalizedLayouts: Record<string, LayoutBox> = {};

  sanitizedItems.forEach((item) => {
    const rect = layoutToRect(item.layout, innerWidth);

    // Gravity: pull each item up to the lowest hole-free top within its column.
    // Items are placed in ascending-y order, so every horizontally-overlapping
    // rect already placed sits at or above this one; a single skyline pass then
    // yields the minimum non-colliding top (filling any vacated space above).
    rect.top = placedRects.reduce((top, placed) => {
      if (horizontalOverlap(rect, placed.rect)) {
        return Math.max(top, placed.rect.top + placed.rect.height + BOARD_GAP);
      }

      return top;
    }, BOARD_PADDING);

    placedRects.push({ id: item.id, rect });
    normalizedLayouts[item.id] = rectToLayout(rect, innerWidth);
  });

  return normalizedLayouts;
}

// Settle a committed (drag/resize/swap) layout set through the same gravity
// pass so the released state matches what props re-normalize into, keeping the
// live preview and persisted layout in lockstep (no snap-then-settle flicker).
function compactCommittedLayouts(
  committed: Record<string, LayoutBox>,
  items: TiledBoardItem[],
  innerWidth: number,
  pinnedId?: string
): Record<string, LayoutBox> {
  const normalizableItems = items
    .map((item, index): NormalizableItem | null => {
      const layout = committed[item.id];

      if (!layout) {
        return null;
      }

      return {
        id: item.id,
        layout,
        minW: item.minW,
        minH: item.minH,
        index
      };
    })
    .filter((item): item is NormalizableItem => item !== null);

  return normalizeLayouts(normalizableItems, innerWidth, pinnedId);
}

function rectsOverlap(a: PixelRect, b: PixelRect, gap = BOARD_GAP) {
  return (
    a.left < b.left + b.width + gap &&
    a.left + a.width + gap > b.left &&
    a.top < b.top + b.height + gap &&
    a.top + a.height + gap > b.top
  );
}

function horizontalOverlap(a: PixelRect, b: PixelRect, gap = BOARD_GAP) {
  return a.left < b.left + b.width + gap && a.left + a.width + gap > b.left;
}

function rectArea(rect: PixelRect) {
  return rect.width * rect.height;
}

function rectIntersectionArea(a: PixelRect, b: PixelRect) {
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.top + a.height, b.top + b.height);

  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function rectCenter(rect: PixelRect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

function pointInRect(point: { x: number; y: number }, rect: PixelRect) {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}

function rectRight(rect: PixelRect) {
  return rect.left + rect.width;
}

function rectBottom(rect: PixelRect) {
  return rect.top + rect.height;
}

function rangeOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return rangeOverlap(aStart, aEnd, bStart, bEnd) > 0;
}

function findSwapTargetId(
  itemId: string,
  draggedLayout: LayoutBox,
  layoutsAtStart: Record<string, LayoutBox>,
  innerWidth: number
) {
  const draggedRect = layoutToRect(draggedLayout, innerWidth);
  const draggedCenter = rectCenter(draggedRect);
  const draggedArea = rectArea(draggedRect);

  return Object.entries(layoutsAtStart)
    .filter(([id]) => id !== itemId)
    .map(([id, layout]) => {
      const targetRect = layoutToRect(layout, innerWidth);
      const targetCenter = rectCenter(targetRect);
      const overlapRatio =
        rectIntersectionArea(draggedRect, targetRect) /
        Math.max(1, Math.min(draggedArea, rectArea(targetRect)));
      const centerInside = pointInRect(draggedCenter, targetRect);
      const centerDistance =
        (draggedCenter.x - targetCenter.x) ** 2 +
        (draggedCenter.y - targetCenter.y) ** 2;

      return {
        id,
        isMatch: centerInside || overlapRatio >= SWAP_OVERLAP_RATIO,
        score: (centerInside ? 1000 : 0) + overlapRatio * 100 - centerDistance / 10000
      };
    })
    .filter((candidate) => candidate.isMatch)
    .sort((a, b) => b.score - a.score)[0]?.id;
}

function isLayoutWithinBounds(
  candidate: LayoutBox,
  innerWidth: number,
  minW: number,
  minH: number
) {
  const rect = layoutToRect(candidate, innerWidth);
  return (
    rect.left >= 0 &&
    rect.top >= BOARD_PADDING &&
    rect.width >= Math.min(minW, innerWidth) &&
    rect.height >= minH &&
    rect.left + rect.width <= innerWidth
  );
}

function rectDistanceScore(a: PixelRect, b: PixelRect) {
  const dx = a.left - b.left;
  const dy = a.top - b.top;
  return dx * dx + dy * dy;
}

function dedupeNumberValues(values: number[]) {
  return Array.from(new Set(values.map((value) => Math.round(value * 1000) / 1000)));
}

function itemSizing(
  options: Map<string, { minW: number; minH: number }>,
  itemId: string
) {
  return (
    options.get(itemId) ?? {
      minW: DEFAULT_MIN_W,
      minH: DEFAULT_MIN_H
    }
  );
}

function buildSwapPreviewLayouts(
  interaction: InteractionState,
  draggedLayout: LayoutBox,
  swapTargetId: string,
  innerWidth: number,
  options: Map<string, { minW: number; minH: number }>
) {
  const targetOption = itemSizing(options, swapTargetId);

  return {
    ...interaction.layoutsAtStart,
    [swapTargetId]: sanitizeLayout(
      interaction.startLayout,
      innerWidth,
      targetOption.minW,
      targetOption.minH
    ),
    [interaction.itemId]: draggedLayout
  };
}

function buildSwapCommitLayouts(
  interaction: InteractionState,
  swapTargetId: string,
  innerWidth: number,
  options: Map<string, { minW: number; minH: number }>
) {
  const targetLayout = interaction.layoutsAtStart[swapTargetId];

  if (!targetLayout) {
    return null;
  }

  const activeOption = itemSizing(options, interaction.itemId);
  const targetOption = itemSizing(options, swapTargetId);

  return {
    ...interaction.layoutsAtStart,
    [interaction.itemId]: sanitizeLayout(
      targetLayout,
      innerWidth,
      activeOption.minW,
      activeOption.minH
    ),
    [swapTargetId]: sanitizeLayout(
      interaction.startLayout,
      innerWidth,
      targetOption.minW,
      targetOption.minH
    )
  };
}

function isRightResizeNeighbor(
  startRect: PixelRect,
  activeRect: PixelRect,
  neighborRect: PixelRect
) {
  const startRight = rectRight(startRect);
  const activeRight = rectRight(activeRect);
  const initialGap = neighborRect.left - startRight;

  return (
    rangesOverlap(startRect.top, rectBottom(startRect), neighborRect.top, rectBottom(neighborRect)) &&
    neighborRect.left >= startRight - ADJACENT_RESIZE_TOLERANCE &&
    (initialGap <= ADJACENT_RESIZE_TOLERANCE ||
      activeRight + BOARD_GAP > neighborRect.left)
  );
}

function isLeftResizeNeighbor(
  startRect: PixelRect,
  activeRect: PixelRect,
  neighborRect: PixelRect
) {
  const neighborRight = rectRight(neighborRect);
  const initialGap = startRect.left - neighborRight;

  return (
    rangesOverlap(startRect.top, rectBottom(startRect), neighborRect.top, rectBottom(neighborRect)) &&
    neighborRight <= startRect.left + ADJACENT_RESIZE_TOLERANCE &&
    (initialGap <= ADJACENT_RESIZE_TOLERANCE ||
      activeRect.left < neighborRight + BOARD_GAP)
  );
}

function isBelowResizeNeighbor(
  startRect: PixelRect,
  activeRect: PixelRect,
  neighborRect: PixelRect
) {
  const startBottom = rectBottom(startRect);
  const activeBottom = rectBottom(activeRect);
  const initialGap = neighborRect.top - startBottom;

  return (
    rangesOverlap(startRect.left, rectRight(startRect), neighborRect.left, rectRight(neighborRect)) &&
    neighborRect.top >= startBottom - ADJACENT_RESIZE_TOLERANCE &&
    (initialGap <= ADJACENT_RESIZE_TOLERANCE ||
      activeBottom + BOARD_GAP > neighborRect.top)
  );
}

function isAboveResizeNeighbor(
  startRect: PixelRect,
  activeRect: PixelRect,
  neighborRect: PixelRect
) {
  const neighborBottom = rectBottom(neighborRect);
  const initialGap = startRect.top - neighborBottom;

  return (
    rangesOverlap(startRect.left, rectRight(startRect), neighborRect.left, rectRight(neighborRect)) &&
    neighborBottom <= startRect.top + ADJACENT_RESIZE_TOLERANCE &&
    (initialGap <= ADJACENT_RESIZE_TOLERANCE ||
      activeRect.top < neighborBottom + BOARD_GAP)
  );
}

function buildAdjacentResizeLayouts(
  interaction: InteractionState,
  resizedLayout: LayoutBox,
  innerWidth: number,
  options: Map<string, { minW: number; minH: number }>
) {
  const axis = interaction.axis;
  const activeOption = itemSizing(options, interaction.itemId);
  const activeMinWidth = Math.min(activeOption.minW, innerWidth);
  const startRect = interaction.startRect;
  const neighborEntries = Object.entries(interaction.layoutsAtStart)
    .filter(([id]) => id !== interaction.itemId)
    .map(([id, layout]) => {
      const option = itemSizing(options, id);

      return {
        id,
        option,
        rect: layoutToRect(
          sanitizeLayout(layout, innerWidth, option.minW, option.minH),
          innerWidth
        )
      };
    });
  const neighborRects = new Map(
    neighborEntries.map(({ id, rect }) => [
      id,
      {
        ...rect
      }
    ])
  );
  const activeRect = layoutToRect(
    sanitizeLayout(resizedLayout, innerWidth, activeOption.minW, activeOption.minH),
    innerWidth
  );

  if (axis?.includes("e")) {
    const rightNeighbors = neighborEntries.filter(({ rect }) =>
      isRightResizeNeighbor(startRect, activeRect, rect)
    );
    const rightLimit = rightNeighbors.reduce(
      (limit, { rect, option }) =>
        Math.min(limit, rectRight(rect) - Math.min(option.minW, innerWidth) - BOARD_GAP),
      innerWidth
    );
    const activeRight = Math.min(rectRight(activeRect), rightLimit);

    activeRect.width = Math.max(activeMinWidth, activeRight - activeRect.left);
    rightNeighbors.forEach(({ id, rect }) => {
      const nextLeft = rectRight(activeRect) + BOARD_GAP;
      const current = neighborRects.get(id);

      if (!current) {
        return;
      }

      current.left = nextLeft;
      current.width = rectRight(rect) - nextLeft;
    });
  }

  if (axis?.includes("w")) {
    const leftNeighbors = neighborEntries.filter(({ rect }) =>
      isLeftResizeNeighbor(startRect, activeRect, rect)
    );
    const leftLimit = leftNeighbors.reduce(
      (limit, { rect, option }) =>
        Math.max(limit, rect.left + Math.min(option.minW, innerWidth) + BOARD_GAP),
      0
    );
    const activeRight = rectRight(activeRect);

    activeRect.left = Math.min(Math.max(activeRect.left, leftLimit), activeRight - activeMinWidth);
    activeRect.width = activeRight - activeRect.left;
    leftNeighbors.forEach(({ id, rect }) => {
      const current = neighborRects.get(id);

      if (!current) {
        return;
      }

      current.width = activeRect.left - BOARD_GAP - rect.left;
    });
  }

  if (axis?.includes("s")) {
    const belowNeighbors = neighborEntries.filter(({ rect }) =>
      isBelowResizeNeighbor(startRect, activeRect, rect)
    );
    const bottomLimit = belowNeighbors.reduce(
      (limit, { rect, option }) =>
        Math.min(limit, rectBottom(rect) - option.minH - BOARD_GAP),
      Infinity
    );
    const activeBottom = Math.min(rectBottom(activeRect), bottomLimit);

    activeRect.height = Math.max(activeOption.minH, activeBottom - activeRect.top);
    belowNeighbors.forEach(({ id, rect }) => {
      const nextTop = rectBottom(activeRect) + BOARD_GAP;
      const current = neighborRects.get(id);

      if (!current) {
        return;
      }

      current.top = nextTop;
      current.height = rectBottom(rect) - nextTop;
    });
  }

  if (axis?.includes("n")) {
    const aboveNeighbors = neighborEntries.filter(({ rect }) =>
      isAboveResizeNeighbor(startRect, activeRect, rect)
    );
    const topLimit = aboveNeighbors.reduce(
      (limit, { rect, option }) =>
        Math.max(limit, rect.top + option.minH + BOARD_GAP),
      BOARD_PADDING
    );
    const activeBottom = rectBottom(activeRect);

    activeRect.top = Math.min(Math.max(activeRect.top, topLimit), activeBottom - activeOption.minH);
    activeRect.height = activeBottom - activeRect.top;
    aboveNeighbors.forEach(({ id, rect }) => {
      const current = neighborRects.get(id);

      if (!current) {
        return;
      }

      current.height = activeRect.top - BOARD_GAP - rect.top;
    });
  }

  const nextLayouts = {
    ...interaction.layoutsAtStart,
    [interaction.itemId]: rectToLayout(activeRect, innerWidth)
  };

  neighborRects.forEach((rect, id) => {
    const option = itemSizing(options, id);

    nextLayouts[id] = sanitizeLayout(
      rectToLayout(rect, innerWidth),
      innerWidth,
      option.minW,
      option.minH
    );
  });

  return nextLayouts;
}

function buildMoveDropRect(
  startRect: PixelRect,
  dx: number,
  dy: number
): PixelRect {
  return {
    ...startRect,
    left: startRect.left + dx,
    top: Math.max(BOARD_PADDING, startRect.top + dy)
  };
}

function expandedRangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
) {
  return rangesOverlap(aStart - BOARD_GAP, aEnd + BOARD_GAP, bStart, bEnd);
}

function availableWidthForHeight(
  left: number,
  top: number,
  height: number,
  fixedRects: PixelRect[],
  innerWidth: number
) {
  const rightLimit = fixedRects.reduce((limit, rect) => {
    if (
      rect.left >= left &&
      expandedRangesOverlap(top, top + height, rect.top, rectBottom(rect))
    ) {
      return Math.min(limit, rect.left - BOARD_GAP);
    }

    return limit;
  }, innerWidth);

  return rightLimit - left;
}

function availableHeightForWidth(
  left: number,
  top: number,
  width: number,
  fixedRects: PixelRect[],
  visibleBottom: number
) {
  const bottomLimit = fixedRects.reduce((limit, rect) => {
    if (
      rect.top >= top &&
      expandedRangesOverlap(left, left + width, rect.left, rectRight(rect))
    ) {
      return Math.min(limit, rect.top - BOARD_GAP);
    }

    return limit;
  }, visibleBottom);

  return bottomLimit - top;
}

function fitDropRectAtAnchor(
  anchor: { left: number; top: number },
  desiredRect: PixelRect,
  fixedRects: PixelRect[],
  innerWidth: number,
  visibleBottom: number,
  minWidth: number,
  minHeight: number
) {
  const minimumRect: PixelRect = {
    left: anchor.left,
    top: anchor.top,
    width: minWidth,
    height: minHeight
  };

  if (
    minimumRect.left < 0 ||
    minimumRect.top < BOARD_PADDING ||
    rectRight(minimumRect) > innerWidth ||
    rectBottom(minimumRect) > visibleBottom ||
    fixedRects.some((rect) => rectsOverlap(minimumRect, rect))
  ) {
    return null;
  }

  let width = Math.min(desiredRect.width, innerWidth - anchor.left);
  let height = Math.min(desiredRect.height, visibleBottom - anchor.top);

  for (let guard = 0; guard < 4; guard += 1) {
    const maxWidth = availableWidthForHeight(
      anchor.left,
      anchor.top,
      height,
      fixedRects,
      innerWidth
    );

    if (maxWidth < minWidth) {
      return null;
    }

    width = Math.min(Math.max(width, minWidth), maxWidth);

    const maxHeight = availableHeightForWidth(
      anchor.left,
      anchor.top,
      width,
      fixedRects,
      visibleBottom
    );

    if (maxHeight < minHeight) {
      return null;
    }

    height = Math.min(Math.max(height, minHeight), maxHeight);
  }

  const fittedRect = {
    left: anchor.left,
    top: anchor.top,
    width,
    height
  };

  if (
    rectRight(fittedRect) > innerWidth ||
    rectBottom(fittedRect) > visibleBottom ||
    fixedRects.some((rect) => rectsOverlap(fittedRect, rect))
  ) {
    return null;
  }

  return fittedRect;
}

function findFittedDropRect(
  desiredRect: PixelRect,
  fixedRects: PixelRect[],
  innerWidth: number,
  visibleBottom: number,
  minWidth: number,
  minHeight: number
) {
  const maxLeft = Math.max(0, innerWidth - minWidth);
  const maxTop = Math.max(BOARD_PADDING, visibleBottom - minHeight);
  const xValues = dedupeNumberValues([
    desiredRect.left,
    desiredRect.left + desiredRect.width - minWidth,
    0,
    maxLeft,
    ...fixedRects.flatMap((rect) => [
      rect.left,
      rectRight(rect) + BOARD_GAP,
      rect.left - minWidth - BOARD_GAP,
      rectRight(rect) - minWidth
    ])
  ]);
  const yValues = dedupeNumberValues([
    desiredRect.top,
    desiredRect.top + desiredRect.height - minHeight,
    BOARD_PADDING,
    maxTop,
    ...fixedRects.flatMap((rect) => [
      rect.top,
      rectBottom(rect) + BOARD_GAP,
      rect.top - minHeight - BOARD_GAP,
      rectBottom(rect) - minHeight
    ])
  ]);
  const anchors = xValues.flatMap((left) =>
    yValues.map((top) => ({
      left: clamp(left, 0, maxLeft),
      top: clamp(top, BOARD_PADDING, maxTop)
    }))
  );

  return (
    anchors
      .map((anchor) =>
        fitDropRectAtAnchor(
          anchor,
          desiredRect,
          fixedRects,
          innerWidth,
          visibleBottom,
          minWidth,
          minHeight
        )
      )
      .filter((rect): rect is PixelRect => Boolean(rect))
      .sort((a, b) => {
        const distance =
          rectDistanceScore(a, desiredRect) - rectDistanceScore(b, desiredRect);

        if (Math.abs(distance) > 0.001) {
          return distance;
        }

        return rectArea(b) - rectArea(a);
      })[0] ?? null
  );
}

function resolveDropLayout(
  itemId: string,
  desiredLayout: LayoutBox,
  layoutsAtStart: Record<string, LayoutBox>,
  innerWidth: number,
  viewportHeight: number,
  options: Map<string, { minW: number; minH: number }>,
  desiredDropRect?: PixelRect
) {
  const itemOption = options.get(itemId) ?? {
    minW: DEFAULT_MIN_W,
    minH: DEFAULT_MIN_H
  };
  const desired = sanitizeLayout(
    desiredLayout,
    innerWidth,
    itemOption.minW,
    itemOption.minH
  );
  const sanitizedDesiredRect = layoutToRect(desired, innerWidth);
  const desiredRect = desiredDropRect
    ? {
        ...desiredDropRect,
        width: sanitizedDesiredRect.width,
        height: sanitizedDesiredRect.height
      }
    : sanitizedDesiredRect;
  const fixedRects = Object.entries(layoutsAtStart)
    .filter(([id]) => id !== itemId)
    .map(([id, layout]) => {
      const option = options.get(id) ?? {
        minW: DEFAULT_MIN_W,
        minH: DEFAULT_MIN_H
      };
      return layoutToRect(
        sanitizeLayout(layout, innerWidth, option.minW, option.minH),
        innerWidth
      );
    });
  const minWidth = Math.min(itemOption.minW, innerWidth);
  const minHeight = itemOption.minH;
  const fittedVisibleBottom =
    viewportHeight > 0 ? Math.max(viewportHeight, BOARD_PADDING + minHeight) : Infinity;

  if (!fixedRects.some((rect) => rectsOverlap(sanitizedDesiredRect, rect))) {
    return desired;
  }

  const fittedRect = findFittedDropRect(
    desiredRect,
    fixedRects,
    innerWidth,
    fittedVisibleBottom,
    minWidth,
    minHeight
  );

  if (fittedRect) {
    return rectToLayout(fittedRect, innerWidth);
  }

  const maxLeft = Math.max(0, innerWidth - sanitizedDesiredRect.width);
  const xValues = dedupeNumberValues([
    sanitizedDesiredRect.left,
    0,
    maxLeft,
    ...fixedRects.flatMap((rect) => [
      rect.left,
      rect.left + rect.width + BOARD_GAP,
      rect.left - sanitizedDesiredRect.width - BOARD_GAP
    ])
  ]);
  const yValues = dedupeNumberValues([
    sanitizedDesiredRect.top,
    BOARD_PADDING,
    ...fixedRects.flatMap((rect) => [
      rect.top,
      rect.top + rect.height + BOARD_GAP,
      rect.top - sanitizedDesiredRect.height - BOARD_GAP
    ])
  ]);
  const visibleBottom =
    viewportHeight > 0
      ? Math.max(viewportHeight, BOARD_PADDING + sanitizedDesiredRect.height)
      : Infinity;

  const candidates = xValues.flatMap((left) =>
    yValues.map((top) => ({
      left: clamp(left, 0, maxLeft),
      top: Math.max(BOARD_PADDING, top),
      width: sanitizedDesiredRect.width,
      height: sanitizedDesiredRect.height
    }))
  );

  const bestCandidate = candidates
    .filter(
      (candidate) =>
        candidate.top + candidate.height <= visibleBottom &&
        !fixedRects.some((rect) => rectsOverlap(candidate, rect))
    )
    .sort(
      (a, b) =>
        rectDistanceScore(a, sanitizedDesiredRect) -
        rectDistanceScore(b, sanitizedDesiredRect)
    )[0];

  if (bestCandidate) {
    return rectToLayout(bestCandidate, innerWidth);
  }

  const lowestBottom = fixedRects.reduce(
    (bottom, rect) => Math.max(bottom, rect.top + rect.height),
    BOARD_PADDING
  );

  return rectToLayout(
    {
      ...sanitizedDesiredRect,
      left: clamp(sanitizedDesiredRect.left, 0, maxLeft),
      top: lowestBottom + BOARD_GAP
    },
    innerWidth
  );
}

function shouldIgnoreDragTarget(target: HTMLElement) {
  return Boolean(
    target.closest(
      ".pane-actions, .pane-actions *, .terminal-surface, .terminal-command-strip, button, input, textarea, select, a"
    )
  );
}

function layoutsEqual(
  a: Record<string, LayoutBox>,
  b: Record<string, LayoutBox>
) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }

  return aKeys.every((key) => {
    const aLayout = a[key];
    const bLayout = b[key];
    return (
      aLayout &&
      bLayout &&
      aLayout.x === bLayout.x &&
      aLayout.y === bLayout.y &&
      aLayout.w === bLayout.w &&
      aLayout.h === bLayout.h &&
      aLayout.unit === bLayout.unit
    );
  });
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
  const pendingLiveLayoutsRef = useRef<Record<string, LayoutBox> | null>(null);
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

  const innerWidth = useMemo(
    () => Math.max(1, metrics.width - BOARD_PADDING * 2),
    [metrics.width]
  );

  const itemOptions = useMemo(
    () =>
      new Map(
        items.map((item) => [
          item.id,
          {
            minW: item.minW ?? DEFAULT_MIN_W,
            minH: item.minH ?? DEFAULT_MIN_H
          }
        ])
      ),
    [items]
  );

  const propLayouts = useMemo(
    () =>
      normalizeLayouts(
        items.map((item, index) => ({
          id: item.id,
          layout: item.layout,
          minW: item.minW,
          minH: item.minH,
          index
        })),
        innerWidth
      ),
    [innerWidth, items]
  );

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
    return () => {
      cancelScheduledLayouts();
      clearSettleTimeout();
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

    const handlePointerMove = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return;
      }

      event.preventDefault();

      const dx = event.clientX - interaction.startClientX;
      const dy = event.clientY - interaction.startClientY;
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
      scheduleLiveLayouts(nextLayouts);
    };

    const finishInteraction = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return;
      }

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

      const compactedLayouts = compactCommittedLayouts(
        committedLayouts,
        items,
        innerWidth
      );

      try {
        interaction.capturedElement.releasePointerCapture(interaction.pointerId);
      } catch {
        // The pointer may already be released if the window lost focus.
      }

      cancelScheduledLayouts();
      interactionRef.current = null;
      setLiveLayouts((current) =>
        layoutsEqual(current, compactedLayouts) ? current : compactedLayouts
      );
      setActiveInteraction(null);
      finishArrangeAfterSettle();
      onLayoutCommitRef.current(compactedLayouts);
    };

    window.addEventListener("pointermove", handlePointerMove, {
      passive: false
    });
    window.addEventListener("pointerup", finishInteraction);
    window.addEventListener("pointercancel", finishInteraction);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishInteraction);
      window.removeEventListener("pointercancel", finishInteraction);
    };
  }, [activeInteraction, innerWidth, itemOptions, items, metrics.height]);

  function startInteraction(
    event: ReactPointerEvent<HTMLElement>,
    item: TiledBoardItem,
    type: "move" | "resize",
    axis?: ResizeAxis
  ) {
    if (disabled || event.button !== 0) {
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
      layoutsAtStart: startingLayouts,
      lastValidLayout: startLayout,
      lastValidLayouts: startingLayouts,
      swapTargetId: null,
      capturedElement
    };

    setActiveInteraction({ itemId: item.id, type, axis });
    onArrangeChangeRef.current?.(true);
  }

  function scheduleLiveLayouts(layouts: Record<string, LayoutBox>) {
    pendingLiveLayoutsRef.current = layouts;

    if (pendingLayoutFrameRef.current !== null) {
      return;
    }

    pendingLayoutFrameRef.current = window.requestAnimationFrame(() => {
      pendingLayoutFrameRef.current = null;
      const nextLayouts = pendingLiveLayoutsRef.current;
      pendingLiveLayoutsRef.current = null;

      if (!nextLayouts) {
        return;
      }

      setLiveLayouts((current) =>
        layoutsEqual(current, nextLayouts) ? current : nextLayouts
      );
    });
  }

  function cancelScheduledLayouts() {
    if (pendingLayoutFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingLayoutFrameRef.current);
      pendingLayoutFrameRef.current = null;
    }

    pendingLiveLayoutsRef.current = null;
  }

  function clearSettleTimeout() {
    if (settleTimeoutRef.current !== null) {
      window.clearTimeout(settleTimeoutRef.current);
      settleTimeoutRef.current = null;
    }
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

function buildMoveLayout(
  startRect: PixelRect,
  dx: number,
  dy: number,
  innerWidth: number
): LayoutBox {
  return rectToLayout(
    {
      ...startRect,
      left: clamp(startRect.left + dx, 0, Math.max(0, innerWidth - startRect.width)),
      top: Math.max(BOARD_PADDING, startRect.top + dy)
    },
    innerWidth
  );
}

function buildResizeLayout(
  startRect: PixelRect,
  axis: ResizeAxis,
  dx: number,
  dy: number,
  innerWidth: number,
  minW: number,
  minH: number
): LayoutBox {
  let left = startRect.left;
  let top = startRect.top;
  let width = startRect.width;
  let height = startRect.height;

  if (axis.includes("e")) {
    width = clamp(startRect.width + dx, Math.min(minW, innerWidth), innerWidth - startRect.left);
  }

  if (axis.includes("w")) {
    const right = startRect.left + startRect.width;
    left = clamp(startRect.left + dx, 0, Math.max(0, right - minW));
    width = right - left;
  }

  if (axis.includes("n")) {
    const bottom = startRect.top + startRect.height;
    top = clamp(
      startRect.top + dy,
      BOARD_PADDING,
      Math.max(BOARD_PADDING, bottom - minH)
    );
    height = bottom - top;
  }

  if (axis.includes("s")) {
    height = Math.max(minH, startRect.height + dy);
  }

  return rectToLayout(
    {
      left,
      top,
      width,
      height
    },
    innerWidth
  );
}
