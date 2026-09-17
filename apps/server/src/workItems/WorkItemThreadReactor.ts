import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { WorkItemService } from "./WorkItemService.ts";

export const start = Effect.fn("WorkItemThreadReactor.start")(function* () {
  const engine = yield* OrchestrationEngineService;
  const work = yield* WorkItemService;
  // Subscribe before repairing old links so deletions during startup are also handled.
  const events = yield* engine.subscribeDomainEvents;
  yield* work.clearDeletedThreadLinks(undefined);
  yield* events.pipe(
    Stream.runForEach((event) =>
      event.type === "thread.deleted"
        ? work
            .clearDeletedThreadLinks(event.payload.threadId)
            .pipe(Effect.ignoreCause({ log: true }))
        : Effect.void,
    ),
    Effect.forkScoped,
  );
});
