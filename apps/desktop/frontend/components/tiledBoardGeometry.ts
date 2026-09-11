import type { LayoutBox } from "../types";

export type ResizeAxis = "n" | "e" | "s" | "w" | "ne" | "se" | "sw" | "nw";

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NormalizableItem {
  id: string;
  layout: LayoutBox;
  minW?: number;
  minH?: number;
  index: number;
}

export interface GeometryItem {
  id: string;
  layout: LayoutBox;
  minW?: number;
  minH?: number;
}

export interface GeometryInteraction {
  itemId: string;
  axis?: ResizeAxis;
  startLayout: LayoutBox;
  startRect: PixelRect;
  layoutsAtStart: Record<string, LayoutBox>;
}

export const BOARD_GAP = 4;
export const BOARD_PADDING = 10;
export const DEFAULT_MIN_W = 280;
export const DEFAULT_MIN_H = 170;
export const SWAP_OVERLAP_RATIO = 0.22;
export const ADJACENT_RESIZE_TOLERANCE = 32;
// Layouts store x/w as percentages but collide in pixels, so every rect makes a
// percent->px->percent round-trip that is not bit-exact. Two panes separated by
// exactly BOARD_GAP can come back ~1e-13px apart and read as overlapping, which
// makes the gravity pass stack a correctly-placed neighbor underneath. Treat
// sub-pixel differences as "not overlapping" / "in bounds".
export const OVERLAP_EPSILON = 0.5;
export const RESIZE_AXES: ResizeAxis[] = ["n", "e", "s", "w", "ne", "se", "sw", "nw"];

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function percentToPx(value: number, innerWidth: number) {
  return (value / 100) * innerWidth;
}

export function pxToPercent(value: number, innerWidth: number) {
  if (innerWidth <= 0) {
    return 0;
  }

  return (value / innerWidth) * 100;
}

export function layoutToRect(layout: LayoutBox, innerWidth: number): PixelRect {
  return {
    left: percentToPx(layout.x, innerWidth),
    top: layout.y,
    width: percentToPx(layout.w, innerWidth),
    height: layout.h
  };
}

export function rectToLayout(rect: PixelRect, innerWidth: number): LayoutBox {
  return {
    x: pxToPercent(rect.left, innerWidth),
    y: rect.top,
    w: pxToPercent(rect.width, innerWidth),
    h: rect.height,
    unit: "fluid"
  };
}

export function sanitizeLayout(
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

export function normalizeLayouts(
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

    // Repair only a colliding item. Other manually positioned tiles keep their
    // coordinates even when another item in the set needed collision recovery.
    if (placedRects.some((placed) => rectsOverlap(rect, placed.rect))) {
      const tops = [BOARD_PADDING, ...placedRects.map(({ rect }) => rectBottom(rect) + BOARD_GAP)].sort((a, b) => a - b);
      rect.top = tops.find((top) => !placedRects.some((placed) => rectsOverlap({ ...rect, top }, placed.rect))) ?? rect.top;
    }

    placedRects.push({ id: item.id, rect });
    normalizedLayouts[item.id] = rectToLayout(rect, innerWidth);
  });

  return normalizedLayouts;
}

// Persisted layouts are canonical free-form geometry. Sanitize them for the
// current board width, but only invoke gravity when that projection collides.
export function settleLayouts(
  items: NormalizableItem[],
  innerWidth: number
): Record<string, LayoutBox> {
  const sanitizedLayouts = Object.fromEntries(
    items.map((item) => [
      item.id,
      sanitizeLayout(
        item.layout,
        innerWidth,
        item.minW ?? DEFAULT_MIN_W,
        item.minH ?? DEFAULT_MIN_H
      )
    ])
  );

  return committedLayoutsOverlap(sanitizedLayouts, innerWidth)
    ? normalizeLayouts(items, innerWidth)
    : sanitizedLayouts;
}

