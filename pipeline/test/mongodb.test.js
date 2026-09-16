import assert from "node:assert/strict";
import test from "node:test";

import {
  isDuplicateKeyError,
  mongodbDatabaseName,
} from "../dist/providers/index.js";

test("mongodbDatabaseName reads the URI path", () => {
  assert.equal(
    mongodbDatabaseName("mongodb://127.0.0.1:27017/pipeline_local"),
    "pipeline_local",
  );
  assert.equal(
    mongodbDatabaseName("mongodb://pipeline-mongo:27017/pipeline"),
    "pipeline",
  );
});

test("mongodbDatabaseName rejects a URI without a database", () => {
  assert.throws(
    () => mongodbDatabaseName("mongodb://127.0.0.1:27017"),
    /database name/,
  );
});

test("isDuplicateKeyError detects code 11000", () => {
  assert.equal(isDuplicateKeyError({ code: 11000 }), true);
  assert.equal(isDuplicateKeyError({ code: 1 }), false);
  assert.equal(isDuplicateKeyError("nope"), false);
});
