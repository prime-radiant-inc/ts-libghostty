// Unit tests for the v2 modal-prediction module
// (`packages/blinkyterm/examples/bobbihack/modal-prediction.ts`).
//
// Phase 3 of the NetHack-aware autopilot v2 — see spec
// `docs/superpowers/specs/2026-05-09-nethack-aware-autopilot.md`,
// §"Layer 3: predict-and-avoid for tile-induced modals".

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PARANOID_CONFIG,
  willStepFireModal,
  type ParanoidConfig,
} from "../../examples/bobbihack/modal-prediction";
import type { ClassifiedCell } from "../../examples/bobbihack/cell-classifier";

function monster(opts: {
  letter: string;
  klass: ClassifiedCell["foreground"] extends infer F
    ? F extends { kind: "monster"; class: infer K }
      ? K
      : never
    : never;
  pet?: boolean;
}): ClassifiedCell {
  return {
    terrain: "floor",
    foreground: {
      kind: "monster",
      letter: opts.letter,
      class: opts.klass,
      color: 7,
      pet: opts.pet ?? false,
      bold: false,
    },
  };
}

describe("DEFAULT_PARANOID_CONFIG", () => {
  test("matches NetHack 5.0 ship defaults", () => {
    expect(DEFAULT_PARANOID_CONFIG.paranoidTrap).toBe(true);
    expect(DEFAULT_PARANOID_CONFIG.paranoidSwim).toBe(true);
    expect(DEFAULT_PARANOID_CONFIG.paranoidAttack).toBe(false);
  });
});

describe("willStepFireModal — null inputs", () => {
  test("null cell returns null", () => {
    expect(willStepFireModal(null)).toBeNull();
  });

  test("undefined cell returns null", () => {
    expect(willStepFireModal(undefined)).toBeNull();
  });

  test("plain floor with no foreground returns null", () => {
    const cell: ClassifiedCell = { terrain: "floor", foreground: null };
    expect(willStepFireModal(cell)).toBeNull();
  });

  test("corridor with no foreground returns null", () => {
    const cell: ClassifiedCell = { terrain: "corridor", foreground: null };
    expect(willStepFireModal(cell)).toBeNull();
  });
});

describe("willStepFireModal — pet displacement", () => {
  test("pet dog returns step (silent displace)", () => {
    const p = willStepFireModal(monster({ letter: "d", klass: "dog", pet: true }));
    expect(p).not.toBeNull();
    expect(p?.kind).toBe("pet-displace");
    expect(p?.resolveWith).toBe("step");
  });

  test("pet feline returns step", () => {
    const p = willStepFireModal(
      monster({ letter: "f", klass: "feline", pet: true }),
    );
    expect(p?.resolveWith).toBe("step");
  });

  test("pet wins over danger class — tame dragon is safe to step through", () => {
    const p = willStepFireModal(
      monster({ letter: "D", klass: "dragon", pet: true }),
    );
    expect(p?.kind).toBe("pet-displace");
    expect(p?.resolveWith).toBe("step");
  });

  test("v2.5: diagonal swap into pet is refused (NE)", () => {
    const p = willStepFireModal(
      monster({ letter: "d", klass: "dog", pet: true }),
      undefined,
      { delta: { dx: 1, dy: -1 } },
    );
    expect(p?.kind).toBe("pet-displace-blocked");
    expect(p?.resolveWith).toBe("refuse");
  });

  test("v2.5: all four diagonals refused (y/u/b/n)", () => {
    for (const [dx, dy] of [
      [-1, -1], [1, -1], [-1, 1], [1, 1],
    ] as Array<[number, number]>) {
      const p = willStepFireModal(
        monster({ letter: "f", klass: "feline", pet: true }),
        undefined,
        { delta: { dx, dy } },
      );
      expect(p?.resolveWith).toBe("refuse");
    }
  });

  test("v2.5: cardinal swap into pet still returns step (h/j/k/l)", () => {
    for (const [dx, dy] of [
      [-1, 0], [1, 0], [0, -1], [0, 1],
    ] as Array<[number, number]>) {
      const p = willStepFireModal(
        monster({ letter: "d", klass: "dog", pet: true }),
        undefined,
        { delta: { dx, dy } },
      );
      expect(p?.kind).toBe("pet-displace");
      expect(p?.resolveWith).toBe("step");
    }
  });

  test("v2.5: pet without delta context defaults to step (backward compat)", () => {
    // No context = no diagonal info available = assume cardinal-safe.
    // Matches the v1 / pre-context call sites.
    const p = willStepFireModal(
      monster({ letter: "d", klass: "dog", pet: true }),
    );
    expect(p?.resolveWith).toBe("step");
  });
});

