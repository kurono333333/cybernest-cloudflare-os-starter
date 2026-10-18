import { exports } from "cloudflare:workers";
import type { KnowledgeAccountAccess } from "../src/custom";
import { afterEach, expect, it } from "vitest";

type KnowledgeAccount = InstanceType<typeof KnowledgeAccountAccess>;
type SafeReservation = Parameters<KnowledgeAccount["reserveKnowledgeSafeControl"]>[1];
type BronzeReservation = Parameters<KnowledgeAccount["reserveBronzeAction"]>[1];
type SafeTarget = SafeReservation["target"];

const managerId = crypto.randomUUID();
const account = exports.KnowledgeAccountAccess.getByName(
  managerId,
) satisfies DurableObjectStub<KnowledgeAccountAccess>;
const cleanup: Array<() => Promise<void>> = [];

const reservation = (target: SafeTarget, localActionId: number): SafeReservation => {
  const common = {
    target,
    workspaceId: "gl04-shared-target-capacity",
    gatekeeperInstanceId: "gl04-native-test-gatekeeper",
    localActionId,
    operationId: crypto.randomUUID(),
    // Staged safe-control slots have no action deadline until an approval is accepted.
    operationDeadlineMs: 0,
    retainedBytesReserved: 512,
  };
  return target.kind === "gold_job"
    ? { ...common, expectedJobFence: 0, expectedControlRevision: 0 }
    : common;
};

afterEach(async () => {
  const failures: unknown[] = [];
  for (const remove of cleanup.splice(0)) {
    try {
      await remove();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "GL04 shared safe-control cleanup failed");
});

it("admits 64 article targets plus one Gold target beside an occupied Bronze proposal slot", async () => {
  const articles = Array.from({ length: 64 }, (_, index) =>
    reservation({ kind: "article", id: `gl04-article-${index}-${crypto.randomUUID()}` }, index),
  );
  const gold = reservation({ kind: "gold_job", id: crypto.randomUUID() }, 64);
  const ordinaryBronze: BronzeReservation = {
    workspaceId: "gl04-shared-target-capacity",
    gatekeeperInstanceId: "gl04-native-test-gatekeeper",
    localActionId: 100,
    operationId: crypto.randomUUID(),
    operationDeadlineMs: 0,
    retainedBytesReserved: 512,
  };
  const reserveAndTrackSafe = async (item: SafeReservation): Promise<void> => {
    await account.reserveKnowledgeSafeControl(managerId, item);
    cleanup.push(() => {
      const { retainedBytesReserved: _bytes, ...binding } = item;
      return account.clearKnowledgeSafeControl(managerId, binding);
    });
  };

  // The ordinary proposal lane is already occupied when the independent safe-control lane fills.
  await account.reserveBronzeAction(managerId, ordinaryBronze);
  cleanup.push(() => {
    const { retainedBytesReserved: _bytes, ...binding } = ordinaryBronze;
    return account.clearBronzeAction(managerId, binding);
  });

  await reserveAndTrackSafe(gold);

  // Retrying the exact target reservation is idempotent.
  await account.reserveKnowledgeSafeControl(managerId, gold);

  // A changed action on the same Gold target and a second Gold target cannot claim another slot.
  await expectCode(
    reserveAndTrackSafe({
      ...gold,
      localActionId: 101,
      operationId: crypto.randomUUID(),
    }),
    "capacity_exceeded",
  );
  await expectCode(
    reserveAndTrackSafe(reservation({ kind: "gold_job", id: crypto.randomUUID() }, 102)),
    "capacity_exceeded",
  );

  for (const item of articles) await reserveAndTrackSafe(item);

  // All 65 permitted targets coexist; a 66th target is rejected.
  await expectCode(
    reserveAndTrackSafe(
      reservation({ kind: "article", id: `gl04-article-66-${crypto.randomUUID()}` }, 103),
    ),
    "capacity_exceeded",
  );
});

async function expectCode(operation: Promise<void>, code: string): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (cause) {
    failure = cause;
  }
  expect(String(failure)).toContain(code);
}
