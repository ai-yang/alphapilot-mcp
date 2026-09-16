import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Credentials } from "../dist/auth.js";

test(
  "credentials reject a directory with shared permissions before reading or writing",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "amcp-permissions-"));
    const auth = new Credentials(directory);
    process.env.MCP_AUTH_DIRECTORY_TEST = "backend-test";
    try {
      const created = await auth.create("test", "MCP_AUTH_DIRECTORY_TEST");
      const header = `Bearer ${created.token}`;
      assert.equal((await auth.authenticate(header)).clientId, "test");
      await chmod(directory, 0o770);
      await assert.rejects(auth.authenticate(header), /permissions/);
      await assert.rejects(
        auth.create("unsafe", "MCP_AUTH_DIRECTORY_TEST"),
        /permissions/,
      );
      await assert.rejects(auth.list(), /permissions/);
      assert.equal((await readdir(directory)).length, 1);
      await chmod(directory, 0o700);
      assert.equal((await auth.authenticate(header)).clientId, "test");
    } finally {
      delete process.env.MCP_AUTH_DIRECTORY_TEST;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "credentials reject a symlink directory and list an absent directory as empty",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "amcp-symlink-"));
    const actual = join(root, "actual");
    try {
      const auth = new Credentials(actual);
      assert.deepEqual(await auth.list(), []);
      await auth.create("test", "MCP_AUTH_DIRECTORY_TEST");
      const link = join(root, "link");
      await symlink(actual, link);
      await assert.rejects(new Credentials(link).list(), /real directory/);
      await assert.rejects(
        new Credentials(link).create("test", "MCP_AUTH_DIRECTORY_TEST"),
        /real directory/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