describe("willStepFireModal — hostile / peaceful refusal", () => {
  test("hostile dog is refuse (attack-or-peaceful)", () => {
    const p = willStepFireModal(monster({ letter: "d", klass: "dog" }));
    expect(p?.kind).toBe("attack-or-peaceful");
    expect(p?.resolveWith).toBe("refuse");
  });

  test("hostile dragon is refuse", () => {
    const p = willStepFireModal(monster({ letter: "D", klass: "dragon" }));
    expect(p?.resolveWith).toBe("refuse");
  });

  test("non-pet @ (peaceful or shopkeeper) is refuse", () => {
    const p = willStepFireModal(monster({ letter: "@", klass: "human" }));
    expect(p?.resolveWith).toBe("refuse");
  });
});

describe("willStepFireModal — unseen-monster marker", () => {
  test("'I' marker is refuse", () => {
    const cell: ClassifiedCell = {
      terrain: "floor",
      foreground: { kind: "unseen-monster" },
    };
    const p = willStepFireModal(cell);
    expect(p?.kind).toBe("attack-or-peaceful");
    expect(p?.resolveWith).toBe("refuse");
  });
});

describe("willStepFireModal — warning digits", () => {
  test("warning tier 1 is refuse", () => {
    const cell: ClassifiedCell = {
      terrain: "floor",
      foreground: { kind: "warning", tier: 1 },
    };
    expect(willStepFireModal(cell)?.resolveWith).toBe("refuse");
  });

  test("warning tier 5 is refuse", () => {
    const cell: ClassifiedCell = {
      terrain: "floor",
      foreground: { kind: "warning", tier: 5 },
    };
    expect(willStepFireModal(cell)?.resolveWith).toBe("refuse");
  });
});

describe("willStepFireModal — item pickup", () => {
  test("scroll item returns m-prefix", () => {
    const cell: ClassifiedCell = {
      terrain: "floor",
      foreground: { kind: "item", letter: "?", color: 7 },
    };
    const p = willStepFireModal(cell);
    expect(p?.kind).toBe("pickup-prompt");
    expect(p?.resolveWith).toBe("m-prefix");
  });

  test("potion item returns m-prefix", () => {
    const cell: ClassifiedCell = {
      terrain: "floor",
      foreground: { kind: "item", letter: "!", color: 7 },
    };
    expect(willStepFireModal(cell)?.resolveWith).toBe("m-prefix");
  });
});

describe("willStepFireModal — player foreground (defensive)", () => {
  test("player foreground returns null (should never be a step target)", () => {
    const cell: ClassifiedCell = {
      terrain: "floor",
      foreground: { kind: "player" },
    };
    expect(willStepFireModal(cell)).toBeNull();
  });
});

