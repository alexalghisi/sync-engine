/** Runs async tasks one after another, in the order they were queued. */
export class SerialQueue {
    private tail: Promise<void> = Promise.resolve();

    constructor(private readonly onError: (error: unknown) => void) {}

    push(task: () => Promise<void>): Promise<void> {
        this.tail = this.tail.then(task).catch(this.onError);
        return this.tail;
    }

    /** Resolves once everything queued so far has finished. */
    idle(): Promise<void> {
        return this.tail;
    }
}
