import { observable } from "mobx";
import type { ObservableMap } from "mobx";
import type { ModelName, ModelRecord, ModelRecords } from "../../shared/domain";
import { MODEL_NAMES } from "../../shared/domain";
import type { ModelInstance, ModelInstances, ModelLookup } from "./models";
import { modelFactories } from "./models";

type Collections = { [M in ModelName]: ObservableMap<string, ModelInstances[M]> };

/**
 * Identity map of live model instances. A record that changes is assigned into the
 * existing instance rather than replaced, so components observing it keep working and
 * only re-render for the fields that actually changed.
 */
export class ObjectPool implements ModelLookup {
    private readonly collections: Collections = {
        Team: observable.map({}, { deep: false }),
        User: observable.map({}, { deep: false }),
        Issue: observable.map({}, { deep: false }),
    };

    get<M extends ModelName>(model: M, id: string): ModelInstances[M] | undefined {
        return this.collections[model].get(id);
    }

    all<M extends ModelName>(model: M): ObservableMap<string, ModelInstances[M]> {
        return this.collections[model];
    }

    /** Makes the pool hold exactly `record` for this id, or nothing if it is undefined. Call inside an action. */
    reconcile(model: ModelName, id: string, record: ModelRecord | undefined): void {
        if (!record) {
            this.collections[model].delete(id);
            return;
        }
        this.put(record);
    }

    /** Removes every instance whose key is not in `keep`. Call inside an action. */
    retain(keep: (model: ModelName, id: string) => boolean): void {
        for (const model of MODEL_NAMES) {
            const collection = this.collections[model];
            for (const id of [...collection.keys()]) if (!keep(model, id)) collection.delete(id);
        }
    }

    private put<M extends ModelName>(record: { model: M; data: ModelRecords[M] }): void {
        const collection = this.collections[record.model];
        const existing = collection.get(record.data.id) as ModelInstance<ModelRecords[M]> | undefined;
        if (existing) existing.assign(record.data);
        else collection.set(record.data.id, modelFactories[record.model](record.data, this));
    }
}
