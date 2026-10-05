import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { scrollIntoView, virtualRange } from "./virtualRange";

interface VirtualListProps<T> {
    items: readonly T[];
    rowHeight: number;
    overscan?: number;
    getKey: (item: T) => string;
    renderRow: (item: T, index: number) => ReactNode;
    /** Keeps this row in view whenever it changes, for keyboard navigation. */
    activeIndex?: number;
    ariaLabel: string;
    onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * Fixed-height windowing: only the rows that intersect the viewport (plus overscan) are
 * mounted, each absolutely positioned inside a spacer as tall as the whole list.
 */
export function VirtualList<T>({ items, rowHeight, overscan = 8, getKey, renderRow, activeIndex = -1, ariaLabel, onKeyDown }: VirtualListProps<T>) {
    const viewport = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [height, setHeight] = useState(0);

    useLayoutEffect(() => {
        const element = viewport.current;
        if (!element) return;
        setHeight(element.clientHeight);
        const observer = new ResizeObserver(() => setHeight(element.clientHeight));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const element = viewport.current;
        if (!element || activeIndex < 0) return;
        const target = scrollIntoView(activeIndex, element.scrollTop, element.clientHeight, rowHeight);
        if (target !== null) element.scrollTop = target;
    }, [activeIndex, rowHeight]);

    const { start, end } = virtualRange(scrollTop, height, rowHeight, items.length, overscan);
    const rows: ReactNode[] = [];
    for (let index = start; index < end; index++) {
        const item = items[index];
        if (item === undefined) continue;
        rows.push(
            <div key={getKey(item)} className="virtual-row" style={{ transform: `translateY(${index * rowHeight}px)`, height: rowHeight }}>
                {renderRow(item, index)}
            </div>,
        );
    }

    return (
        <div
            ref={viewport}
            className="virtual-viewport"
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
            <div className="virtual-spacer" style={{ height: items.length * rowHeight }}>
                {rows}
            </div>
        </div>
    );
}
