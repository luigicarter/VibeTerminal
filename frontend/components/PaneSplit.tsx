import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import clsx from "clsx";
import type { SplitBranch, SplitNode } from "../types";
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  isSplitLeaf,
  subtreeMin,
  type SplitPath
} from "./splitTree";

// Divider thickness in px. Also the gap subtreeMin reserves between siblings,
// so a tile's advertised minimum matches what it actually needs on screen.
export const SPLIT_DIVIDER_PX = 6;
// Mirrors TiledBoard's own settle so a divider drag and a board drag release
// the shared "arranging" flag the same way.
const ARRANGE_SETTLE_MS = 180;

interface DividerDragState {
  pointerId: number;
  path: SplitPath;
  startCoord: number;
  startRatio: number;
  usablePx: number;
  minRatio: number;
  maxRatio: number;
  capturedElement: HTMLElement;
}

interface PaneSplitProps {
  node: SplitNode;
  renderPane: (sessionId: string) => ReactNode;
  onRatioChange: (path: SplitPath, ratio: number) => void;
  onArrangeChange?: (isArranging: boolean) => void;
  leafMinW: number;
  leafMinH: number;
}

// Renders a tile's interior partition as nested flexbox. `ratio` is used only
// as flex-grow, so a tile resized by a board drag, a window resize, maximize or
// a workspace switch reflows for free — there is no percentage geometry to
// recompute and therefore none to get wrong.
export default function PaneSplit({
  node,
  renderPane,
  onRatioChange,
  onArrangeChange,
  leafMinW,
  leafMinH
}: PaneSplitProps) {
  const dragRef = useRef<DividerDragState | null>(null);
  const settleTimerRef = useRef<number | null>(null);

  function beginArrange() {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    onArrangeChange?.(true);
  }

  function endArrange() {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
    }
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      onArrangeChange?.(false);
    }, ARRANGE_SETTLE_MS);
  }

  function handleDividerPointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
    branch: SplitBranch,
    path: SplitPath
  ) {
    if (event.button !== 0) {
      return;
    }

    const divider = event.currentTarget;
    const container = divider.parentElement;
    if (!container) {
      return;
    }

    const isRow = branch.dir === "row";
    const totalPx = isRow ? container.clientWidth : container.clientHeight;
    const usablePx = totalPx - SPLIT_DIVIDER_PX;
    if (usablePx <= 0) {
      return;
    }

    // Clamp against what each subtree actually needs, so a divider can never be
    // dragged into producing a pane too small for xterm to measure.
    const aMin = subtreeMin(branch.a, leafMinW, leafMinH, SPLIT_DIVIDER_PX);
    const bMin = subtreeMin(branch.b, leafMinW, leafMinH, SPLIT_DIVIDER_PX);
    const aMinPx = isRow ? aMin.minW : aMin.minH;
    const bMinPx = isRow ? bMin.minW : bMin.minH;
    if (aMinPx + bMinPx > usablePx) {
      // The tile is already smaller than its parts; dragging would only pick
      // which pane gets clipped. Leave the ratio alone.
      return;
    }

    // Stop the press from starting a board drag or a text selection.
    event.preventDefault();
    event.stopPropagation();

    dragRef.current = {
      pointerId: event.pointerId,
      path,
      startCoord: isRow ? event.clientX : event.clientY,
      startRatio: branch.ratio,
      usablePx,
      minRatio: Math.max(MIN_SPLIT_RATIO, aMinPx / usablePx),
      maxRatio: Math.min(MAX_SPLIT_RATIO, 1 - bMinPx / usablePx),
      capturedElement: divider
    };
    divider.setPointerCapture(event.pointerId);
    beginArrange();
  }

  function handleDividerPointerMove(
    event: ReactPointerEvent<HTMLDivElement>,
    branch: SplitBranch
  ) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const coord = branch.dir === "row" ? event.clientX : event.clientY;
    const next = drag.startRatio + (coord - drag.startCoord) / drag.usablePx;
    onRatioChange(
      drag.path,
      Math.min(drag.maxRatio, Math.max(drag.minRatio, next))
    );
  }

  function handleDividerPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    dragRef.current = null;
    if (drag.capturedElement.hasPointerCapture(event.pointerId)) {
      drag.capturedElement.releasePointerCapture(event.pointerId);
    }
    endArrange();
  }

  function renderNode(current: SplitNode, path: SplitPath): ReactNode {
    if (isSplitLeaf(current)) {
      return (
        <div className="pane-split-leaf" data-pane-id={current.id}>
          {renderPane(current.id)}
        </div>
      );
    }

    const isRow = current.dir === "row";

    return (
      <div
        className={clsx(
          "pane-split-branch",
          isRow ? "pane-split-row" : "pane-split-col"
        )}
      >
        <div
          className="pane-split-slot"
          style={{ flexGrow: current.ratio, flexShrink: 1, flexBasis: 0 }}
        >
          {renderNode(current.a, [...path, "a"])}
        </div>
        <div
          className="pane-split-divider"
          role="separator"
          aria-orientation={isRow ? "vertical" : "horizontal"}
          onPointerDown={(event) =>
            handleDividerPointerDown(event, current, path)
          }
          onPointerMove={(event) => handleDividerPointerMove(event, current)}
          onPointerUp={handleDividerPointerUp}
          onPointerCancel={handleDividerPointerUp}
        />
        <div
          className="pane-split-slot"
          style={{ flexGrow: 1 - current.ratio, flexShrink: 1, flexBasis: 0 }}
        >
          {renderNode(current.b, [...path, "b"])}
        </div>
      </div>
    );
  }

  return <div className="pane-split-root">{renderNode(node, [])}</div>;
}
