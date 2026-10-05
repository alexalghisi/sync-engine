export interface VirtualRange {
    /** First rendered index, inclusive. */
    start: number;
    /** Last rendered index, exclusive. */
    end: number;
}

/** Which rows of a fixed-height list intersect the viewport, plus `overscan` rows either side. */
export function virtualRange(scrollTop: number, viewportHeight: number, rowHeight: number, count: number, overscan: number): VirtualRange {
    if (count === 0 || rowHeight <= 0) return { start: 0, end: 0 };
    const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
    const visible = Math.ceil(viewportHeight / rowHeight) + 1;
    const start = Math.max(0, Math.min(first, count - 1) - overscan);
    const end = Math.min(count, first + visible + overscan);
    return { start, end };
}

/** The scrollTop that brings `index` fully into view, or null if it already is. */
export function scrollIntoView(index: number, scrollTop: number, viewportHeight: number, rowHeight: number): number | null {
    const top = index * rowHeight;
    const bottom = top + rowHeight;
    if (top < scrollTop) return top;
    if (bottom > scrollTop + viewportHeight) return bottom - viewportHeight;
    return null;
}
