export const DOCK_HEIGHT_KEY = "vibeTerminal.workspaceDockHeight.v1";
export const DOCK_COLLAPSED_KEY = "vibeTerminal.workspaceDockCollapsed.v1";
export type DockBounds = { min: number; max: number };

/** Heights include content padding, but exclude the tab bar and resize grip. */
export function dockBounds(availableHeight: number, chromeHeight = 52): DockBounds {
    const available = Math.max(0, Number.isFinite(availableHeight) ? availableHeight : 0);
    const boardReserve = Math.min(240, available * 0.35);
    const max = Math.max(0, Math.floor(available - chromeHeight - boardReserve));
    return { min: 0, max };
}

export function clampDockHeight(height: number, bounds: DockBounds): number {
    return Math.round(Math.max(bounds.min, Math.min(bounds.max, Number.isFinite(height) ? height : 280)));
}

export function defaultDockHeight(viewportHeight: number): number {
    return Math.max(220, Math.min(360, Math.round(viewportHeight * 0.3)));
}

export function parseDockHeight(raw: string | null): number | null {
    if (!raw?.trim()) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 10000 ? Math.round(value) : null;
}

export function draggedDockHeight(startHeight: number, startY: number, currentY: number, bounds: DockBounds): number {
    return clampDockHeight(startHeight + startY - currentY, bounds);
}

export function keyboardDockHeight(key: string, height: number, bounds: DockBounds, shift = false): number | null {
    if (key === "Home") return bounds.min;
    if (key === "End") return bounds.max;
    const step = shift ? 64 : 16;
    if (key === "ArrowUp") return clampDockHeight(height + step, bounds);
    if (key === "ArrowDown") return clampDockHeight(height - step, bounds);
    return null;
}