// Settle a committed (drag/resize/swap) layout set through the same gravity
// pass so the released state matches what props re-normalize into, keeping the
// live preview and persisted layout in lockstep (no snap-then-settle flicker).
export function compactCommittedLayouts(
  committed: Record<string, LayoutBox>,
  items: GeometryItem[],
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

export function rectsOverlap(a: PixelRect, b: PixelRect, gap = BOARD_GAP) {
  const g = gap - OVERLAP_EPSILON;
  return (
    a.left < b.left + b.width + g &&
    a.left + a.width + g > b.left &&
    a.top < b.top + b.height + g &&
    a.top + a.height + g > b.top
  );
}

export function horizontalOverlap(a: PixelRect, b: PixelRect, gap = BOARD_GAP) {
  const g = gap - OVERLAP_EPSILON;
  return a.left < b.left + b.width + g && a.left + a.width + g > b.left;
}

// A committed drag/resize only needs the gravity compaction pass when its
// layouts actually collide. When nothing overlaps, the live preview is already
// a valid resting state, so committing it verbatim keeps the pane exactly where
// it was dropped (no re-pack, no glide). Uses the same gap-aware predicate the
// gravity pass is built on, so skipping it can never leave an overlap behind.
export function committedLayoutsOverlap(
  layouts: Record<string, LayoutBox>,
  innerWidth: number
) {
  const rects = Object.values(layouts).map((layout) =>
    layoutToRect(layout, innerWidth)
  );

  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (rectsOverlap(rects[i], rects[j])) {
        return true;
      }
    }
  }

  return false;
}

export function rectArea(rect: PixelRect) {
  return rect.width * rect.height;
}

export function rectIntersectionArea(a: PixelRect, b: PixelRect) {
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.top + a.height, b.top + b.height);

  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

export function rectCenter(rect: PixelRect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

export function pointInRect(point: { x: number; y: number }, rect: PixelRect) {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}

export function rectRight(rect: PixelRect) {
  return rect.left + rect.width;
}

export function rectBottom(rect: PixelRect) {
  return rect.top + rect.height;
}

export function rangeOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return rangeOverlap(aStart, aEnd, bStart, bEnd) > 0;
}

export function findSwapTargetId(
  itemId: string,
  draggedLayout: LayoutBox,
  layoutsAtStart: Record<string, LayoutBox>,
  innerWidth: number
) {
  const draggedRect = layoutToRect(draggedLayout, innerWidth);
  const draggedCenter = rectCenter(draggedRect);
  const draggedArea = rectArea(draggedRect);
  let bestId: string | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const [id, layout] of Object.entries(layoutsAtStart)) {
    if (id === itemId) {
      continue;
    }

    const targetRect = layoutToRect(layout, innerWidth);
    const targetCenter = rectCenter(targetRect);
    const overlapRatio =
      rectIntersectionArea(draggedRect, targetRect) /
      Math.max(1, Math.min(draggedArea, rectArea(targetRect)));
    const centerInside = pointInRect(draggedCenter, targetRect);

    if (!centerInside && overlapRatio < SWAP_OVERLAP_RATIO) {
      continue;
    }

    const centerDistance =
      (draggedCenter.x - targetCenter.x) ** 2 +
      (draggedCenter.y - targetCenter.y) ** 2;
    const score =
      (centerInside ? 1000 : 0) + overlapRatio * 100 - centerDistance / 10000;

    if (bestId === undefined || score > bestScore) {
      bestId = id;
      bestScore = score;
    }
  }

  return bestId;
}

export function isLayoutWithinBounds(
  candidate: LayoutBox,
  innerWidth: number,
  minW: number,
  minH: number
) {
  const rect = layoutToRect(candidate, innerWidth);
  return (
    rect.left >= -OVERLAP_EPSILON &&
    rect.top >= BOARD_PADDING - OVERLAP_EPSILON &&
    rect.width >= Math.min(minW, innerWidth) - OVERLAP_EPSILON &&
    rect.height >= minH - OVERLAP_EPSILON &&
    rect.left + rect.width <= innerWidth + OVERLAP_EPSILON
  );
}

export function rectDistanceScore(a: PixelRect, b: PixelRect) {
  const dx = a.left - b.left;
  const dy = a.top - b.top;
  return dx * dx + dy * dy;
}

