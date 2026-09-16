import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  rename,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { failure } from "./client.js";
export type Credential = {
  id: string;
  client: string;
  hash: string;
  backendTokenEnv: string;
  created: string;
  expires: string | null;
  revoked: boolean;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class Credentials {
  constructor(readonly directory: string) {}
  private async checkDirectory() {
    const st = await lstat(this.directory);
    if (
      st.isSymbolicLink() ||
      !st.isDirectory() ||
      (process.platform !== "win32" && st.mode & 0o077)
    ) {
      throw failure(
        "UNAUTHENTICATED",
        "MCP credential directory must be a real directory with private permissions (0700)",
      );
    }
  }
  private async read(id: string): Promise<Credential> {
    if (!/^[a-f0-9]{32}$/.test(id))
      throw failure("UNAUTHENTICATED", "Invalid MCP credential");
    const path = join(this.directory, id + ".json");
    try {
      await this.checkDirectory();
      const st = await lstat(path);
      if (
        st.isSymbolicLink() ||
        (process.platform !== "win32" && st.mode & 0o077)
      )
        throw new Error();
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw failure(
        "UNAUTHENTICATED",
        "MCP credential is unavailable or file permissions are unsafe",
      );
    }
  }
  async create(client: string, backendTokenEnv: string, expires?: string) {
    if (
      !client ||
      client.length > 100 ||
      !/^[A-Z_][A-Z0-9_]*$/.test(backendTokenEnv)
    )
      throw failure(
        "INVALID_CONFIG",
        "Client name and uppercase backend token environment variable are required",
      );
    if (
      expires &&
      (!Number.isFinite(Date.parse(expires)) ||
        Date.parse(expires) <= Date.now())
    )
      throw failure("INVALID_CONFIG", "Expiration must be a future ISO date");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory();
    const id = randomUUID().replaceAll("-", "");
    const token = `amcp_${id}_${randomBytes(32).toString("base64url")}`;
    const record: Credential = {
      id,
      client,
      backendTokenEnv,
      hash: hash(token),
      created: new Date().toISOString(),
      expires: expires ?? null,
      revoked: false,
    };
    await writeFile(
      join(this.directory, id + ".json"),
      JSON.stringify(record),
      { mode: 0o600, flag: "wx" },
    );
    return {
      credential_id: id,
      token,
      client,
      backend_token_env: backendTokenEnv,
      expires: record.expires,
    };
  }
  async authenticate(header: string | undefined) {
    const match = /^Bearer (amcp_([a-f0-9]{32})_[A-Za-z0-9_-]+)$/.exec(
      header ?? "",
    );
    if (!match)
      throw failure("UNAUTHENTICATED", "MCP Bearer credential required");
    const row = await this.read(match[2]);
    if (
      !/^[a-f0-9]{64}$/.test(row.hash) ||
      !timingSafeEqual(
        Buffer.from(row.hash, "hex"),
        Buffer.from(hash(match[1]), "hex"),
      ) ||
      row.revoked ||
      (row.expires && Date.parse(row.expires) <= Date.now())
    )
      throw failure(
        "UNAUTHENTICATED",
        "MCP credential is invalid, revoked or expired",
      );
    const token = process.env[row.backendTokenEnv];
    if (!token)
      throw failure(
        "BACKEND_CREDENTIAL_UNAVAILABLE",
        "Mapped backend credential is not configured",
      );
    return { clientId: row.client, token };
  }
  async revoke(id: string) {
    const row = await this.read(id);
    row.revoked = true;
    const tmp = join(this.directory, `.${id}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(row), { mode: 0o600, flag: "wx" });
    await rename(tmp, join(this.directory, id + ".json"));
    return { credential_id: id, revoked: true };
  }
  async list() {
    let names: string[];
    try {
      await this.checkDirectory();
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result = [];
    for (const n of names.filter((n) => /^[a-f0-9]{32}\.json$/.test(n))) {
      const { hash: _, ...row } = await this.read(n.slice(0, -5));
      result.push(row);
    }
    return result;
  }
}
