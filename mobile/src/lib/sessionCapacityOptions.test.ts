import {
  clampSessionDuration,
  clampSessionMaxParticipants,
  isValidSessionDuration,
  isValidSessionMaxParticipants,
  normalizeSessionDurationString,
  normalizeSessionMaxString,
  SESSION_DEFAULT_DURATION,
  SESSION_DEFAULT_MAX_PARTICIPANTS,
  SESSION_DURATION_MAX,
  SESSION_DURATION_MIN,
  SESSION_MAX_PARTICIPANTS_MAX,
  SESSION_MAX_PARTICIPANTS_MIN,
} from "./sessionCapacityOptions";

describe("clampSessionDuration", () => {
  it("passes through values already in range", () => {
    expect(clampSessionDuration(60)).toBe(60);
  });

  it("clamps below the minimum", () => {
    expect(clampSessionDuration(0)).toBe(SESSION_DURATION_MIN);
    expect(clampSessionDuration(-10)).toBe(SESSION_DURATION_MIN);
  });

  it("clamps above the maximum", () => {
    expect(clampSessionDuration(999)).toBe(SESSION_DURATION_MAX);
  });

  it("rounds fractional values", () => {
    expect(clampSessionDuration(60.6)).toBe(61);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampSessionDuration(NaN)).toBe(SESSION_DEFAULT_DURATION);
    expect(clampSessionDuration(Infinity)).toBe(SESSION_DEFAULT_DURATION);
  });
});

describe("clampSessionMaxParticipants", () => {
  it("passes through values already in range", () => {
    expect(clampSessionMaxParticipants(4)).toBe(4);
  });

  it("clamps below the minimum", () => {
    expect(clampSessionMaxParticipants(0)).toBe(SESSION_MAX_PARTICIPANTS_MIN);
  });

  it("clamps above the maximum", () => {
    expect(clampSessionMaxParticipants(50)).toBe(SESSION_MAX_PARTICIPANTS_MAX);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampSessionMaxParticipants(NaN)).toBe(SESSION_DEFAULT_MAX_PARTICIPANTS);
  });
});

describe("normalizeSessionDurationString / normalizeSessionMaxString", () => {
  it("parses and clamps a numeric string", () => {
    expect(normalizeSessionDurationString("999")).toBe(String(SESSION_DURATION_MAX));
    expect(normalizeSessionMaxString("0")).toBe(String(SESSION_MAX_PARTICIPANTS_MIN));
  });

  it("falls back to the default for garbage input", () => {
    expect(normalizeSessionDurationString("abc")).toBe(String(SESSION_DEFAULT_DURATION));
    expect(normalizeSessionMaxString("")).toBe(String(SESSION_DEFAULT_MAX_PARTICIPANTS));
  });
});

describe("isValidSessionDuration / isValidSessionMaxParticipants", () => {
  it("accepts in-range values", () => {
    expect(isValidSessionDuration(SESSION_DURATION_MIN)).toBe(true);
    expect(isValidSessionDuration(SESSION_DURATION_MAX)).toBe(true);
    expect(isValidSessionMaxParticipants(SESSION_MAX_PARTICIPANTS_MIN)).toBe(true);
    expect(isValidSessionMaxParticipants(SESSION_MAX_PARTICIPANTS_MAX)).toBe(true);
  });

  it("rejects out-of-range or non-finite values", () => {
    expect(isValidSessionDuration(SESSION_DURATION_MIN - 1)).toBe(false);
    expect(isValidSessionDuration(SESSION_DURATION_MAX + 1)).toBe(false);
    expect(isValidSessionDuration(NaN)).toBe(false);
    expect(isValidSessionMaxParticipants(SESSION_MAX_PARTICIPANTS_MIN - 1)).toBe(false);
    expect(isValidSessionMaxParticipants(SESSION_MAX_PARTICIPANTS_MAX + 1)).toBe(false);
  });
});