export function dedupeNumberValues(values: number[]) {
  return Array.from(new Set(values.map((value) => Math.round(value * 1000) / 1000)));
}

export function itemSizing(
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

export function buildSwapPreviewLayouts(
  interaction: GeometryInteraction,
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

export function buildSwapCommitLayouts(
  interaction: GeometryInteraction,
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

// Adjacency is tested against the perpendicular span of the *resized* rect, not
// the start rect. A neighbor only joins the resize once the active edge pushes
// into its gap; dragging the edge away leaves the neighbor fixed so touching
// panes can be separated without moving a whole pane first.
export function isRightResizeNeighbor(
  startRect: PixelRect,
  activeRect: PixelRect,
  neighborRect: PixelRect
) {
  const startRight = rectRight(startRect);
  const activeRight = rectRight(activeRect);

  return (
    rangesOverlap(activeRect.top, rectBottom(activeRect), neighborRect.top, rectBottom(neighborRect)) &&
    neighborRect.left >= startRight - ADJACENT_RESIZE_TOLERANCE &&
    activeRight + BOARD_GAP > neighborRect.left
  );
}

export function isLeftResizeNeighbor(
  startRect: PixelRect,
  activeRect: PixelRect,
  neighborRect: PixelRect
) {
  const neighborRight = rectRight(neighborRect);

  return (
    rangesOverlap(activeRect.top, rectBottom(activeRect), neighborRect.top, rectBottom(neighborRect)) &&
    neighborRight <= startRect.left + ADJACENT_RESIZE_TOLERANCE &&
    activeRect.left < neighborRight + BOARD_GAP
  );
}

export function isBelowResizeNeighbor(
  startRect: PixelRect,
  activeRect: PixelRect,
  neighborRect: PixelRect
) {
  const startBottom = rectBottom(startRect);
  const activeBottom = rectBottom(activeRect);

  return (
    rangesOverlap(activeRect.left, rectRight(activeRect), neighborRect.left, rectRight(neighborRect)) &&
    neighborRect.top >= startBottom - ADJACENT_RESIZE_TOLERANCE &&
    activeBottom + BOARD_GAP > neighborRect.top
  );
}

export function isAboveResizeNeighbor(
  startRect: PixelRect,
  activeRect: PixelRect,
  neighborRect: PixelRect
) {
  const neighborBottom = rectBottom(neighborRect);

  return (
    rangesOverlap(activeRect.left, rectRight(activeRect), neighborRect.left, rectRight(neighborRect)) &&
    neighborBottom <= startRect.top + ADJACENT_RESIZE_TOLERANCE &&
    activeRect.top < neighborBottom + BOARD_GAP
  );
}

export function buildAdjacentResizeLayouts(
  interaction: GeometryInteraction,
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

  // Pushed neighbors keep their far edge anchored and shrink away from the
  // active pane, so they do not sweep across unrelated panes while absorbing
  // the resize.

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
      if (!isRightResizeNeighbor(startRect, activeRect, rect)) {
        return;
      }

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
      if (!isLeftResizeNeighbor(startRect, activeRect, rect)) {
        return;
      }

      const nextRight = activeRect.left - BOARD_GAP;
      const current = neighborRects.get(id);

      if (!current) {
        return;
      }

      current.width = nextRight - rect.left;
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
      if (!isBelowResizeNeighbor(startRect, activeRect, rect)) {
        return;
      }

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
      if (!isAboveResizeNeighbor(startRect, activeRect, rect)) {
        return;
      }

      const nextBottom = activeRect.top - BOARD_GAP;
      const current = neighborRects.get(id);

      if (!current) {
        return;
      }

      current.height = nextBottom - rect.top;
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

export function buildMoveDropRect(
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

export function expandedRangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
) {
  return rangesOverlap(aStart - BOARD_GAP, aEnd + BOARD_GAP, bStart, bEnd);
}

export function availableWidthForHeight(
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

export function availableHeightForWidth(
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

export function fitDropRectAtAnchor(
  anchor: { left: number; top: number },
  desiredRect: PixelRect,
  fixedRects: PixelRect[],
  innerWidth: number,
  visibleBottom: number,
  minWidth: number,
  minHeight: number
) {
  const candidates = emptyBoardRegions(fixedRects, innerWidth, {top: anchor.top, bottom: visibleBottom}, minWidth, minHeight)
    .filter(region => region.left <= anchor.left && rectRight(region) >= anchor.left + minWidth && region.top <= anchor.top)
    .map(region => ({left:anchor.left,top:anchor.top,
      width:Math.min(desiredRect.width,rectRight(region)-anchor.left),
      height:Math.min(desiredRect.height,rectBottom(region)-anchor.top)}))
    .filter(rect => rect.width >= minWidth && rect.height >= minHeight && !fixedRects.some(fixed => rectsOverlap(rect,fixed)))
    .sort((a,b) => rectArea(b)-rectArea(a));
  return candidates[0] ?? null;
}

export function findFittedDropRect(
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

export function resolveDropLayout(
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

export function layoutsEqual(
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

export function changedLayoutEntries(
  before: Record<string, LayoutBox>,
  after: Record<string, LayoutBox>
): Record<string, LayoutBox> {
  return Object.fromEntries(
    Object.entries(after).filter(([id, layout]) => {
      const previous = before[id];

      return (
        !previous ||
        previous.x !== layout.x ||
        previous.y !== layout.y ||
        previous.w !== layout.w ||
        previous.h !== layout.h ||
        previous.unit !== layout.unit
      );
    })
  );
}

export function buildMoveLayout(
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

export function buildResizeLayout(
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


export interface BoardViewport { top: number; bottom: number }
export interface BoardGeometryMetrics { innerWidth: number; viewportTop: number; viewportBottom: number }
export interface SnapState { x?: number; y?: number }

// Enumerate empty rectangles rather than committing to a width-first fit. A
// horizontal span is bounded by board/obstacle edges; its vertical gaps are
// then exact. Contained regions are harmless and allow precise local ranking.
export function emptyBoardRegions(fixed: PixelRect[], innerWidth: number, viewport: BoardViewport, minW: number, minH: number): PixelRect[] {
  const xs = dedupeNumberValues([0, innerWidth, ...fixed.flatMap(r => [clamp(r.left - BOARD_GAP, 0, innerWidth), clamp(rectRight(r) + BOARD_GAP, 0, innerWidth)])]).sort((a,b) => a-b);
  const regions: PixelRect[] = [];
  const floor = Math.max(BOARD_PADDING, viewport.top);
  for (let i=0;i<xs.length;i++) for(let j=i+1;j<xs.length;j++) {
    const left=xs[i], width=xs[j]-left;
    if(width + OVERLAP_EPSILON < minW) continue;
    const blockers=fixed.filter(r => horizontalOverlap({left,top:floor,width,height:1},r)).sort((a,b)=>a.top-b.top);
    let top=floor;
    for(const r of blockers) {
      if(rectBottom(r)+BOARD_GAP <= top) continue;
      const bottom=Math.min(viewport.bottom,r.top-BOARD_GAP);
      if(bottom-top + OVERLAP_EPSILON >= minH) regions.push({left,top,width,height:bottom-top});
      top=Math.max(top,rectBottom(r)+BOARD_GAP);
      if(top>=viewport.bottom) break;
    }
    if(viewport.bottom-top + OVERLAP_EPSILON >= minH) regions.push({left,top,width,height:viewport.bottom-top});
  }
  return regions;
}

export function snapCoordinate(value: number, targets: number[], previous?: number): number {
  if(previous !== undefined && Math.abs(value-previous)<=18) return previous;
  const nearest=targets.filter(t=>Math.abs(t-value)<=12).sort((a,b)=>Math.abs(a-value)-Math.abs(b-value))[0];
  return nearest ?? value;
}

export function fitInEmptyRegion(desired: PixelRect, regions: PixelRect[], minW: number, minH: number, snap: SnapState = {}): PixelRect | null {
  const candidates=regions.map(region => {
    const width=Math.min(region.width,Math.max(minW,560,desired.width));
    const height=Math.min(region.height,Math.max(minH,320,desired.height));
    const rawLeft=clamp(desired.left,region.left,rectRight(region)-width);
    const rawTop=clamp(desired.top,region.top,rectBottom(region)-height);
    return {left:clamp(snapCoordinate(rawLeft,[region.left,rectRight(region)-width],snap.x),region.left,rectRight(region)-width),top:clamp(snapCoordinate(rawTop,[region.top,rectBottom(region)-height],snap.y),region.top,rectBottom(region)-height),width,height};
  });
  candidates.sort((a,b)=>rectDistanceScore(a,desired)-rectDistanceScore(b,desired) || rectArea(b)-rectArea(a));
  return candidates[0] ?? null;
}

export function resolveMoveLayouts(interaction: GeometryInteraction, desired: PixelRect, innerWidth: number, viewport: BoardViewport, options: Map<string,{minW:number;minH:number}>, explicitSwap=false, snap: SnapState={}): Record<string,LayoutBox> | null {
  const size=itemSizing(options,interaction.itemId);
  if(explicitSwap) {
    const target=findSwapTargetId(interaction.itemId,rectToLayout(desired,innerWidth),interaction.layoutsAtStart,innerWidth);
    if(target) {
      const result=buildSwapCommitLayouts(interaction,target,innerWidth,options);
      if(result && !committedLayoutsOverlap(result,innerWidth)) return result;
      return null;
    }
  }
  const fixed=Object.entries(interaction.layoutsAtStart).filter(([id])=>id!==interaction.itemId).map(([,layout])=>layoutToRect(layout,innerWidth));
  const fitted=fitInEmptyRegion(desired,emptyBoardRegions(fixed,innerWidth,viewport,Math.min(size.minW,innerWidth),size.minH),Math.min(size.minW,innerWidth),size.minH,snap);
  return fitted ? {...interaction.layoutsAtStart,[interaction.itemId]:rectToLayout(fitted,innerWidth)} : null;
}

export function findAvailablePlacement(items: GeometryItem[], innerWidth: number, viewport: BoardViewport, desiredSize?: {width:number;height:number;minW?:number;minH?:number}): LayoutBox {
  const minW=Math.min(desiredSize?.minW ?? DEFAULT_MIN_W,innerWidth), minH=desiredSize?.minH ?? DEFAULT_MIN_H;
  const width=Math.min(innerWidth,Math.max(minW,desiredSize?.width ?? Math.min(560,(innerWidth-BOARD_GAP)/2)));
  const height=Math.max(minH,desiredSize?.height ?? 260);
  const fixed=items.map(item=>layoutToRect(sanitizeLayout(item.layout,innerWidth,item.minW,item.minH),innerWidth));
  const lowest=Math.max(BOARD_PADDING,...fixed.map(rectBottom));
  const bands=[viewport,{top:BOARD_PADDING,bottom:Math.max(lowest,viewport.bottom)},{top:lowest+BOARD_GAP,bottom:lowest+BOARD_GAP+height}];
  for(const band of bands) {
    const regions=emptyBoardRegions(fixed,innerWidth,band,minW,minH).sort((a,b)=>a.top-b.top || a.left-b.left || rectArea(b)-rectArea(a));
    if(regions.length) {
      const region=regions[0];
      return rectToLayout({left:region.left,top:region.top,width:Math.min(width,region.width),height:Math.min(height,region.height)},innerWidth);
    }
  }
  return rectToLayout({left:0,top:lowest+BOARD_GAP,width,height},innerWidth);
}

export function boardPointerDelta(client: {x:number;y:number}, startClient: {x:number;y:number}, startBoard: {left:number;top:number}, currentBoard: {left:number;top:number}) {
  return {dx:client.x-startClient.x+startBoard.left-currentBoard.left,dy:client.y-startClient.y+startBoard.top-currentBoard.top};
}

export function boardInnerWidth(clientWidth: number, items: Pick<GeometryItem, "minW">[]): number {
  return Math.max(1, clientWidth - BOARD_PADDING * 2, ...items.map(item => item.minW ?? DEFAULT_MIN_W));
}
