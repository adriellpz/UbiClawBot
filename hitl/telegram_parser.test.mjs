import assert from "node:assert/strict";
import test from "node:test";

import { parseDoneReply } from "./telegram_parser.mjs";

test("parseDoneReply returns session number for '1 done'", () => {
  assert.equal(parseDoneReply("1 done"), 1);
});

test("parseDoneReply returns session number for '2 done'", () => {
  assert.equal(parseDoneReply("2 done"), 2);
});

test("parseDoneReply returns session number for '10 done'", () => {
  assert.equal(parseDoneReply("10 done"), 10);
});

test("parseDoneReply is case-insensitive", () => {
  assert.equal(parseDoneReply("1 DONE"), 1);
  assert.equal(parseDoneReply("3 Done"), 3);
});

test("parseDoneReply returns null for 'done' with no number", () => {
  assert.equal(parseDoneReply("done"), null);
});

test("parseDoneReply returns null for '1done' with no space", () => {
  assert.equal(parseDoneReply("1done"), null);
});

test("parseDoneReply returns null for unrelated text", () => {
  assert.equal(parseDoneReply("hello world"), null);
});

test("parseDoneReply returns null for extra text after done", () => {
  assert.equal(parseDoneReply("1 done extra"), null);
});

test("parseDoneReply returns null for empty string", () => {
  assert.equal(parseDoneReply(""), null);
});
