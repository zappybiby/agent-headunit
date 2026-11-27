import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const daemonToken = /^[a-f0-9]{48}$/;
const tenantName = /^[a-zA-Z0-9._-]{1,128}$/;

export default async function headunitHttpAuth({ daemonRequest }) {
  const stateDir = process.env.AGENT_DEVICE_STATE_DIR;
  const tenant = (process.env.HEADUNIT_HTTP_TENANT ?? "headunit").trim();
  const token = daemonRequest?.token;
  if (!stateDir || !path.isAbsolute(stateDir) || !tenantName.test(tenant) ||
      typeof token !== "string" || !daemonToken.test(token)) {
    return false;
  }
  try {
    const active = JSON.parse(await readFile(path.join(stateDir, "daemon.json"), "utf8"));
    // The daemon registration supplies the token. The operator selects the tenant.
    if (active.pid !== process.pid || typeof active.token !== "string" || !daemonToken.test(active.token)) return false;
    if (!timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(active.token, "hex"))) return false;
    return { ok: true, tenantId: tenant };
  } catch {
    return false;
  }
}