describe("willStepFireModal — autoopen-disabled (v2.5)", () => {
  test("closed door + Conf returns refuse", () => {
    const cell: ClassifiedCell = { terrain: "door_closed", foreground: null };
    const p = willStepFireModal(cell, undefined, { conditions: ["Conf"] });
    expect(p?.kind).toBe("autoopen-disabled");
    expect(p?.resolveWith).toBe("refuse");
  });

  test("closed door + Stun returns refuse", () => {
    const cell: ClassifiedCell = { terrain: "door_closed", foreground: null };
    const p = willStepFireModal(cell, undefined, { conditions: ["Stun"] });
    expect(p?.kind).toBe("autoopen-disabled");
    expect(p?.resolveWith).toBe("refuse");
  });

  test("closed door without Conf/Stun returns null (normal autoopen)", () => {
    const cell: ClassifiedCell = { terrain: "door_closed", foreground: null };
    expect(willStepFireModal(cell)).toBeNull();
    expect(willStepFireModal(cell, undefined, { conditions: [] })).toBeNull();
    expect(
      willStepFireModal(cell, undefined, { conditions: ["Hallu", "Blind"] }),
    ).toBeNull();
  });

  test("floor + Conf returns null (only door_closed triggers this rule)", () => {
    const cell: ClassifiedCell = { terrain: "floor", foreground: null };
    expect(willStepFireModal(cell, undefined, { conditions: ["Conf"] })).toBeNull();
  });
});

describe("willStepFireModal — paranoid-trap", () => {
  test("trap_known with default config is refuse", () => {
    const cell: ClassifiedCell = { terrain: "trap_known", foreground: null };
    const p = willStepFireModal(cell);
    expect(p?.kind).toBe("paranoid-trap");
    expect(p?.resolveWith).toBe("refuse");
  });

  test("trap_known with paranoidTrap disabled returns null", () => {
    const cell: ClassifiedCell = { terrain: "trap_known", foreground: null };
    const cfg: ParanoidConfig = {
      paranoidTrap: false,
      paranoidSwim: true,
      paranoidAttack: false,
    };
    expect(willStepFireModal(cell, cfg)).toBeNull();
  });
});

describe("willStepFireModal — paranoid-swim", () => {
  test("water with default config is refuse", () => {
    const cell: ClassifiedCell = { terrain: "water", foreground: null };
    const p = willStepFireModal(cell);
    expect(p?.kind).toBe("paranoid-swim");
    expect(p?.resolveWith).toBe("refuse");
  });

  test("lava with default config is refuse", () => {
    const cell: ClassifiedCell = { terrain: "lava", foreground: null };
    const p = willStepFireModal(cell);
    expect(p?.kind).toBe("paranoid-swim");
    expect(p?.resolveWith).toBe("refuse");
  });

  test("water with paranoidSwim disabled returns null", () => {
    const cell: ClassifiedCell = { terrain: "water", foreground: null };
    const cfg: ParanoidConfig = {
      paranoidTrap: true,
      paranoidSwim: false,
      paranoidAttack: false,
    };
    expect(willStepFireModal(cell, cfg)).toBeNull();
  });
});

describe("willStepFireModal — precedence: foreground beats terrain", () => {
  test("hostile monster on a known trap returns the monster refusal first", () => {
    const cell: ClassifiedCell = {
      terrain: "trap_known",
      foreground: {
        kind: "monster",
        letter: "d",
        class: "dog",
        color: 7,
        pet: false,
        bold: false,
      },
    };
    const p = willStepFireModal(cell);
    expect(p?.kind).toBe("attack-or-peaceful");
    expect(p?.resolveWith).toBe("refuse");
  });

  test("pet on a known trap returns step (pet displacement)", () => {
    const cell: ClassifiedCell = {
      terrain: "trap_known",
      foreground: {
        kind: "monster",
        letter: "d",
        class: "dog",
        color: 7,
        pet: true,
        bold: false,
      },
    };
    expect(willStepFireModal(cell)?.resolveWith).toBe("step");
  });

  test("item on water returns m-prefix (item before swim)", () => {
    const cell: ClassifiedCell = {
      terrain: "water",
      foreground: { kind: "item", letter: "?", color: 7 },
    };
    expect(willStepFireModal(cell)?.resolveWith).toBe("m-prefix");
  });
});
