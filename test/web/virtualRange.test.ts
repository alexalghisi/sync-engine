import { describe, expect, it } from "vitest";
import { scrollIntoView, virtualRange } from "../../src/web/ui/virtualRange";

describe("virtualRange", () => {
    it("renders the viewport plus overscan at the top", () => {
        expect(virtualRange(0, 360, 36, 10_000, 5)).toEqual({ start: 0, end: 16 });
    });

    it("keeps the rendered window the same size anywhere in a long list", () => {
        const middle = virtualRange(36 * 5_000 + 10, 360, 36, 10_000, 5);
        expect(middle).toEqual({ start: 4_995, end: 5_016 });
        expect(middle.end - middle.start).toBeLessThan(25);
    });

    it("clamps at the end and for overscrolled or empty lists", () => {
        expect(virtualRange(36 * 10_000, 360, 36, 10_000, 5)).toEqual({ start: 9_994, end: 10_000 });
        expect(virtualRange(-200, 360, 36, 3, 5)).toEqual({ start: 0, end: 3 });
        expect(virtualRange(0, 360, 36, 0, 5)).toEqual({ start: 0, end: 0 });
    });
});

describe("scrollIntoView", () => {
    it("scrolls only when the row is outside the viewport", () => {
        expect(scrollIntoView(5, 0, 360, 36)).toBeNull();
        expect(scrollIntoView(20, 0, 360, 36)).toBe(21 * 36 - 360);
        expect(scrollIntoView(2, 200, 360, 36)).toBe(72);
    });
});
